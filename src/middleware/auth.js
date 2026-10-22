import { Admin, User } from "../models/index.js";
import { verifyAdmin, verifyUserAccess } from "../services/tokens.js";
import { ApiError } from "../utils/ApiError.js";

const bearer = (req) => {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
};

/** Requires a signed-in, active devotee. Sets req.user (mongoose doc). */
export async function requireUser(req, _res, next) {
  const token = bearer(req);
  if (!token) return next(ApiError.unauthorized());
  const payload = verifyUserAccess(token); // throws → error handler maps to 401
  const user = await User.findById(payload.sub);
  if (!user || user.deletedAt) return next(ApiError.unauthorized("Account not found", { code: "INVALID_TOKEN" }));
  if (user.status === "Blocked") return next(ApiError.forbidden("Your account has been blocked. Please contact support.", { code: "BLOCKED" }));
  req.user = user;
  next();
}

/** Sets req.user when a valid token is present, otherwise continues as guest. */
export async function optionalUser(req, _res, next) {
  const token = bearer(req);
  if (!token) return next();
  try {
    const payload = verifyUserAccess(token);
    const user = await User.findById(payload.sub);
    if (user && !user.deletedAt && user.status === "Active") req.user = user;
  } catch {
    /* guest */
  }
  next();
}

/** Requires an admin token; optional list of allowed roles (super_admin always allowed). */
export const requireAdmin =
  (...roles) =>
  async (req, _res, next) => {
    const token = bearer(req);
    if (!token) return next(ApiError.unauthorized());
    const payload = verifyAdmin(token);
    const admin = await Admin.findById(payload.sub);
    if (!admin || !admin.active) return next(ApiError.unauthorized("Account disabled", { code: "INVALID_TOKEN" }));
    if ((admin.tokenVersion ?? 0) !== (payload.v ?? 0)) return next(ApiError.unauthorized("Session expired, please sign in again", { code: "TOKEN_EXPIRED" }));
    if (roles.length && admin.role !== "super_admin" && !roles.includes(admin.role)) return next(ApiError.forbidden());
    req.admin = admin;
    next();
  };

/** Role guard for routers already behind requireAdmin(). */
export const allow =
  (...roles) =>
  (req, _res, next) => {
    if (!req.admin) return next(ApiError.unauthorized());
    if (req.admin.role === "super_admin" || roles.includes(req.admin.role)) return next();
    next(ApiError.forbidden());
  };
