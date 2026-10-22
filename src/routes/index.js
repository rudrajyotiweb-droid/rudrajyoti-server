import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { bumpMetric, nextCode, Ticket, User } from "../models/index.js";
import { validate, zPhone } from "../middleware/validate.js";
import accountRouter from "./account.js";
import adminRouter from "./admin/index.js";
import authRouter from "./auth.js";
import checkoutRouter from "./checkout.js";
import paymentsRouter from "./payments.js";
import publicRouter from "./public.js";

const r = Router();

r.use("/auth", authRouter);
r.use("/account", accountRouter);
r.use("/checkout", checkoutRouter);
r.use("/payments", paymentsRouter);
r.use("/admin", adminRouter);

/** Anonymous funnel / traffic counters (no personal data stored). */
const eventsLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false, handler: (_q, res) => res.status(204).end() });
r.post(
  "/events",
  eventsLimiter,
  validate({ body: z.object({ type: z.enum(["puja_view", "package_selected", "sankalp_filled", "visit"]), source: z.string().trim().toLowerCase().max(30).optional() }) }),
  async (req, res) => {
    const { type, source } = req.valid.body;
    if (type === "visit") {
      const name = { whatsapp: "WhatsApp", google: "Google", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube", direct: "Direct / PWA" }[source ?? "direct"] ?? "Other";
      await bumpMetric(`source:${name}`);
    } else await bumpMetric(`funnel:${type}`);
    res.status(204).end();
  },
);

/** Contact form → support ticket (no account needed). */
const contactLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: "draft-8", legacyHeaders: false, handler: (_q, res) => res.status(429).json({ error: { code: "RATE_LIMITED", message: "You have sent several messages already. Please wait a while or reach us on WhatsApp." } }) });
r.post(
  "/contact",
  contactLimiter,
  validate({
    body: z.object({
      name: z.string().trim().min(2, "Please enter your name").max(80),
      phone: zPhone,
      email: z.union([z.string().trim().email("Enter a valid email"), z.literal("")]).optional(),
      message: z.string().trim().min(10, "Please write a little more so we can help").max(3000),
    }),
  }),
  async (req, res) => {
    const { name, phone, email, message } = req.valid.body;
    const user = await User.findOne({ phone }, { _id: 1 }).lean();
    const t = await Ticket.create({
      code: await nextCode("TK"),
      user: user?._id,
      customerName: name,
      subject: `Website enquiry from ${name}`,
      channel: email ? "Email" : "Phone",
      priority: "Medium",
      messages: [{ from: "customer", text: `${message}\n\n— ${name} · +91 ${phone}${email ? ` · ${email}` : ""}` }],
    });
    res.status(201).json({ data: { ticket: t.code } });
  },
);

r.use(publicRouter);

export default r;
