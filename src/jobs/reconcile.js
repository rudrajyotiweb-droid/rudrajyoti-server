/**
 * Background housekeeping (runs every few minutes inside the API process):
 *  - re-checks payments that never got a callback, and expires abandoned ones (releases stock)
 *  - closes pujas / chadhava whose booking cutoff has passed (BRD §13.1)
 *  - polls Paytm for pending refunds
 * Every step is isolated; a failure is logged and retried on the next run.
 */
import { env } from "../config/env.js";
import { dbReady } from "../config/db.js";
import { Chadhava, Payment, Puja } from "../models/index.js";
import { applyResult, syncPayment } from "../services/payments.js";
import { refundStatus } from "../services/paytm.js";
import { logger } from "../utils/logger.js";

const MIN = 60_000;
let timer = null;
let running = false;

async function reconcilePayments() {
  const stale = await Payment.find({ status: { $in: ["Created", "Pending"] }, provider: { $in: ["paytm", "mock"] }, createdAt: { $lte: new Date(Date.now() - 15 * MIN) } })
    .sort({ createdAt: 1 })
    .limit(100);
  for (const p of stale) {
    try {
      const ageMin = (Date.now() - p.createdAt) / MIN;
      if (p.provider === "paytm") {
        const updated = await syncPayment(p.orderId);
        // Paytm marks abandoned checkouts as failed eventually; give up after 3 hours
        if (["Created", "Pending"].includes(updated.status) && ageMin > 180) await applyResult(updated, { status: "Failed", message: "Payment not completed (expired)" });
      } else if (ageMin > 30) {
        await applyResult(p, { status: "Failed", message: "Payment not completed (expired)" });
      }
    } catch (err) {
      logger.warn({ err: err.message, orderId: p.orderId }, "Payment reconcile failed");
    }
  }
}

async function closeExpired() {
  const now = new Date();
  const a = await Puja.updateMany({ status: "Published", cutoff: { $lte: now } }, { $set: { status: "Closed" } });
  const b = await Chadhava.updateMany({ status: "Published", $or: [{ cutoff: { $lte: now } }, { cutoff: null, date: { $lte: now } }] }, { $set: { status: "Closed" } });
  if (a.modifiedCount || b.modifiedCount) logger.info({ pujas: a.modifiedCount, chadhava: b.modifiedCount }, "Closed bookings past cutoff");
}

async function pollRefunds() {
  if (env.PAYMENT_PROVIDER !== "paytm") return;
  const list = await Payment.find({ provider: "paytm", "refunds.status": "Pending" }).limit(50);
  for (const p of list) {
    for (const rf of p.refunds.filter((x) => x.status === "Pending")) {
      try {
        const s = await refundStatus({ orderId: p.orderId, refId: rf.refId });
        if (s.status !== "Pending") {
          await Payment.updateOne({ _id: p._id, "refunds.refId": rf.refId }, { $set: { "refunds.$.status": s.status, "refunds.$.message": s.message, "refunds.$.refundId": s.refundId ?? rf.refundId } });
          if (s.status === "Failed") {
            // give the money back to the refundable balance so the admin can retry
            await Payment.updateOne({ _id: p._id }, { $inc: { refundedAmount: -rf.amount }, $set: { status: p.refundedAmount - rf.amount > 0 ? "Partially refunded" : "Captured" } });
            logger.error({ orderId: p.orderId, refId: rf.refId }, "Refund failed at Paytm");
          }
        }
      } catch (err) {
        logger.warn({ err: err.message, refId: rf.refId }, "Refund status check failed");
      }
    }
  }
}

async function runOnce() {
  if (running || !dbReady()) return;
  running = true;
  try {
    for (const step of [closeExpired, reconcilePayments, pollRefunds]) {
      try {
        await step();
      } catch (err) {
        logger.error({ err: err.message, step: step.name }, "Background job step failed");
      }
    }
  } finally {
    running = false;
  }
}

export function startJobs() {
  if (timer) return;
  setTimeout(runOnce, 10_000).unref();
  timer = setInterval(runOnce, 5 * MIN);
  timer.unref();
}

export function stopJobs() {
  if (timer) clearInterval(timer);
  timer = null;
}
