import mongoose from "mongoose";
import multer from "multer";
import { ApiError } from "../utils/ApiError.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export function notFound(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

/** Converts every kind of error into a consistent JSON response and never leaks internals. */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let e = err;

  if (e instanceof ApiError) {
    // already safe
  } else if (e instanceof mongoose.Error.ValidationError) {
    const details = Object.values(e.errors).map((x) => ({ path: x.path, message: x.message }));
    e = new ApiError(422, details[0]?.message ?? "Invalid data", { code: "VALIDATION_ERROR", details });
  } else if (e instanceof mongoose.Error.CastError) {
    e = ApiError.badRequest(`Invalid value for ${e.path}`);
  } else if (e?.code === 11000) {
    const field = Object.keys(e.keyPattern ?? e.keyValue ?? {})[0] ?? "field";
    e = ApiError.conflict(`A record with this ${field} already exists`, { code: "DUPLICATE" });
  } else if (e instanceof multer.MulterError) {
    e = new ApiError(e.code === "LIMIT_FILE_SIZE" ? 413 : 400, e.code === "LIMIT_FILE_SIZE" ? "File is too large" : e.message);
  } else if (e?.type === "entity.parse.failed") {
    e = ApiError.badRequest("Malformed JSON body");
  } else if (e?.type === "entity.too.large") {
    e = new ApiError(413, "Request body is too large");
  } else if (e?.name === "JsonWebTokenError" || e?.name === "TokenExpiredError") {
    e = ApiError.unauthorized(e.name === "TokenExpiredError" ? "Session expired, please sign in again" : "Invalid session", { code: e.name === "TokenExpiredError" ? "TOKEN_EXPIRED" : "INVALID_TOKEN" });
  } else if (e instanceof mongoose.mongo.MongoServerSelectionError || e?.name === "MongoNetworkError") {
    e = ApiError.unavailable("Database is temporarily unavailable");
  } else {
    // Unknown → 500, log full error
    logger.error({ err, url: req.originalUrl, method: req.method }, "Unhandled error");
    e = new ApiError(500, "Something went wrong. Please try again.", { code: "INTERNAL_ERROR" });
    if (!env.isProd) e.details = { message: err?.message, stack: err?.stack?.split("\n").slice(0, 6) };
  }

  if (e.status >= 500 && err instanceof ApiError) logger.error({ err, url: req.originalUrl }, e.message);
  else if (e.status >= 400 && e.status < 500) logger.debug({ url: req.originalUrl, code: e.code }, e.message);

  if (res.headersSent) return;
  res.status(e.status).json({ error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } });
}
