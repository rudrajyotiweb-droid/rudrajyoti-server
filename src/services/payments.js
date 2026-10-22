/**
 * Payment lifecycle shared by puja bookings, chadhava bookings and store orders.
 *
 *  startPayment()   → creates a Payment attempt + Paytm txnToken (or a mock / COD record)
 *  syncPayment()    → asks Paytm for the authoritative status and applies it
 *  applyResult()    → idempotent state transition; side effects run exactly once
 *  refundPayment()  → full/partial refunds with an atomic guard against over-refunding
 *
 * Every transition is a conditional findOneAndUpdate, so duplicate callbacks, page refreshes
 * and the reconciler job can all race safely.
 */
import { env } from "../config/env.js";
import { Booking, Chadhava, Coupon, CouponRedemption, InventoryLog, Order, Payment, Product, Puja } from "../models/index.js";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";
import { notifyBookingStatus, notifyOrderStatus } from "./notify.js";
import * as paytm from "./paytm.js";

const OPEN = ["Created", "Pending"];

export const provider = () => env.PAYMENT_PROVIDER;

const newOrderId = (code) => `${code}_${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

/** Creates a payment attempt for a Booking or Order and returns what the frontend needs to open checkout. */
export async function startPayment({ kind, refType, doc, user }) {
  const amount = doc.pricing.total;
  const payment = await Payment.create({
    orderId: newOrderId(doc.code),
    kind,
    refType,
    ref: doc._id,
    refCode: doc.code,
    user: user._id,
    customerName: user.name || doc.customerName,
    amount,
    provider: provider(),
    status: "Created",
  });
  await (refType === "Booking" ? Booking : Order).updateOne({ _id: doc._id }, { $set: { payment: payment._id } });

  if (provider() === "mock") {
    return { provider: "mock", orderId: payment.orderId, amount, refCode: doc.code };
  }

  try {
    const txnToken = await paytm.initiateTransaction({ orderId: payment.orderId, amount, custId: user._id, mobile: user.phone, email: user.email || undefined, firstName: user.name || undefined });
    await Payment.updateOne({ _id: payment._id }, { $set: { status: "Pending" } });
    return { provider: "paytm", orderId: payment.orderId, txnToken, amount, mid: env.PAYTM_MID, scriptUrl: paytm.checkoutScriptUrl(), refCode: doc.code };
  } catch (err) {
    await Payment.updateOne({ _id: payment._id }, { $set: { status: "Failed", resultMsg: err.message } });
    throw err;
  }
}

/** Records a COD "payment" (collected on delivery). */
export async function createCodPayment({ doc, user }) {
  const p = await Payment.create({
    orderId: newOrderId(doc.code),
    kind: "Store",
    refType: "Order",
    ref: doc._id,
    refCode: doc.code,
    user: user._id,
    customerName: user.name,
    amount: doc.pricing.total,
    provider: "cod",
    status: "Pending",
    method: "COD",
  });
  await Order.updateOne({ _id: doc._id }, { $set: { payment: p._id } });
  return p;
}

/** Fetches the status from the gateway and applies it. Safe to call any number of times. */
export async function syncPayment(orderId) {
  const payment = await Payment.findOne({ orderId });
  if (!payment) throw ApiError.notFound("Payment not found");
  if (!OPEN.includes(payment.status) || payment.provider !== "paytm") return payment;
  const result = await paytm.orderStatus(orderId);
  return applyResult(payment, result);
}

/** result: { status: "Captured"|"Failed"|"Pending", txnId, bankTxnId, amount, method, message, raw } */
export async function applyResult(payment, result) {
  let status = result.status;
  let message = result.message;

  if (status === "Captured" && result.amount != null && Math.abs(Number(result.amount) - payment.amount) > 0.01) {
    logger.error({ orderId: payment.orderId, expected: payment.amount, got: result.amount }, "Payment amount mismatch");
    status = "Failed";
    message = `Amount mismatch (paid ${result.amount}, expected ${payment.amount}) — needs manual review`;
  }

  const set = { txnId: result.txnId, bankTxnId: result.bankTxnId, method: result.method, resultMsg: message, gateway: result.raw };
  if (status === "Pending") {
    await Payment.updateOne({ _id: payment._id, status: { $in: OPEN } }, { $set: { ...set, status: "Pending" } });
    return Payment.findById(payment._id);
  }

  const updated = await Payment.findOneAndUpdate({ _id: payment._id, status: { $in: OPEN } }, { $set: { ...set, status, processedAt: new Date() } }, { new: true });
  if (!updated) return Payment.findById(payment._id); // already finalised by another request

  try {
    if (status === "Captured") await onCaptured(updated);
    else await onFailed(updated);
  } catch (err) {
    // the payment state is already saved; log loudly so ops can fix the linked record
    logger.error({ err, orderId: updated.orderId }, "Post-payment processing failed");
  }
  return updated;
}

async function redeemCoupon(code, userId, refCode, discount) {
  if (!code) return;
  const c = await Coupon.findOneAndUpdate({ code }, { $inc: { used: 1 } });
  if (c) await CouponRedemption.create({ coupon: c._id, user: userId, refCode, discount });
}

async function onCaptured(p) {
  const now = new Date();
  if (p.refType === "Booking") {
    const b = await Booking.findOneAndUpdate(
      { _id: p.ref, paymentStatus: { $ne: "Paid" } },
      { $set: { status: "Booked", paymentStatus: "Paid", paidAt: now, payment: p._id }, $push: { history: { status: "Booked", at: now, by: "System", note: `Paid via ${p.provider}` } } },
      { new: true },
    );
    if (!b) return;
    if (b.type === "puja" && b.puja) {
      await Puja.updateOne({ _id: b.puja }, { $inc: { bookingsCount: 1, revenue: b.pricing.total, devotees: Math.max(1, b.participants.length) } });
    } else if (b.chadhava) {
      await Chadhava.updateOne({ _id: b.chadhava }, { $inc: { bookingsCount: 1, revenue: b.pricing.total, devotees: 1 } });
      for (const it of b.items) await Chadhava.updateOne({ _id: b.chadhava, "items.key": it.key }, { $inc: { "items.$.sold": it.qty } });
    }
    await redeemCoupon(b.pricing.coupon, b.user, b.code, b.pricing.discount);
    await notifyBookingStatus(b);
    return;
  }

  const o = await Order.findOneAndUpdate(
    { _id: p.ref, paymentStatus: { $ne: "Paid" } },
    { $set: { status: "Placed", paymentStatus: "Paid", paidAt: now, payment: p._id }, $push: { history: { status: "Placed", at: now, by: "System", note: `Paid via ${p.provider}` } } },
    { new: true },
  );
  if (!o) return;
  if (!o.stockReserved) {
    // payment arrived after the reservation was released (late callback) — try again
    const ok = await reserveStock(o.items, o.code);
    await Order.updateOne({ _id: o._id }, ok ? { $set: { stockReserved: true } } : { $set: { adminNote: `${o.adminNote ? o.adminNote + "\n" : ""}Paid after stock was released and some items are now out of stock — please review or refund.` } });
  }
  for (const it of o.items) await Product.updateOne({ _id: it.product }, { $inc: { sold: it.qty } });
  await redeemCoupon(o.pricing.coupon, o.user, o.code, o.pricing.discount);
  await notifyOrderStatus(o);
}

async function onFailed(p) {
  const now = new Date();
  if (p.refType === "Booking") {
    await Booking.updateOne({ _id: p.ref, paymentStatus: "Pending", payment: p._id }, { $set: { status: "Payment Failed", paymentStatus: "Failed" }, $push: { history: { status: "Payment Failed", at: now, note: p.resultMsg } } });
    return;
  }
  const o = await Order.findOneAndUpdate(
    { _id: p.ref, paymentStatus: "Pending", payment: p._id },
    { $set: { status: "Payment Failed", paymentStatus: "Failed", stockReserved: false }, $push: { history: { status: "Payment Failed", at: now, note: p.resultMsg } } },
    { new: false }, // previous doc → tells us whether stock was reserved
  );
  if (o?.stockReserved) await releaseStock(o.items, o.code, "Payment failed");
}

/* ───────── Stock ───────── */

/** Atomically reserves stock for every line; rolls back on the first failure. Returns true/false. */
export async function reserveStock(items, ref) {
  const done = [];
  for (const it of items) {
    const r = await Product.findOneAndUpdate({ _id: it.product, status: "Active", stock: { $gte: it.qty } }, { $inc: { stock: -it.qty } }, { new: true });
    if (!r) {
      await releaseStock(done, ref, "Rollback");
      return false;
    }
    done.push(it);
    await InventoryLog.create({ product: it.product, delta: -it.qty, stockAfter: r.stock, reason: "Order reserved", ref }).catch(() => {});
  }
  return true;
}

export async function releaseStock(items, ref, reason = "Order released") {
  for (const it of items) {
    const r = await Product.findOneAndUpdate({ _id: it.product }, { $inc: { stock: it.qty } }, { new: true }).catch(() => null);
    if (r) await InventoryLog.create({ product: it.product, delta: it.qty, stockAfter: r.stock, reason, ref }).catch(() => {});
  }
}

/* ───────── Refunds ───────── */

/** Refund `amount` (default: the remaining balance). Returns the updated payment. */
export async function refundPayment(paymentId, { amount, reason = "", by = "Admin" } = {}) {
  const p = await Payment.findById(paymentId);
  if (!p) throw ApiError.notFound("Payment not found");
  if (!["Captured", "Partially refunded"].includes(p.status)) throw ApiError.badRequest(`A ${p.status.toLowerCase()} payment cannot be refunded`);
  const remaining = p.amount - (p.refundedAmount ?? 0);
  const amt = Math.round(amount ?? remaining);
  if (amt <= 0 || amt > remaining) throw ApiError.badRequest(`Refund amount must be between ₹1 and ₹${remaining}`);

  // reserve the refund amount atomically (prevents double refunds from double clicks)
  const reserved = await Payment.findOneAndUpdate({ _id: p._id, $expr: { $lte: [{ $add: ["$refundedAmount", amt] }, "$amount"] } }, { $inc: { refundedAmount: amt } }, { new: true });
  if (!reserved) throw ApiError.conflict("This payment has already been refunded");

  const refId = `RF_${p.orderId}_${reserved.refunds.length + 1}`.slice(0, 50);
  let result = { status: "Success", refundId: refId, message: "Refunded" };
  try {
    if (p.provider === "paytm") result = await paytm.refund({ orderId: p.orderId, txnId: p.txnId, refId, amount: amt });
    else if (p.provider === "cod") result = { status: "Success", refundId: refId, message: "Manual refund (COD)" };
    if (result.status === "Failed") throw new ApiError(502, result.message ? `Refund failed: ${result.message}` : "Refund failed at the payment gateway", { code: "REFUND_FAILED" });
  } catch (err) {
    await Payment.updateOne({ _id: p._id }, { $inc: { refundedAmount: -amt } });
    throw err;
  }

  const full = reserved.refundedAmount >= reserved.amount;
  const status = full ? "Refunded" : "Partially refunded";
  const updated = await Payment.findByIdAndUpdate(p._id, { $set: { status }, $push: { refunds: { refId, refundId: result.refundId, amount: amt, status: result.status, reason, by, message: result.message } } }, { new: true });
  await (p.refType === "Booking" ? Booking : Order).updateOne({ _id: p.ref }, { $set: { paymentStatus: status } });
  return updated;
}
