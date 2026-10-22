import rateLimit from "express-rate-limit";

/** Remove keys like "$gt" or "a.b" from request bodies to block NoSQL operator injection. */
function clean(value, depth = 0) {
  if (depth > 20 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || key.includes(".") || key === "__proto__" || key === "constructor" || key === "prototype") delete value[key];
    else value[key] = clean(value[key], depth + 1);
  }
  return value;
}

export function sanitizeBody(req, _res, next) {
  if (req.body && typeof req.body === "object") clean(req.body);
  if (req.params && typeof req.params === "object") clean(req.params);
  next();
}

const handler = (_req, res) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "Too many requests, please slow down and try again shortly." } });

export const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-8", legacyHeaders: false, handler });
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, handler });
export const otpLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 15, standardHeaders: "draft-8", legacyHeaders: false, handler });
export const paymentLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false, handler });
