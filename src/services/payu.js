/**
 * PayU India — Hosted Checkout
 *  - buildCheckout()    → signed form fields; the browser POSTs them to PayU's /_payment page
 *  - verifyCallback()   → checks the reverse hash on the form PayU posts to our surl/furl
 *  - orderStatus()      → `verify_payment` API, the source of truth for every payment
 *  - refund()/refundStatus() → `cancel_refund_transaction` / `check_action_status`
 *
 * Hashes use SHA-512 with Salt v1:
 *   request : key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
 *   response: [additionalCharges|]SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
 *   API     : key|command|var1|SALT
 */
import crypto from "node:crypto";
import { env } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { fetchWithTimeout, safeJson } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

const live = () => env.PAYU_MODE === "production";
export const paymentUrl = () => (live() ? "https://secure.payu.in/_payment" : "https://test.payu.in/_payment");
const apiUrl = () => (live() ? "https://info.payu.in/merchant/postservice.php?form=2" : "https://test.payu.in/merchant/postservice.php?form=2");

const sha512 = (s) => crypto.createHash("sha512").update(s, "utf8").digest("hex");
export const amountStr = (n) => Number(n).toFixed(2);
export const callbackUrl = () => `${env.API_PUBLIC_URL.replace(/\/+$/, "")}/api/v1/payments/payu/callback`;

/** PayU rejects pipes (they break the hash) and some special characters in these fields. */
const clean = (s, max) =>
  String(s ?? "")
    .replace(/[|<>"'`\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a).toLowerCase());
  const y = Buffer.from(String(b).toLowerCase());
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Returns the fields for the auto-submitted form that opens PayU's hosted checkout.
 * Only non-secret values plus the hash leave the server.
 */
export function buildCheckout({ txnid, amount, productinfo, firstname, email, phone, udf1 = "", udf2 = "" }) {
  const f = {
    key: env.PAYU_KEY,
    txnid,
    amount: amountStr(amount),
    productinfo: clean(productinfo, 100) || "Order",
    firstname: clean(firstname, 60) || "Devotee",
    email: clean(email, 100) || env.PAYU_DEFAULT_EMAIL,
    phone: String(phone ?? "").replace(/\D/g, "").slice(-10),
    udf1: clean(udf1, 50),
    udf2: clean(udf2, 50),
    udf3: "",
    udf4: "",
    udf5: "",
    surl: callbackUrl(),
    furl: callbackUrl(),
  };
  const hashStr = [f.key, f.txnid, f.amount, f.productinfo, f.firstname, f.email, f.udf1, f.udf2, f.udf3, f.udf4, f.udf5, "", "", "", "", "", env.PAYU_SALT].join("|");
  return { action: paymentUrl(), fields: { ...f, hash: sha512(hashStr) } };
}

/** Verifies the reverse hash on the form PayU posts to surl/furl. */
export function verifyCallback(p = {}) {
  if (!p.hash || p.key !== env.PAYU_KEY) return false;
  const parts = [env.PAYU_SALT, p.status ?? "", "", "", "", "", "", p.udf5 ?? "", p.udf4 ?? "", p.udf3 ?? "", p.udf2 ?? "", p.udf1 ?? "", p.email ?? "", p.firstname ?? "", p.productinfo ?? "", p.amount ?? "", p.txnid ?? "", p.key ?? ""];
  if (p.additionalCharges) parts.unshift(p.additionalCharges);
  try {
    return safeEqual(sha512(parts.join("|")), p.hash);
  } catch {
    return false;
  }
}

/** Calls PayU's merchant postservice API (form-encoded, key|command|var1|salt hash). */
async function command(cmd, vars) {
  if (!env.PAYU_KEY || !env.PAYU_SALT) throw ApiError.unavailable("Payment service is misconfigured");
  const form = new URLSearchParams({ key: env.PAYU_KEY, command: cmd, hash: sha512(`${env.PAYU_KEY}|${cmd}|${vars.var1}|${env.PAYU_SALT}`) });
  for (const [k, v] of Object.entries(vars)) if (v != null) form.set(k, String(v));
  let res;
  try {
    res = await fetchWithTimeout(apiUrl(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form.toString() }, 20_000);
  } catch (err) {
    logger.error({ err: err.message, cmd }, "PayU request failed");
    throw ApiError.unavailable("Payment gateway is unreachable. Please try again.");
  }
  const json = await safeJson(res);
  if (!json || typeof json !== "object") {
    logger.error({ status: res.status, cmd }, "PayU returned an unexpected response");
    throw new ApiError(502, "Payment gateway returned an unexpected response. Please try again.", { code: "PAYU_BAD_RESPONSE" });
  }
  return json;
}

/**
 * Fetches the authoritative status of a transaction.
 * Returns { status: "Captured" | "Failed" | "Pending", txnId, bankTxnId, amount, method, message, raw }
 */
export async function orderStatus(txnid) {
  const r = await command("verify_payment", { var1: txnid });
  const t = r?.transaction_details?.[txnid];
  if (!t || typeof t !== "object" || /not\s*found/i.test(String(t.status ?? ""))) {
    // "Not Found": the customer never completed the PayU page (or it is still open)
    return { status: "Pending", message: r?.msg || "Payment not started", raw: { msg: r?.msg } };
  }
  const s = String(t.status ?? "").toLowerCase();
  const status = s === "success" ? "Captured" : s === "failure" || s === "failed" ? "Failed" : "Pending";
  const amt = t.amt ?? t.transaction_amount ?? t.net_amount_debit;
  return {
    status,
    txnId: t.mihpayid ? String(t.mihpayid) : undefined,
    bankTxnId: t.bank_ref_num || undefined,
    amount: status === "Captured" && amt != null && amt !== "" ? Number(amt) : null,
    method: (t.mode && t.mode !== "-" ? t.mode : undefined) || undefined,
    message: status === "Failed" ? t.error_Message || t.field9 || t.unmappedstatus || "Payment failed" : t.field9 || t.unmappedstatus,
    raw: { status: t.status, unmappedstatus: t.unmappedstatus, mihpayid: t.mihpayid, mode: t.mode, bankcode: t.bankcode, bank_ref_num: t.bank_ref_num, amt, error_code: t.error_code, error_Message: t.error_Message, addedon: t.addedon },
  };
}

/** Initiates a (full or partial) refund. refId must be unique per refund. Returns { status, refundId, message }. */
export async function refund({ txnId, refId, amount }) {
  if (!txnId) return { status: "Failed", message: "Missing PayU transaction id (mihpayid)" };
  const r = await command("cancel_refund_transaction", { var1: txnId, var2: refId, var3: amountStr(amount) });
  if (Number(r.status) !== 1) return { status: "Failed", refundId: r.request_id, message: r.msg || "Refund rejected by PayU" };
  return { status: "Pending", refundId: r.request_id ? String(r.request_id) : undefined, message: r.msg || "Refund request queued" };
}

/** Status of a refund by PayU request id. Returns { status: "Pending"|"Success"|"Failed", refundId, message }. */
export async function refundStatus({ refundId }) {
  if (!refundId) return { status: "Pending" };
  const r = await command("check_action_status", { var1: refundId });
  // shape: transaction_details: { <request_id>: { <request_id>: { status, ... } } } (sometimes one level less)
  let d = r?.transaction_details?.[refundId];
  if (d && typeof d === "object" && d.status == null) d = d[refundId] ?? Object.values(d)[0];
  const s = String(d?.status ?? "").toLowerCase();
  return {
    status: s === "success" ? "Success" : s === "failure" || s === "failed" || s === "cancelled" ? "Failed" : "Pending",
    refundId,
    message: d?.status ? `Refund ${d.status}` : r?.msg,
  };
}
