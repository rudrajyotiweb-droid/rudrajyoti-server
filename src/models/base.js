import mongoose from "mongoose";

/** Every model serialises `_id` as `id` and drops `__v`, so the frontends get clean objects. */
function transform(_doc, ret) {
  if (ret._id !== undefined) {
    ret.id = String(ret._id);
    delete ret._id;
  }
  delete ret.__v;
  return ret;
}

mongoose.plugin((schema) => {
  schema.set("toJSON", { virtuals: false, versionKey: false, transform });
  schema.set("toObject", { virtuals: false, versionKey: false });
});

export const { Schema, model, Types } = mongoose;

/** Sub-document schemas without their own _id. */
export const sub = (def) => new Schema(def, { _id: false });

/** Format a lean() result the same way toJSON does (lean skips transforms). */
export function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean);
  if (!obj || typeof obj !== "object" || obj instanceof Date || obj instanceof Types.ObjectId) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "__v") continue;
    if (k === "_id") {
      out.id = String(v);
      continue;
    }
    out[k] = v instanceof Types.ObjectId ? String(v) : Array.isArray(v) || (v && typeof v === "object" && !(v instanceof Date)) ? clean(v) : v;
  }
  return out;
}
