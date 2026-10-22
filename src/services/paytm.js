/**
 * Paytm Payment Gateway (JS Checkout)
 *  - initiateTransaction → txnToken, used by the frontend Paytm CheckoutJS
 *  - order status API is the source of truth for every payment
 *  - callback params are verified with PaytmChecksum
 *  - refunds via /refund/apply
 */
import PaytmChecksum from "paytmchecksum";
import { env } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { fetchWithTimeout, safeJson } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

const host = () => env.PAYTM_HOST.replace(/\/+$/, "");
export const checkoutScriptUrl = () => `${host()}/merchantpgpui/checkoutjs/merchants/${env.PAYTM_MID}.js`;
export const amountStr = (n) => Number(n).toFixed(2);

async function post(path, body) {
  let signature;
  try {
    signature = await PaytmChecksum.generateSignature(JSON.stringify(body), env.PAYTM_MERCHANT_KEY);
  } catch (err) {
    logger.error({ err: err.message }, "Paytm signature generation failed");
    throw ApiError.unavailable("Payment service is misconfigured");
  }
  let res;
  try {
    res = await fetchWithTimeout(`${host()}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body, head: { signature } }) }, 20_000);
  } catch (err) {
    logger.error({ err: err.message, path }, "Paytm request failed");
    throw ApiError.unavailable("Payment gateway is unreachable. Please try again.");
  }
  const json = await safeJson(res);
  if (!json?.body) {
    logger.error({ status: res.status, path }, "Paytm returned an unexpected response");
    throw new ApiError(502, "Payment gateway returned an unexpected response. Please try again.", { code: "PAYTM_BAD_RESPONSE" });
  }
  return json.body;
}

/** Creates a Paytm transaction and returns its txnToken. */
export async function initiateTransaction({ orderId, amount, custId, mobile, email, firstName }) {
  const userInfo = { custId: String(custId) };
  if (mobile) userInfo.mobile = mobile;
  if (email) userInfo.email = email;
  if (firstName) userInfo.firstName = firstName.slice(0, 50);

  const body = {
    requestType: "Payment",
    mid: env.PAYTM_MID,
    websiteName: env.PAYTM_WEBSITE,
    orderId,
    callbackUrl: `${env.API_PUBLIC_URL.replace(/\/+$/, "")}/api/v1/payments/paytm/callback`,
    txnAmount: { value: amountStr(amount), currency: "INR" },
    userInfo,
  };
  const qs = new URLSearchParams({ mid: env.PAYTM_MID, orderId });
  const r = await post(`/theia/api/v1/initiateTransaction?${qs}`, body);
  if (r?.resultInfo?.resultStatus !== "S" || !r.txnToken) {
    logger.error({ orderId, result: r?.resultInfo }, "Paytm initiateTransaction failed");
    throw new ApiError(502, r?.resultInfo?.resultMsg ? `Payment could not be started: ${r.resultInfo.resultMsg}` : "Payment could not be started. Please try again.", { code: "PAYTM_INIT_FAILED" });
  }
  return r.txnToken;
}

/**
 * Fetches the authoritative status of an order.
 * Returns { status: "Captured" | "Failed" | "Pending", txnId, bankTxnId, amount, method, message, raw }
 */
export async function orderStatus(orderId) {
  const r = await post("/v3/order/status", { mid: env.PAYTM_MID, orderId });
  const rs = r?.resultInfo?.resultStatus;
  const status = rs === "TXN_SUCCESS" ? "Captured" : rs === "TXN_FAILURE" ? "Failed" : "Pending";
  return {
    status,
    txnId: r.txnId,
    bankTxnId: r.bankTxnId,
    amount: r.txnAmount != null ? Number(r.txnAmount) : null,
    method: r.paymentMode,
    message: r?.resultInfo?.resultMsg,
    raw: { resultInfo: r.resultInfo, txnId: r.txnId, bankTxnId: r.bankTxnId, txnAmount: r.txnAmount, paymentMode: r.paymentMode, gatewayName: r.gatewayName, bankName: r.bankName, txnDate: r.txnDate },
  };
}

/** Verifies the checksum on the form POST Paytm sends to our callback URL. */
export function verifyCallback(params) {
  const { CHECKSUMHASH, ...rest } = params ?? {};
  if (!CHECKSUMHASH) return false;
  try {
    return PaytmChecksum.verifySignature(rest, env.PAYTM_MERCHANT_KEY, CHECKSUMHASH);
  } catch {
    return false;
  }
}

/** Initiates a (full or partial) refund. Returns { status: "Pending"|"Success"|"Failed", refundId, message }. */
export async function refund({ orderId, txnId, refId, amount }) {
  const r = await post("/refund/apply", { mid: env.PAYTM_MID, txnType: "REFUND", orderId, txnId, refId, refundAmount: amountStr(amount) });
  const rs = r?.resultInfo?.resultStatus;
  return {
    status: rs === "TXN_SUCCESS" ? "Success" : rs === "TXN_FAILURE" ? "Failed" : "Pending",
    refundId: r.refundId,
    message: r?.resultInfo?.resultMsg,
  };
}

export async function refundStatus({ orderId, refId }) {
  const r = await post("/v2/refund/status", { mid: env.PAYTM_MID, orderId, refId });
  const rs = r?.resultInfo?.resultStatus;
  return { status: rs === "TXN_SUCCESS" ? "Success" : rs === "TXN_FAILURE" ? "Failed" : "Pending", refundId: r.refundId, message: r?.resultInfo?.resultMsg };
}
