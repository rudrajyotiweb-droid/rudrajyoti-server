import bcrypt from "bcryptjs";
import { Router } from "express";
import { generateSecret, generateURI, verify as verifyTotp } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { Admin, ROLES } from "../../models/index.js";
import { allow, requireAdmin } from "../../middleware/auth.js";
import { authLimiter } from "../../middleware/security.js";
import { validate, zIdParam } from "../../middleware/validate.js";
import { audit } from "../../services/audit.js";
import { signAdmin, signAdmin2fa, verifyAdmin2fa } from "../../services/tokens.js";
import { ApiError } from "../../utils/ApiError.js";

const r = Router();
const MAX_FAILS = 5;
const LOCK_MIN = 15;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

export const adminView = (a) => ({ id: String(a._id), email: a.email, name: a.name, role: a.role, active: a.active, totpEnabled: !!a.totpEnabled, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt });

const zPassword = z.string().min(8, "Password must be at least 8 characters").max(128);
const zCode = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");

async function checkTotp(secret, token) {
  try {
    const result = await verifyTotp({ secret, token, epochTolerance: 30 });
    return !!result?.valid;
  } catch {
    return false;
  }
}

async function finishLogin(admin, req, res) {
  admin.failedLogins = 0;
  admin.lockUntil = undefined;
  admin.lastLoginAt = new Date();
  await admin.save();
  req.admin = admin;
  await audit(req, "Signed in", admin.email);
  res.json({ data: { token: signAdmin(admin), admin: adminView(admin) } });
}

r.post("/login", authLimiter, validate({ body: z.object({ email: z.string().trim().toLowerCase().email("Enter your work email"), password: z.string().min(1, "Enter your password").max(128) }) }), async (req, res) => {
  const { email, password } = req.valid.body;
  const admin = await Admin.findOne({ email }).select("+passwordHash +totpSecret");
  const generic = ApiError.unauthorized("Email or password is incorrect", { code: "BAD_CREDENTIALS" });
  if (!admin || !admin.active) {
    await bcrypt.compare(password, DUMMY_HASH); // keep timing equal for unknown emails
    throw generic;
  }
  if (admin.lockUntil && admin.lockUntil > new Date()) throw ApiError.tooMany(`Too many failed attempts. Try again after ${Math.ceil((admin.lockUntil - Date.now()) / 60000)} minutes.`, { code: "LOCKED" });

  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) {
    admin.failedLogins = (admin.failedLogins ?? 0) + 1;
    if (admin.failedLogins >= MAX_FAILS) {
      admin.lockUntil = new Date(Date.now() + LOCK_MIN * 60_000);
      admin.failedLogins = 0;
    }
    await admin.save();
    throw generic;
  }

  if (admin.totpEnabled && admin.totpSecret) return res.json({ data: { twoFactor: true, tempToken: signAdmin2fa(admin) } });
  return finishLogin(admin, req, res);
});

r.post("/2fa", authLimiter, validate({ body: z.object({ tempToken: z.string().min(10).max(1000), code: zCode }) }), async (req, res) => {
  const payload = verifyAdmin2fa(req.valid.body.tempToken);
  const admin = await Admin.findById(payload.sub).select("+totpSecret");
  if (!admin || !admin.active || !admin.totpEnabled) throw ApiError.unauthorized("Please sign in again");
  if (!(await checkTotp(admin.totpSecret, req.valid.body.code))) throw ApiError.badRequest("Incorrect code. Check your authenticator app and try again.", { code: "BAD_2FA" });
  return finishLogin(admin, req, res);
});

/* ───── signed-in admin ───── */
r.use(requireAdmin());

r.get("/me", (req, res) => res.json({ data: adminView(req.admin) }));

r.post("/password", validate({ body: z.object({ current: z.string().min(1).max(128), next: zPassword }) }), async (req, res) => {
  const admin = await Admin.findById(req.admin._id).select("+passwordHash");
  if (!(await bcrypt.compare(req.valid.body.current, admin.passwordHash))) throw ApiError.badRequest("Current password is incorrect");
  admin.passwordHash = await bcrypt.hash(req.valid.body.next, 12);
  admin.tokenVersion = (admin.tokenVersion ?? 0) + 1;
  await admin.save();
  await audit(req, "Changed password", admin.email);
  res.json({ data: { token: signAdmin(admin) } });
});

r.post("/logout-all", async (req, res) => {
  await Admin.updateOne({ _id: req.admin._id }, { $inc: { tokenVersion: 1 } });
  res.json({ data: { ok: true } });
});

r.post("/2fa/setup", async (req, res) => {
  const secret = generateSecret();
  await Admin.updateOne({ _id: req.admin._id }, { $set: { totpSecret: secret, totpEnabled: false } });
  const uri = generateURI({ issuer: "Rudra Jyoti Admin", label: req.admin.email, secret });
  res.json({ data: { secret, uri, qr: await QRCode.toDataURL(uri) } });
});

r.post("/2fa/enable", validate({ body: z.object({ code: zCode }) }), async (req, res) => {
  const admin = await Admin.findById(req.admin._id).select("+totpSecret");
  if (!admin.totpSecret) throw ApiError.badRequest("Start 2FA setup first");
  if (!(await checkTotp(admin.totpSecret, req.valid.body.code))) throw ApiError.badRequest("Incorrect code. Scan the QR again and retry.");
  admin.totpEnabled = true;
  await admin.save();
  await audit(req, "Enabled 2FA", admin.email);
  res.json({ data: adminView(admin) });
});

r.post("/2fa/disable", validate({ body: z.object({ code: zCode }) }), async (req, res) => {
  const admin = await Admin.findById(req.admin._id).select("+totpSecret");
  if (!admin.totpEnabled) return res.json({ data: adminView(admin) });
  if (!(await checkTotp(admin.totpSecret, req.valid.body.code))) throw ApiError.badRequest("Incorrect code");
  admin.totpEnabled = false;
  admin.totpSecret = undefined;
  await admin.save();
  await audit(req, "Disabled 2FA", admin.email);
  res.json({ data: adminView(admin) });
});

/* ───── staff management (super admin) ───── */
const staff = Router();
staff.use(allow());

staff.get("/", async (_req, res) => {
  const list = await Admin.find().sort({ createdAt: 1 }).lean();
  res.json({ data: list.map(adminView) });
});

staff.post("/", validate({ body: z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(2).max(80), role: z.enum(ROLES), password: zPassword }) }), async (req, res) => {
  const { password, ...rest } = req.valid.body;
  const a = await Admin.create({ ...rest, passwordHash: await bcrypt.hash(password, 12) });
  await audit(req, `Added staff (${a.role})`, a.email);
  res.status(201).json({ data: adminView(a) });
});

staff.patch("/:id", validate({ params: zIdParam, body: z.object({ name: z.string().trim().min(2).max(80).optional(), role: z.enum(ROLES).optional(), active: z.boolean().optional(), password: zPassword.optional() }) }), async (req, res) => {
  const a = await Admin.findById(req.valid.params.id);
  if (!a) throw ApiError.notFound("Staff member not found");
  const { password, ...rest } = req.valid.body;
  if (String(a._id) === String(req.admin._id) && (rest.active === false || (rest.role && rest.role !== "super_admin"))) throw ApiError.badRequest("You cannot demote or disable your own account");
  a.set(rest);
  if (password) a.passwordHash = await bcrypt.hash(password, 12);
  if (password || rest.active === false || rest.role) a.tokenVersion = (a.tokenVersion ?? 0) + 1;
  await a.save();
  await audit(req, "Updated staff", a.email, { fields: Object.keys(req.valid.body).filter((k) => k !== "password") });
  res.json({ data: adminView(a) });
});

export { staff as staffRouter };
export default r;
