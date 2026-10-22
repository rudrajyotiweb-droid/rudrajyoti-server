import { Schema, model, sub } from "./base.js";

const FamilyMember = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  relation: { type: String, trim: true, maxlength: 40, default: "Other" },
  gotra: { type: String, trim: true, maxlength: 60, default: "" },
  dob: { type: String, trim: true, maxlength: 10, default: "" }, // YYYY-MM-DD
});

const Address = new Schema({
  label: { type: String, trim: true, maxlength: 30, default: "Home" },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  line: { type: String, required: true, trim: true, maxlength: 250 },
  city: { type: String, required: true, trim: true, maxlength: 60 },
  state: { type: String, required: true, trim: true, maxlength: 60 },
  pin: { type: String, required: true, match: /^[1-9]\d{5}$/ },
  phone: { type: String, required: true, match: /^[6-9]\d{9}$/ },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true, match: /^[6-9]\d{9}$/ },
    name: { type: String, trim: true, maxlength: 80, default: "" },
    email: { type: String, trim: true, lowercase: true, maxlength: 120, default: "" },
    dob: { type: String, default: "" },
    gotra: { type: String, trim: true, maxlength: 60, default: "" },
    city: { type: String, trim: true, maxlength: 60, default: "" },
    language: { type: String, enum: ["en", "bn", "hi"], default: "en" },
    status: { type: String, enum: ["Active", "Blocked"], default: "Active", index: true },
    family: { type: [FamilyMember], default: [] },
    addresses: { type: [Address], default: [] },
    wishlist: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    notifPrefs: {
      type: sub({ whatsapp: { type: Boolean, default: true }, sms: { type: Boolean, default: true }, email: { type: Boolean, default: true }, push: { type: Boolean, default: true }, offers: { type: Boolean, default: true } }),
      default: () => ({}),
    },
    notes: { type: String, maxlength: 2000, default: "" },
    lastLoginAt: Date,
    deletedAt: Date,
  },
  { timestamps: true },
);
userSchema.index({ name: "text", email: "text" });

export const User = model("User", userSchema);

/** Refresh-token sessions (only a hash of the token is stored). */
const sessionSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    userAgent: { type: String, maxlength: 300 },
    ip: String,
    revokedAt: Date,
  },
  { timestamps: true },
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = model("Session", sessionSchema);

/** One OTP flow per phone; expires automatically. */
const otpSchema = new Schema(
  {
    phone: { type: String, required: true, unique: true },
    provider: { type: String, enum: ["messagecentral", "console"], required: true },
    verificationId: String,
    attempts: { type: Number, default: 0 },
    sendCount: { type: Number, default: 0 },
    windowStart: { type: Date, default: Date.now },
    lastSentAt: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
export const OtpRequest = model("OtpRequest", otpSchema);
