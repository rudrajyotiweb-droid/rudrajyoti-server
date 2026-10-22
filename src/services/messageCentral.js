/**
 * Message Central — VerifyNow OTP API
 * Docs: https://www.messagecentral.com/product/verify-now/api
 *
 *  1. GET  /auth/v1/authentication/token?customerId&key(base64 password)&scope=NEW → { token }
 *  2. POST /verification/v3/send?countryCode&customerId&flowType&mobileNumber&otpLength   (header authToken) → data.verificationId
 *  3. GET  /verification/v3/validateOtp?countryCode&mobileNumber&verificationId&customerId&code&flowType (header authToken)
 *        → data.verificationStatus === "VERIFICATION_COMPLETED"
 */
import { env } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { fetchWithTimeout, safeJson } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

const BASE = "https://cpaas.messagecentral.com";
const TOKEN_TTL = 6 * 60 * 60 * 1000; // refresh the auth token every 6 hours (or on auth failure)

let cached = { token: null, at: 0 };
let inflight = null;

const ERRORS = {
  400: [400, "Invalid request to the OTP service"],
  409: [429, "An OTP was already sent. Please wait before requesting another."],
  501: [503, "OTP service is not configured correctly"],
  505: [400, "This OTP request is no longer valid. Please request a new OTP."],
  506: [429, "An OTP was already sent to this number. Please wait a minute and try again."],
  511: [400, "Unsupported country code"],
  700: [400, "Verification failed. Please request a new OTP."],
  702: [400, "Incorrect OTP. Please check and try again."],
  703: [400, "This OTP was already used. Please request a new OTP."],
  705: [400, "OTP has expired. Please request a new one."],
  800: [429, "Too many attempts. Please try again after some time."],
};

function mapError(code, fallbackMsg) {
  const [status, msg] = ERRORS[Number(code)] ?? [502, fallbackMsg || "Could not reach the OTP service. Please try again."];
  return new ApiError(status, msg, { code: `OTP_${code ?? "UPSTREAM"}` });
}

async function getToken(force = false) {
  if (!force && cached.token && Date.now() - cached.at < TOKEN_TTL) return cached.token;
  if (inflight) return inflight;

  inflight = (async () => {
    const qs = new URLSearchParams({
      customerId: env.MESSAGE_CENTRAL_CUSTOMER_ID,
      key: Buffer.from(env.MESSAGE_CENTRAL_PASSWORD, "utf8").toString("base64"),
      scope: "NEW",
      country: env.MESSAGE_CENTRAL_COUNTRY_CODE,
    });
    if (env.MESSAGE_CENTRAL_EMAIL) qs.set("email", env.MESSAGE_CENTRAL_EMAIL);
    let res;
    try {
      res = await fetchWithTimeout(`${BASE}/auth/v1/authentication/token?${qs}`, { headers: { accept: "*/*" } });
    } catch (err) {
      logger.error({ err: err.message }, "Message Central token request failed");
      throw ApiError.unavailable("OTP service is unreachable. Please try again.");
    }
    const json = await safeJson(res);
    if (!res.ok || !json?.token) {
      logger.error({ status: res.status, body: json }, "Message Central token rejected");
      throw ApiError.unavailable("OTP service is not available right now. Please try again later.");
    }
    cached = { token: json.token, at: Date.now() };
    return json.token;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Calls an endpoint with the cached token, retrying once with a fresh token on auth failure. */
async function call(path, params, method) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(attempt > 0);
    let res;
    try {
      res = await fetchWithTimeout(`${BASE}${path}?${new URLSearchParams(params)}`, { method, headers: { authToken: token, accept: "*/*" } });
    } catch (err) {
      logger.error({ err: err.message, path }, "Message Central request failed");
      throw ApiError.unavailable("OTP service is unreachable. Please try again.");
    }
    const json = await safeJson(res);
    if ((res.status === 401 || res.status === 403) && attempt === 0) {
      cached = { token: null, at: 0 };
      continue;
    }
    return { res, json };
  }
  throw ApiError.unavailable("OTP service authentication failed");
}

/** Sends an OTP. Returns { verificationId, timeout }. */
export async function sendOtp(phone10) {
  const { res, json } = await call(
    "/verification/v3/send",
    {
      countryCode: env.MESSAGE_CENTRAL_COUNTRY_CODE,
      customerId: env.MESSAGE_CENTRAL_CUSTOMER_ID,
      flowType: env.MESSAGE_CENTRAL_FLOW_TYPE,
      mobileNumber: phone10,
      otpLength: String(env.OTP_LENGTH),
    },
    "POST",
  );
  const code = json?.responseCode ?? json?.data?.responseCode;
  if (Number(code) === 200 && json?.data?.verificationId) {
    return { verificationId: String(json.data.verificationId), timeout: Number(json.data.timeout) || 60 };
  }
  logger.warn({ status: res.status, code, msg: json?.message }, "Message Central send OTP failed");
  throw mapError(code, json?.message);
}

/** Validates an OTP. Resolves true on success, throws ApiError otherwise. */
export async function validateOtp(phone10, verificationId, code) {
  const { res, json } = await call(
    "/verification/v3/validateOtp",
    {
      countryCode: env.MESSAGE_CENTRAL_COUNTRY_CODE,
      mobileNumber: phone10,
      verificationId,
      customerId: env.MESSAGE_CENTRAL_CUSTOMER_ID,
      code,
      flowType: env.MESSAGE_CENTRAL_FLOW_TYPE,
    },
    "GET",
  );
  const rc = json?.responseCode ?? json?.data?.responseCode;
  if (Number(rc) === 200 && json?.data?.verificationStatus === "VERIFICATION_COMPLETED") return true;
  logger.info({ status: res.status, code: rc, vs: json?.data?.verificationStatus }, "Message Central OTP not verified");
  throw mapError(Number(rc) === 200 ? 700 : rc, json?.message);
}
