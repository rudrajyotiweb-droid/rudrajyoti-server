import { Router } from "express";
import { z } from "zod";
import { AuditLog, Banner, BANNER_PLACEMENTS, Booking, Coupon, Faq, Order, Page, Post, Product, PushCampaign, Review, Ticket, User } from "../../models/index.js";
import { allow } from "../../middleware/auth.js";
import { imageUpload, videoUpload } from "../../middleware/upload.js";
import { validate, zId, zIdParam, zPage, zSlug } from "../../middleware/validate.js";
import { audit } from "../../services/audit.js";
import { deleteByKey, listMedia, saveUpload } from "../../services/media.js";
import { broadcast, notifyUser } from "../../services/notify.js";
import { DEFAULT_SITE, getHome, getSite, setSetting } from "../../services/settings.js";
import { ApiError } from "../../utils/ApiError.js";
import { pageMeta, paging, slugify } from "../../utils/helpers.js";
import { crudRouter } from "./crud.js";
import { env } from "../../config/env.js";

const r = Router();
const str = (max = 300) => z.string().trim().max(max);
const img = z.string().trim().max(1000);

/* ───────── Coupons ───────── */
const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, "Use 3–30 letters, numbers, - or _"),
  type: z.enum(["Percent", "Flat"]),
  value: z.number().min(1).max(100_000),
  maxDiscount: z.number().int().min(0).default(0),
  minOrder: z.number().int().min(0).default(0),
  appliesTo: z.enum(["All", "Puja", "Store", "Chadhava"]).default("All"),
  limit: z.number().int().min(0).default(0),
  perUser: z.number().int().min(0).default(0),
  expires: z.coerce.date().optional().nullable(),
  active: z.boolean().default(true),
});
r.use(
  "/coupons",
  allow("content", "store"),
  crudRouter(Coupon, {
    name: "Coupon",
    create: couponSchema.refine((c) => c.type !== "Percent" || c.value <= 100, { message: "Percent discount cannot exceed 100", path: ["value"] }),
    update: couponSchema.partial(),
    searchFields: ["code"],
    label: (d) => d.code,
    filters: { active: (v) => ({ active: v === "true" }) },
  }),
);

/* ───────── Banners ───────── */
const bannerSchema = z.object({ title: str(150).min(1), subtitle: str(200).default(""), tagline: str(200).default(""), pujaSlug: str(100).default(""), image: img.min(1, "Choose an image"), link: str(500).default("/"), placement: z.enum(BANNER_PLACEMENTS), active: z.boolean().default(true), order: z.number().int().default(0) });
const bannerRouter = crudRouter(Banner, { name: "Banner", create: bannerSchema, update: bannerSchema.partial(), searchFields: ["title"], sort: { placement: 1, order: 1 }, filters: { placement: (v) => ({ placement: v }) }, label: (d) => d.title });
bannerRouter.post("/reorder", validate({ body: z.object({ ids: z.array(zId).min(1).max(100) }) }), async (req, res) => {
  await Banner.bulkWrite(req.valid.body.ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { order: i + 1 } } } })));
  await audit(req, "Reordered banners", `${req.valid.body.ids.length} banners`);
  res.json({ data: { ok: true } });
});
r.use("/banners", allow("content"), bannerRouter);

/* ───────── Reviews moderation ───────── */
const reviews = Router();
reviews.use(allow("content", "support"));
reviews.get("/", validate({ query: zPage.extend({ status: z.enum(["Pending", "Approved", "Rejected"]).optional(), kind: z.enum(["Puja", "Product", "Chadhava"]).optional() }) }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 200 });
  const f = {};
  if (req.valid.query.status) f.status = req.valid.query.status;
  if (req.valid.query.kind) f.kind = req.valid.query.kind;
  const [items, total] = await Promise.all([Review.find(f).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), Review.countDocuments(f)]);
  res.json({
    data: items.map((x) => ({ id: String(x._id), customer: x.customerName, target: x.target, kind: x.kind, rating: x.rating, text: x.text, status: x.status, featured: x.featured, reply: x.reply, refCode: x.refCode, isDemo: x.isDemo, at: x.createdAt })),
    meta: pageMeta(total, pg),
  });
});

/** Re-computes rating/review count on the product after moderation. */
async function refreshProductRating(review) {
  if (review.kind !== "Product" || !review.targetId) return;
  const [agg] = await Review.aggregate([{ $match: { kind: "Product", targetId: review.targetId, status: "Approved" } }, { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } }]);
  await Product.updateOne({ _id: review.targetId }, { $set: { rating: agg ? Math.round(agg.avg * 10) / 10 : 0, reviews: agg?.n ?? 0 } });
}

reviews.patch("/:id", validate({ params: zIdParam, body: z.object({ status: z.enum(["Pending", "Approved", "Rejected"]).optional(), featured: z.boolean().optional(), reply: str(2000).optional() }) }), async (req, res) => {
  const rv = await Review.findById(req.valid.params.id);
  if (!rv) throw ApiError.notFound("Review not found");
  rv.set(req.valid.body);
  await rv.save();
  await refreshProductRating(rv);
  if (req.valid.body.reply && rv.user) await notifyUser(rv.user, { title: "Rudra Jyoti replied to your review", body: req.valid.body.reply.slice(0, 140), kind: "system", link: "/account/reviews" });
  await audit(req, `Review ${Object.keys(req.valid.body).join(", ")} updated`, rv.target);
  res.json({ data: rv.toJSON() });
});
reviews.delete("/:id", validate({ params: zIdParam }), async (req, res) => {
  const rv = await Review.findByIdAndDelete(req.valid.params.id);
  if (rv) await refreshProductRating(rv);
  await audit(req, "Deleted review", rv?.target);
  res.json({ data: { ok: true } });
});
r.use("/reviews", reviews);

/* ───────── Support tickets ───────── */
const tickets = Router();
tickets.use(allow("support"));
const ticketRow = (t) => ({ id: String(t._id), code: t.code, subject: t.subject, customer: t.customerName, customerId: t.user ? String(t.user) : undefined, channel: t.channel, priority: t.priority, status: t.status, assignee: t.assignee, refCode: t.refCode, at: t.updatedAt, createdAt: t.createdAt, messages: t.messages });
tickets.get("/", validate({ query: zPage.extend({ status: z.enum(["Open", "Pending", "Resolved"]).optional() }) }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 200 });
  const f = req.valid.query.status ? { status: req.valid.query.status } : {};
  const [items, total] = await Promise.all([Ticket.find(f).sort({ updatedAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), Ticket.countDocuments(f)]);
  res.json({ data: items.map(ticketRow), meta: pageMeta(total, pg) });
});
tickets.patch("/:id", validate({ params: zIdParam, body: z.object({ status: z.enum(["Open", "Pending", "Resolved"]).optional(), priority: z.enum(["High", "Medium", "Low"]).optional(), assignee: str(80).optional() }) }), async (req, res) => {
  const t = await Ticket.findByIdAndUpdate(req.valid.params.id, { $set: req.valid.body }, { new: true }).lean();
  if (!t) throw ApiError.notFound("Ticket not found");
  await audit(req, "Updated ticket", t.code);
  res.json({ data: ticketRow(t) });
});
tickets.post("/:id/reply", validate({ params: zIdParam, body: z.object({ text: str(4000).min(1), note: z.boolean().default(false), status: z.enum(["Open", "Pending", "Resolved"]).optional() }) }), async (req, res) => {
  const { text, note, status } = req.valid.body;
  const t = await Ticket.findByIdAndUpdate(req.valid.params.id, { $push: { messages: { from: note ? "note" : "agent", text, by: req.admin.name } }, $set: { status: status ?? (note ? undefined : "Pending") } }, { new: true }).lean();
  if (!t) throw ApiError.notFound("Ticket not found");
  if (!note && t.user) await notifyUser(t.user, { title: `Reply on ${t.code}`, body: text.slice(0, 140), kind: "support", link: "/account/support" });
  res.json({ data: ticketRow(t) });
});
r.use("/tickets", tickets);

/* ───────── CMS: pages, posts, FAQs ───────── */
const pageSchema = z.object({ slug: zSlug, title: str(200).min(1), body: str(100_000).default("") });
r.use("/pages", allow("content"), crudRouter(Page, { name: "Page", create: pageSchema, update: pageSchema.partial(), sort: { title: 1 }, label: (d) => d.title, beforeSave: (b, req) => ({ ...b, updatedBy: req.admin.name }) }));

const postSchema = z.object({ slug: zSlug.optional(), title: str(250).min(3), category: str(60).default("General"), author: str(80).default("Rudra Jyoti"), status: z.enum(["Published", "Draft", "Scheduled"]).default("Draft"), excerpt: str(500).default(""), body: str(200_000).default(""), image: img.default(""), publishAt: z.coerce.date().optional().nullable(), seo: z.object({ title: str(200), desc: str(500) }).partial().optional() });
r.use(
  "/posts",
  allow("content"),
  crudRouter(Post, {
    name: "Post",
    create: postSchema,
    update: postSchema.partial(),
    searchFields: ["title", "category"],
    filters: { status: (v) => ({ status: v }) },
    label: (d) => d.title,
    beforeSave: (b) => ({ ...b, ...(b.slug || !b.title ? {} : { slug: slugify(b.title) }), ...(b.status === "Published" && !b.publishAt ? { publishAt: new Date() } : {}) }),
  }),
);

const faqSchema = z.object({ q: str(500).min(3), a: str(5000).default(""), group: str(60).default("General"), order: z.number().int().default(0), active: z.boolean().default(true) });
r.use("/faqs", allow("content"), crudRouter(Faq, { name: "FAQ", create: faqSchema, update: faqSchema.partial(), searchFields: ["q", "group"], sort: { group: 1, order: 1 }, label: (d) => d.q }));

/* ───────── Home page builder & settings ───────── */
const iconItem = z.object({ icon: str(40), line1: str(80).default(""), line2: str(80).default("") });
const homeSchema = z.object({
  hero: z.object({ line1: str(80), line2: str(80), text: str(500), ctaLabel: str(40), ctaLink: str(300), trust: z.array(iconItem).max(8) }),
  sections: z.array(z.object({ id: z.enum(["quick", "promo", "upcoming", "temples", "products", "chadhava", "why", "reviews", "app"]), title: str(120).default(""), link: str(300).optional(), visible: z.boolean() })).max(20),
  quickLinks: z.array(z.object({ icon: str(40), title: str(60), sub: str(60).default(""), link: str(300) })).max(16),
  upcoming: z.object({ count: z.number().int().min(1).max(20), source: z.enum(["By date", "Featured first"]) }),
  templeSlugs: z.array(zSlug).max(30),
  productTiles: z.array(z.object({ label: str(60), link: str(300), image: img, category: str(60) })).max(20),
  why: z.array(iconItem).max(10),
  bottomNav: z.array(z.object({ icon: str(40), label: str(30), link: str(300) })).min(2).max(6),
});

r.get("/home", allow("content"), async (_req, res) => res.json({ data: await getHome() }));
r.put("/home", allow("content"), validate({ body: homeSchema }), async (req, res) => {
  const value = await setSetting("home", req.valid.body);
  await audit(req, "Updated home page", "Home page builder");
  res.json({ data: value });
});

const siteSchema = z.object({
  brand: z.object({ name: str(80), tagline: str(150), description: str(1000), phone: str(30), whatsapp: z.string().regex(/^\d{10,15}$/, "WhatsApp number: digits only with country code"), email: z.string().email(), supportHours: str(100), address: str(300), logo: img, wordmark: img }).partial(),
  stats: z.object({ pujas: z.number().min(0), devotees: z.number().min(0), temples: z.number().min(0), rating: z.number().min(0).max(5) }).partial(),
  tax: z.object({ gstin: str(20), legalName: str(150), pujaGst: z.number().min(0).max(28), invoicePrefix: str(30) }).partial(),
  shipping: z.object({ freeShippingThreshold: z.number().int().min(0), standardFee: z.number().int().min(0), expressFee: z.number().int().min(0), codEnabled: z.boolean(), codFee: z.number().int().min(0), pickupLocation: str(100) }).partial(),
  notifications: z.record(z.boolean()),
  pageImages: z.record(z.string().trim().max(1000)),
  howItWorks: z.array(z.object({ title: str(80).min(2), desc: str(400).default(""), icon: str(40).default("Sparkles"), image: img.default(""), points: z.array(str(120)).max(4).default([]) })).min(1).max(8),
}).partial();

r.get("/settings", allow(), async (_req, res) => {
  const site = await getSite();
  res.json({ data: { ...site, integrations: integrationStatus() } });
});
r.put("/settings", allow(), validate({ body: siteSchema }), async (req, res) => {
  const current = await getSite();
  const next = { ...current };
  for (const [k, v] of Object.entries(req.valid.body)) next[k] = Array.isArray(v) ? v : { ...(current[k] ?? DEFAULT_SITE[k] ?? {}), ...v };
  const value = await setSetting("site", next);
  await audit(req, "Changed settings", Object.keys(req.valid.body).join(", "));
  res.json({ data: { ...value, integrations: integrationStatus() } });
});

/** Which gateways are configured (secrets stay in .env, never sent to the browser). */
function integrationStatus() {
  const mask = (s) => (s ? `${s.slice(0, 4)}••••${s.slice(-2)}` : "");
  return {
    payments: { provider: env.PAYMENT_PROVIDER, mid: mask(env.PAYTM_MID), website: env.PAYTM_WEBSITE, host: env.PAYTM_HOST, callbackUrl: `${env.API_PUBLIC_URL}/api/v1/payments/paytm/callback` },
    otp: { provider: env.OTP_PROVIDER, customerId: mask(env.MESSAGE_CENTRAL_CUSTOMER_ID), flowType: env.MESSAGE_CENTRAL_FLOW_TYPE, length: env.OTP_LENGTH },
  };
}

/* ───────── Push / in-app campaigns ───────── */
r.get("/push", allow("content"), async (_req, res) => {
  const list = await PushCampaign.find().sort({ at: -1 }).limit(100).lean();
  res.json({ data: list.map((p) => ({ id: String(p._id), title: p.title, body: p.body, link: p.link, segment: p.segment, sent: p.sent, opened: p.opened, at: p.at, by: p.by })) });
});
r.post("/push", allow("content"), validate({ body: z.object({ title: str(120).min(3), body: str(300).default(""), link: str(300).default("/"), segment: z.enum(["All users", "Booked users", "Store buyers"]) }) }), async (req, res) => {
  const { segment } = req.valid.body;
  let ids;
  if (segment === "Booked users") ids = await Booking.distinct("user", { paymentStatus: "Paid" });
  else if (segment === "Store buyers") ids = await Order.distinct("user", { status: { $nin: ["Pending Payment", "Payment Failed"] } });
  else ids = (await User.find({ status: "Active", deletedAt: null }, { _id: 1 }).lean()).map((u) => u._id);
  const active = await User.find({ _id: { $in: ids }, status: "Active", deletedAt: null, "notifPrefs.offers": { $ne: false } }, { _id: 1 }).lean();
  const sent = await broadcast(active.map((u) => u._id), { title: req.valid.body.title, body: req.valid.body.body, link: req.valid.body.link, kind: "offer" });
  const c = await PushCampaign.create({ ...req.valid.body, sent, by: req.admin.name });
  await audit(req, `Sent notification to ${sent} users`, req.valid.body.title);
  res.status(201).json({ data: { id: String(c._id), sent } });
});

/* ───────── Audit log ───────── */
r.get("/audit", allow(), validate({ query: zPage }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 100, max: 500 });
  const [items, total] = await Promise.all([AuditLog.find().sort({ at: -1 }).skip(pg.skip).limit(pg.limit).lean(), AuditLog.countDocuments()]);
  res.json({ data: items.map((a) => ({ id: String(a._id), who: a.who, action: a.action, target: a.target, at: a.at, ip: a.ip })), meta: pageMeta(total, pg) });
});

/* ───────── Media library ───────── */
r.get("/media", validate({ query: zPage.extend({ kind: z.enum(["image", "video"]).optional(), prefix: str(100).optional() }) }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 60, max: 300 });
  const { items, total } = await listMedia({ kind: req.valid.query.kind, prefix: req.valid.query.prefix, skip: pg.skip, limit: pg.limit });
  res.json({ data: items, meta: pageMeta(total, pg) });
});
r.post("/media/images", imageUpload.array("files", 10), async (req, res) => {
  const files = req.files ?? [];
  if (!files.length) throw ApiError.badRequest("Choose at least one image");
  const out = [];
  for (const f of files) out.push(await saveUpload(f, { allow: "image", by: req.admin.email }));
  await audit(req, `Uploaded ${out.length} image(s)`, out.map((o) => o.key).join(", ").slice(0, 280));
  res.status(201).json({ data: out });
});
r.post("/media/video", videoUpload.single("file"), async (req, res) => {
  const out = await saveUpload(req.file, { allow: "video", folder: "uploads/videos", by: req.admin.email });
  await audit(req, "Uploaded video", out.key);
  res.status(201).json({ data: out });
});
r.delete("/media", allow("content", "operations", "store"), validate({ body: z.object({ key: str(300).min(3) }) }), async (req, res) => {
  if (!req.valid.body.key.startsWith("uploads/")) throw ApiError.badRequest("Only uploaded files can be deleted");
  const n = await deleteByKey(req.valid.body.key);
  await audit(req, "Deleted media", req.valid.body.key);
  res.json({ data: { deleted: n } });
});

export default r;
