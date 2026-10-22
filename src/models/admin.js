import { Schema, model } from "./base.js";

export const ROLES = ["super_admin", "operations", "store", "content", "support"];

const adminSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, default: "support" },
    active: { type: Boolean, default: true },
    totpSecret: { type: String, select: false },
    totpEnabled: { type: Boolean, default: false },
    failedLogins: { type: Number, default: 0 },
    lockUntil: Date,
    lastLoginAt: Date,
    tokenVersion: { type: Number, default: 0 }, // bump to sign out everywhere
  },
  { timestamps: true },
);
export const Admin = model("Admin", adminSchema);

const auditSchema = new Schema(
  {
    admin: { type: Schema.Types.ObjectId, ref: "Admin" },
    who: { type: String, default: "System" },
    action: { type: String, required: true, maxlength: 300 },
    target: { type: String, default: "", maxlength: 300 },
    ip: String,
    meta: Schema.Types.Mixed,
  },
  { timestamps: { createdAt: "at", updatedAt: false } },
);
auditSchema.index({ at: -1 });
export const AuditLog = model("AuditLog", auditSchema);
