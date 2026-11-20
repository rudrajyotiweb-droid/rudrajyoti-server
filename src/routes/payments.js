import express, { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { Booking, Order, Payment } from "../models/index.js";
import { requireUser } from "../middleware/auth.js";
import { paymentLimiter } from "../middleware/security.js";
import { validate } from "../middleware/validate.js";
import { applyResult, syncPayment } from "../services/payments.js";
import { verifyCallback } from "../services/payu.js";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";

const r = Router();

const zOrderId = z.string().trim().regex(/^[A-Za-z0-9_\-@.]{4,60}$/, "Invalid order id");

async function view(p) {
  const ref = p.refType === "Booking" ? await Booking.findById(p.ref, { code: 1, type: 1, status: 1, snapshot: 1 }).lean() : await Order.findById(p.ref, { code: 1, status: 1 }).lean();
  return {
    orderId: p.orderId,
    status: p.status === "Captured" ? "success" : p.status === "Failed" ? "failed" : ["Refunded", "Partially refunded"].includes(p.status) ? "refunded" : "pending",
    paymentStatus: p.status,
    kind: p.kind,
    refCode: p.refCode,
    refStatus: ref?.status,
    title: ref?.snapshot?.title,
    amount: p.amount,
    method: p.method,
    message: p.status === "Failed" ? p.resultMsg || "Payment failed" : undefined,
  };
}

/**
 * PayU posts the result here (surl / furl, form-encoded) and the browser follows our redirect.
 * We never trust the posted status: the reverse hash is checked for logging and verify_payment decides.
 */
r.post("/payu/callback", express.urlencoded({ extended: false, limit: "100kb" }), async (req, res) => {
  const orderId = String(req.body?.txnid ?? "");
  const back = (status) => res.redirect(303, `${env.CLIENT_URL.replace(/\/+$/, "")}/payment/status/?orderId=${encodeURIComponent(orderId)}${status ? `&s=${status}` : ""}`);
  try {
    if (!zOrderId.safeParse(orderId).success) return back("failed");
    if (!verifyCallback(req.body)) logger.warn({ orderId, status: req.body?.status }, "PayU callback hash mismatch — falling back to verify_payment API");
    const p = await syncPayment(orderId);
    return back((await view(p)).status);
  } catch (err) {
    logger.error({ err: err.message, orderId }, "PayU callback processing failed");
    return back("pending");
  }
});

r.use(requireUser, paymentLimiter);

/** Asks the gateway for the authoritative status of the caller's payment. */
r.post("/verify", validate({ body: z.object({ orderId: zOrderId }) }), async (req, res) => {
  const owned = await Payment.findOne({ orderId: req.valid.body.orderId, user: req.user._id });
  if (!owned) throw ApiError.notFound("Payment not found");
  const p = await syncPayment(owned.orderId);
  res.json({ data: await view(p) });
});

r.get("/:orderId", validate({ params: z.object({ orderId: zOrderId }) }), async (req, res) => {
  const owned = await Payment.findOne({ orderId: req.valid.params.orderId, user: req.user._id });
  if (!owned) throw ApiError.notFound("Payment not found");
  const p = ["Created", "Pending"].includes(owned.status) && owned.provider === "payu" ? await syncPayment(owned.orderId).catch(() => owned) : owned;
  res.json({ data: await view(p) });
});

/** Development-only stand-in for the gateway (PAYMENT_PROVIDER=mock). */
r.post("/mock/complete", validate({ body: z.object({ orderId: zOrderId, success: z.boolean().default(true) }) }), async (req, res) => {
  if (env.isProd || env.PAYMENT_PROVIDER !== "mock") throw ApiError.notFound("Not available");
  const p = await Payment.findOne({ orderId: req.valid.body.orderId, user: req.user._id });
  if (!p) throw ApiError.notFound("Payment not found");
  if (p.provider !== "mock") throw ApiError.badRequest("Not a mock payment");
  const ok = req.valid.body.success;
  const updated = await applyResult(p, { status: ok ? "Captured" : "Failed", txnId: `MOCK${Date.now()}`, amount: p.amount, method: "MOCK", message: ok ? "Txn Success" : "Payment cancelled by user", raw: { mock: true } });
  res.json({ data: await view(updated) });
});

export default r;
