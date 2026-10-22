import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { Session } from "../models/index.js";
import { randomToken, sha256 } from "../utils/helpers.js";
import { ApiError } from "../utils/ApiError.js";

const ISSUER = "rudrajyoti";

export const signUserAccess = (user) => jwt.sign({ sub: String(user._id), typ: "user" }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL, issuer: ISSUER });

export const verifyUserAccess = (token) => {
  const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: ISSUER });
  if (p.typ !== "user") throw ApiError.unauthorized("Invalid session", { code: "INVALID_TOKEN" });
  return p;
};

export const signAdmin = (admin) =>
  jwt.sign({ sub: String(admin._id), typ: "admin", role: admin.role, v: admin.tokenVersion ?? 0 }, env.JWT_ADMIN_SECRET, { expiresIn: env.JWT_ADMIN_TTL, issuer: ISSUER });

export const verifyAdmin = (token) => {
  const p = jwt.verify(token, env.JWT_ADMIN_SECRET, { issuer: ISSUER });
  if (p.typ !== "admin") throw ApiError.unauthorized("Invalid session", { code: "INVALID_TOKEN" });
  return p;
};

/** Short-lived token proving the password step passed, used for the 2FA step. */
export const signAdmin2fa = (admin) => jwt.sign({ sub: String(admin._id), typ: "admin2fa" }, env.JWT_ADMIN_SECRET, { expiresIn: "5m", issuer: ISSUER });
export const verifyAdmin2fa = (token) => {
  const p = jwt.verify(token, env.JWT_ADMIN_SECRET, { issuer: ISSUER });
  if (p.typ !== "admin2fa") throw ApiError.unauthorized("Your sign-in step expired, please start again", { code: "INVALID_TOKEN" });
  return p;
};

/** Creates a refresh-token session; returns the raw token (only its hash is stored). */
export async function createSession(user, req) {
  const token = randomToken(48);
  await Session.create({
    user: user._id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + env.REFRESH_TTL_DAYS * 86_400_000),
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300),
    ip: req.ip,
  });
  return token;
}

/** Rotates a refresh token: the old one is revoked, a new one is issued. Reuse of a revoked token revokes all sessions. */
export async function rotateSession(rawToken, req) {
  const hash = sha256(rawToken);
  const session = await Session.findOne({ tokenHash: hash });
  if (!session || session.expiresAt < new Date()) throw ApiError.unauthorized("Session expired, please sign in again", { code: "SESSION_EXPIRED" });
  if (session.revokedAt) {
    // a stolen token was replayed — sign the user out everywhere
    await Session.updateMany({ user: session.user, revokedAt: null }, { $set: { revokedAt: new Date() } });
    throw ApiError.unauthorized("Session expired, please sign in again", { code: "SESSION_EXPIRED" });
  }
  // atomic revoke so two parallel refreshes cannot both succeed
  const updated = await Session.findOneAndUpdate({ _id: session._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
  if (!updated) throw ApiError.unauthorized("Session expired, please sign in again", { code: "SESSION_EXPIRED" });
  const token = await createSession({ _id: session.user }, req);
  return { userId: session.user, refreshToken: token };
}

export async function revokeSession(rawToken) {
  if (!rawToken) return;
  await Session.updateOne({ tokenHash: sha256(rawToken), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export const revokeAllSessions = (userId) => Session.updateMany({ user: userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
