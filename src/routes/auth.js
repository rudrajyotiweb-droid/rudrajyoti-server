import { Router } from "express";
import { z } from "zod";
import { User } from "../models/index.js";
import { requireUser } from "../middleware/auth.js";
import { authLimiter, otpLimiter } from "../middleware/security.js";
import { validate, zPhone } from "../middleware/validate.js";
import { requestOtp, verifyOtp } from "../services/otp.js";
import { createSession, revokeSession, rotateSession, signUserAccess } from "../services/tokens.js";
import { env } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";
import { me } from "./account.js";

const r = Router();

r.post("/otp/send", otpLimiter, validate({ body: z.object({ phone: zPhone }) }), async (req, res) => {
  const { phone } = req.valid.body;
  const existing = await User.findOne({ phone }, { status: 1 }).lean();
  if (existing?.status === "Blocked") throw ApiError.forbidden("This number has been blocked. Please contact support.", { code: "BLOCKED" });
  const result = await requestOtp(phone);
  res.json({ data: { sent: true, phone, ...result } });
});

r.post(
  "/otp/verify",
  authLimiter,
  validate({ body: z.object({ phone: zPhone, code: z.string().trim().regex(new RegExp(`^\\d{${env.OTP_LENGTH}}$`), `Enter the ${env.OTP_LENGTH}-digit OTP`), name: z.string().trim().max(80).optional() }) }),
  async (req, res) => {
    const { phone, code, name } = req.valid.body;
    await verifyOtp(phone, code);

    let user = await User.findOne({ phone });
    const isNew = !user;
    if (!user) user = await User.create({ phone, name: name ?? "" });
    else if (user.deletedAt) {
      // re-registering a deleted account starts fresh
      user.set({ deletedAt: undefined, name: name ?? "", email: "", family: [], addresses: [], wishlist: [] });
    }
    if (user.status === "Blocked") throw ApiError.forbidden("Your account has been blocked. Please contact support.", { code: "BLOCKED" });
    if (name && !user.name) user.name = name;
    user.lastLoginAt = new Date();
    await user.save();

    const refreshToken = await createSession(user, req);
    res.json({ data: { accessToken: signUserAccess(user), refreshToken, isNew, user: me(user) } });
  },
);

r.post("/refresh", authLimiter, validate({ body: z.object({ refreshToken: z.string().min(20).max(200) }) }), async (req, res) => {
  const { userId, refreshToken } = await rotateSession(req.valid.body.refreshToken, req);
  const user = await User.findById(userId);
  if (!user || user.deletedAt) throw ApiError.unauthorized("Account not found", { code: "SESSION_EXPIRED" });
  if (user.status === "Blocked") throw ApiError.forbidden("Your account has been blocked. Please contact support.", { code: "BLOCKED" });
  res.json({ data: { accessToken: signUserAccess(user), refreshToken, user: me(user) } });
});

r.post("/logout", validate({ body: z.object({ refreshToken: z.string().max(200).optional() }) }), async (req, res) => {
  await revokeSession(req.valid.body.refreshToken);
  res.json({ data: { ok: true } });
});

r.get("/me", requireUser, (req, res) => res.json({ data: me(req.user) }));

export default r;
