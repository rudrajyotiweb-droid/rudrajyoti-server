import { z } from "zod";
import { ApiError } from "../utils/ApiError.js";

/**
 * Validate req.body / req.query / req.params with zod schemas.
 * Parsed (coerced, stripped) values are stored on req.valid.{body,query,params}
 * because Express 5 makes req.query read-only.
 */
export const validate =
  ({ body, query, params } = {}) =>
  (req, _res, next) => {
    req.valid = req.valid ?? {};
    const parts = { body, query, params };
    for (const [key, schema] of Object.entries(parts)) {
      if (!schema) continue;
      const result = schema.safeParse(req[key] ?? {});
      if (!result.success) {
        const details = result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
        const first = details[0];
        return next(new ApiError(422, first ? `${first.path ? first.path + ": " : ""}${first.message}` : "Invalid input", { code: "VALIDATION_ERROR", details }));
      }
      req.valid[key] = result.data;
    }
    next();
  };

// Reusable schema pieces
export const zId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
export const zIdParam = z.object({ id: zId });
export const zSlug = z.string().trim().toLowerCase().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes").max(100);
export const zPhone = z
  .string()
  .trim()
  .transform((v) => v.replace(/\D/g, ""))
  .transform((v) => (v.length === 12 && v.startsWith("91") ? v.slice(2) : v.length === 11 && v.startsWith("0") ? v.slice(1) : v))
  .refine((v) => /^[6-9]\d{9}$/.test(v), "Enter a valid 10-digit Indian mobile number");
export const zPincode = z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit pincode");
export const zMoney = z.coerce.number().int("Amount must be a whole number").min(0).max(10_000_000);
export const zText = (max = 500) => z.string().trim().max(max);
export const zUrlPath = z.string().trim().max(1000);
export const zPage = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(5000).optional(), // each route clamps to its own max via paging()
  q: z.string().trim().max(100).optional(),
});
export const zBoolish = z.union([z.boolean(), z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1")]);
