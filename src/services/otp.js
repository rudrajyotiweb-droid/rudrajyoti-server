import { env } from "../config/env.js";
import { OtpRequest } from "../models/index.js";
import { ApiError } from "../utils/ApiError.js";
import { logger } from "../utils/logger.js";
import * as mc from "./messageCentral.js";

const RESEND_COOLDOWN_S = 30;
const MAX_SENDS_PER_HOUR = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const OTP_VALID_MIN = 10;

/** Sends an OTP to a 10-digit Indian mobile number with per-phone throttling. */
export async function requestOtp(phone) {
  const now = new Date();
  const existing = await OtpRequest.findOne({ phone });

  if (existing?.lastSentAt) {
    const since = (now - existing.lastSentAt) / 1000;
    if (since < RESEND_COOLDOWN_S) {
      throw new ApiError(429, `Please wait ${Math.ceil(RESEND_COOLDOWN_S - since)} seconds before requesting a new OTP`, {
        code: "OTP_COOLDOWN",
        details: { retryAfter: Math.ceil(RESEND_COOLDOWN_S - since) },
      });
    }
  }
  const windowFresh = existing && now - existing.windowStart < 3_600_000;
  if (windowFresh && existing.sendCount >= MAX_SENDS_PER_HOUR) {
    throw ApiError.tooMany("Too many OTP requests for this number. Please try again in an hour.", { code: "OTP_LIMIT" });
  }

  let verificationId = null;
  if (env.OTP_PROVIDER === "messagecentral") {
    ({ verificationId } = await mc.sendOtp(phone));
  } else {
    logger.warn(`[DEV OTP] ${phone} → ${env.OTP_DEV_CODE}`);
  }

  await OtpRequest.findOneAndUpdate(
    { phone },
    {
      $set: {
        provider: env.OTP_PROVIDER,
        verificationId,
        attempts: 0,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + OTP_VALID_MIN * 60_000),
        windowStart: windowFresh ? existing.windowStart : now,
        sendCount: windowFresh ? existing.sendCount + 1 : 1,
      },
    },
    { upsert: true },
  );

  return { resendIn: RESEND_COOLDOWN_S, length: env.OTP_LENGTH, ...(env.OTP_PROVIDER === "console" ? { devHint: "Development mode: use the OTP shown in the server log" } : {}) };
}

/** Verifies an OTP; consumes the request on success. */
export async function verifyOtp(phone, code) {
  const reqDoc = await OtpRequest.findOne({ phone });
  if (!reqDoc || reqDoc.expiresAt < new Date()) throw ApiError.badRequest("OTP has expired. Please request a new one.", { code: "OTP_EXPIRED" });

  // count the attempt atomically before checking, so parallel guesses are limited too
  const counted = await OtpRequest.findOneAndUpdate({ _id: reqDoc._id, attempts: { $lt: MAX_VERIFY_ATTEMPTS } }, { $inc: { attempts: 1 } }, { new: true });
  if (!counted) throw ApiError.tooMany("Too many wrong attempts. Please request a new OTP.", { code: "OTP_ATTEMPTS" });

  if (reqDoc.provider === "messagecentral") {
    if (!reqDoc.verificationId) throw ApiError.badRequest("Please request a new OTP.", { code: "OTP_EXPIRED" });
    await mc.validateOtp(phone, reqDoc.verificationId, code);
  } else if (code !== env.OTP_DEV_CODE) {
    throw ApiError.badRequest("Incorrect OTP. Please check and try again.", { code: "OTP_WRONG" });
  }

  await OtpRequest.deleteOne({ _id: reqDoc._id });
  return true;
}
