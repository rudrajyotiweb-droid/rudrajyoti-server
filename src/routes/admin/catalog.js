import { Router } from "express";
import { z } from "zod";
import { AddOn, Booking, Category, Chadhava, InventoryLog, Product, Puja, PUBLISH_STATUSES, Temple } from "../../models/index.js";
import { allow } from "../../middleware/auth.js";
import { videoUpload } from "../../middleware/upload.js";
import { validate, zId, zIdParam, zPage, zSlug } from "../../middleware/validate.js";
import { audit } from "../../services/audit.js";
import { saveUpload } from "../../services/media.js";
import { notifyBookingStatus } from "../../services/notify.js";
import { refundPayment } from "../../services/payments.js";
import { ApiError } from "../../utils/ApiError.js";
import { pageMeta, paging, slugify } from "../../utils/helpers.js";
import { logger } from "../../utils/logger.js";
import { crudRouter } from "./crud.js";

const r = Router();

const str = (max = 300) => z.string().trim().max(max);
const img = z.string().trim().max(1000);
const qa = z.object({ q: str(500).default(""), a: str(5000).default("") });
const seo = z.object({ title: str(200).default(""), desc: str(500).default("") });
const date = z.coerce.date();
const ensureSlug = (body, field = "title") => (body.slug || !body[field] ? body : { ...body, slug: slugify(body[field]) });

/* ───────── Temples ───────── */
const templeSchema = z.object({
  slug: zSlug.optional(),
  name: str(150).min(2),
  city: str(80).default(""),
  state: str(80).default(""),
  deity: str(40).default(""),
  image: img.default(""),
  gallery: z.array(img).max(30).default([]),
  short: str(500).default(""),
  history: z.array(str(3000)).max(30).default([]),
  timings: str(200).default(""),
  mapQuery: str(200).default(""),
  coords: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
  active: z.boolean().default(true),
  order: z.number().int().default(0),
  seo: seo.optional(),
});

const templeRouter = crudRouter(Temple, {
  name: "Temple",
  create: templeSchema,
  update: templeSchema.partial(),
  searchFields: ["name", "city", "state", "deity"],
  sort: { order: 1, name: 1 },
  filters: { state: (v) => ({ state: v }), active: (v) => ({ active: v === "true" }) },
  beforeSave: (b) => ensureSlug(b, "name"),
  onDelete: async (doc) => {
    const used = (await Puja.countDocuments({ temple: doc._id })) + (await Chadhava.countDocuments({ temple: doc._id }));
    if (used) throw ApiError.badRequest(`This temple has ${used} puja/chadhava event(s). Deactivate it instead of deleting.`);
    await doc.deleteOne();
  },
});
// counts for the temple table
templeRouter.get("/_stats/counts", async (_req, res) => {
  const rows = await Puja.aggregate([{ $group: { _id: "$temple", n: { $sum: 1 } } }]);
  res.json({ data: Object.fromEntries(rows.map((x) => [String(x._id), x.n])) });
});
r.use("/temples", allow("operations", "content"), templeRouter);

/* ───────── Add-on offerings ───────── */
const addOnSchema = z.object({ key: zSlug.optional(), name: str(100).min(2), price: z.number().int().min(0).max(1_000_000), desc: str(500).default(""), image: img.default(""), active: z.boolean().default(true), order: z.number().int().default(0) });
r.use(
  "/addons",
  allow("operations"),
  crudRouter(AddOn, {
    name: "Add-on",
    create: addOnSchema,
    update: addOnSchema.partial(),
    searchFields: ["name", "key"],
    sort: { order: 1, name: 1 },
    beforeSave: (b, _req, doc) => (doc ? (({ key, ...rest }) => rest)(b) : { ...b, key: b.key || slugify(b.name) }), // key is immutable (pujas reference it)
    onDelete: async (doc) => {
      const used = await Puja.countDocuments({ addOns: doc.key });
      if (used) throw ApiError.badRequest(`Used by ${used} puja(s). Turn it off instead of deleting.`);
      await doc.deleteOne();
    },
  }),
);

/* ───────── Pujas ───────── */
const pkgSchema = z.object({ key: str(60).optional(), id: str(60).optional(), name: str(100).min(2), persons: z.number().int().min(1).max(20), price: z.number().int().min(1).max(1_000_000), strike: z.number().int().min(0).max(2_000_000).optional().nullable(), popular: z.boolean().default(false), desc: str(500).default("") });

const pujaSchema = z.object({
  slug: zSlug.optional(),
  title: str(200).min(3),
  subtitle: str(300).default(""),
  ribbon: str(60).default(""),
  deity: str(40).default(""),
  purposes: z.array(str(40)).max(12).default([]),
  temple: zId.optional().nullable(),
  date,
  cutoff: date,
  tithi: str(200).default(""),
  images: z.array(img).max(30).default([]),
  devotees: z.number().int().min(0).default(0),
  featured: z.boolean().default(false),
  status: z.enum(PUBLISH_STATUSES).default("Draft"),
  about: z.array(qa).max(30).default([]),
  benefits: z.array(z.object({ title: str(200), desc: str(1000).default(""), icon: str(40).default("Sparkles") })).max(20).default([]),
  process: z.array(z.object({ title: str(200), desc: str(1000).default("") })).max(30).default([]),
  faqs: z.array(qa).max(40).default([]),
  packages: z.array(pkgSchema).max(10).default([]),
  addOns: z.array(str(60)).max(30).default([]),
  boxContents: str(1000).default(""),
  seo: seo.optional(),
  bn: z.object({ title: str(200).default(""), subtitle: str(300).default("") }).optional(),
});

/** BRD §7.2 publish checklist — same rules as the admin editor. */
function publishChecklist(p) {
  const missing = [];
  if (!p.title || !p.subtitle) missing.push("Title & purpose");
  if (!p.temple) missing.push("Temple selected");
  if (!p.date || !p.cutoff || new Date(p.cutoff) >= new Date(p.date)) missing.push("Date & booking cutoff (cutoff must be before the puja)");
  if (!p.images?.length) missing.push("At least 1 image");
  if (!p.about?.some((a) => a.q && a.a)) missing.push("About section");
  if ((p.process?.length ?? 0) < 3) missing.push("At least 3 process steps");
  if (!p.packages?.length) missing.push("At least 1 package");
  return missing;
}

const normalizePackages = (pkgs) => pkgs?.map((p) => ({ ...p, key: p.key || p.id || slugify(p.name), id: undefined, strike: p.strike ?? undefined }));

r.use(
  "/pujas",
  allow("operations", "content"),
  (() => {
    const router = crudRouter(Puja, {
      name: "Puja",
      create: pujaSchema,
      update: pujaSchema.partial(),
      searchFields: ["title", "slug", "deity", "tithi"],
      sort: { date: -1 },
      populate: { path: "temple", select: "name slug city" },
      filters: { status: (v) => ({ status: v }), deity: (v) => ({ deity: v }), temple: (v) => ({ temple: v }), featured: (v) => ({ featured: v === "true" }) },
      label: (d) => d.title,
      beforeSave: async (b, _req, doc) => {
        const body = ensureSlug({ ...b, packages: normalizePackages(b.packages) });
        if (!body.packages) delete body.packages;
        if (body.temple && !(await Temple.exists({ _id: body.temple }))) throw ApiError.badRequest("Selected temple does not exist");
        if (body.addOns?.length) {
          const known = await AddOn.countDocuments({ key: { $in: body.addOns } });
          if (known !== new Set(body.addOns).size) throw ApiError.badRequest("One of the selected add-ons does not exist");
        }
        const merged = { ...(doc?.toObject() ?? {}), ...body };
        if (merged.status === "Published") {
          const missing = publishChecklist(merged);
          if (missing.length) throw ApiError.badRequest(`Complete the checklist before publishing: ${missing.join(", ")}`, { code: "CHECKLIST", details: missing });
        }
        return body;
      },
      onDelete: async (doc) => {
        const n = await Booking.countDocuments({ puja: doc._id, paymentStatus: { $in: ["Paid", "Partially refunded"] } });
        if (n) throw ApiError.badRequest(`This puja has ${n} paid booking(s). Cancel it instead of deleting.`);
        await doc.deleteOne();
      },
    });

    router.post("/:id/duplicate", validate({ params: zIdParam }), async (req, res) => {
      const src = await Puja.findById(req.valid.params.id).lean();
      if (!src) throw ApiError.notFound("Puja not found");
      const { _id, createdAt, updatedAt, video, ...rest } = src;
      let slug = `${src.slug}-copy`;
      for (let i = 2; await Puja.exists({ slug }); i++) slug = `${src.slug}-copy-${i}`;
      const week = 7 * 86_400_000;
      const copy = await Puja.create({ ...rest, slug, title: `${src.title} (copy)`, status: "Draft", featured: false, bookingsCount: 0, revenue: 0, date: new Date(+src.date + week), cutoff: new Date(+src.cutoff + week) });
      await audit(req, "Duplicated puja", src.title);
      res.status(201).json({ data: copy.toJSON() });
    });

    /** BRD §13.5: cancelling a puja refunds every paid booking automatically. */
    router.post("/:id/cancel", validate({ params: zIdParam, body: z.object({ reason: str(300).default("Puja could not be performed") }) }), async (req, res) => {
      const puja = await Puja.findById(req.valid.params.id);
      if (!puja) throw ApiError.notFound("Puja not found");
      puja.status = "Cancelled";
      await puja.save();
      const result = await cancelAndRefund({ puja: puja._id }, req.valid.body.reason, req.admin.name);
      await audit(req, `Cancelled puja (refunded ${result.refunded}, failed ${result.failed.length})`, puja.title);
      res.json({ data: result });
    });

    router.post("/:id/video", videoUpload.single("file"), validate({ params: zIdParam, body: z.object({ url: str(1000).optional() }) }), async (req, res) => {
      const puja = await Puja.findById(req.valid.params.id);
      if (!puja) throw ApiError.notFound("Puja not found");
      const url = req.file ? (await saveUpload(req.file, { allow: "video", folder: "uploads/videos", by: req.admin.email })).url : req.valid.body.url;
      if (!url) throw ApiError.badRequest("Upload a video file or paste a video link");
      puja.video = { url, uploadedAt: new Date() };
      await puja.save();
      const shared = await shareVideo({ puja: puja._id }, url, req.admin.name);
      await audit(req, `Uploaded master video (shared with ${shared})`, puja.title);
      res.json({ data: { url, shared } });
    });

    return router;
  })(),
);

/** Sets the video on every paid booking that has not been cancelled and moves it to "Video Shared". */
export async function shareVideo(match, url, by) {
  const list = await Booking.find({ ...match, paymentStatus: { $in: ["Paid", "Partially refunded"] }, status: { $in: ["Booked", "Sankalp Confirmed", "Puja Scheduled", "Puja Performed"] } });
  for (const b of list) {
    b.video = { url, sharedAt: new Date() };
    b.status = "Video Shared";
    b.history.push({ status: "Video Shared", by });
    await b.save();
    await notifyBookingStatus(b);
  }
  // bookings already further along just get the link
  await Booking.updateMany({ ...match, status: { $in: ["Video Shared", "Box Dispatched", "Delivered"] }, "video.url": { $exists: false } }, { $set: { video: { url, sharedAt: new Date() } } });
  return list.length;
}

export async function cancelAndRefund(match, reason, by) {
  const list = await Booking.find({ ...match, status: { $nin: ["Cancelled", "Pending Payment", "Payment Failed"] } });
  let refunded = 0;
  const failed = [];
  for (const b of list) {
    try {
      if (b.payment && ["Paid", "Partially refunded"].includes(b.paymentStatus)) {
        await refundPayment(b.payment, { reason, by });
        refunded++;
      }
      b.status = "Cancelled";
      b.history.push({ status: "Cancelled", by, note: reason });
      await b.save();
      await notifyBookingStatus(b);
    } catch (err) {
      logger.error({ err: err.message, code: b.code }, "Refund on cancel failed");
      failed.push({ code: b.code, error: err.message });
    }
  }
  return { bookings: list.length, refunded, failed };
}

/* ───────── Chadhava ───────── */
const chadhavaItem = z.object({ key: str(60).optional(), id: str(60).optional(), name: str(100).min(2), price: z.number().int().min(1).max(1_000_000), image: img.default(""), desc: str(500).default(""), limit: z.number().int().min(0).default(0), sold: z.number().int().min(0).optional() });
const chadhavaSchema = z.object({
  slug: zSlug.optional(),
  title: str(200).min(3),
  subtitle: str(300).default(""),
  temple: zId.optional().nullable(),
  date,
  cutoff: date.optional().nullable(),
  tithi: str(200).default(""),
  image: img.default(""),
  about: str(5000).default(""),
  items: z.array(chadhavaItem).max(30).default([]),
  devotees: z.number().int().min(0).default(0),
  status: z.enum(PUBLISH_STATUSES).default("Draft"),
});

r.use(
  "/chadhava",
  allow("operations", "content"),
  (() => {
    const router = crudRouter(Chadhava, {
      name: "Chadhava",
      create: chadhavaSchema,
      update: chadhavaSchema.partial(),
      searchFields: ["title", "slug"],
      sort: { date: -1 },
      populate: { path: "temple", select: "name slug city" },
      filters: { status: (v) => ({ status: v }) },
      label: (d) => d.title,
      beforeSave: async (b, _req, doc) => {
        const body = ensureSlug(b);
        if (body.items) {
          const prev = new Map((doc?.items ?? []).map((i) => [i.key, i.sold]));
          body.items = body.items.map((i) => {
            const key = i.key || i.id || slugify(i.name);
            return { ...i, key, id: undefined, sold: prev.get(key) ?? 0 }; // sold is maintained by payments only
          });
        }
        const merged = { ...(doc?.toObject() ?? {}), ...body };
        if (merged.status === "Published" && (!merged.items?.length || !merged.temple || !merged.image)) throw ApiError.badRequest("Add a temple, an image and at least one offering before publishing");
        return body;
      },
      onDelete: async (doc) => {
        const n = await Booking.countDocuments({ chadhava: doc._id, paymentStatus: "Paid" });
        if (n) throw ApiError.badRequest(`This chadhava has ${n} paid booking(s). Cancel it instead of deleting.`);
        await doc.deleteOne();
      },
    });
    router.post("/:id/cancel", validate({ params: zIdParam, body: z.object({ reason: str(300).default("Offering could not be performed") }) }), async (req, res) => {
      const c = await Chadhava.findById(req.valid.params.id);
      if (!c) throw ApiError.notFound("Chadhava not found");
      c.status = "Cancelled";
      await c.save();
      const result = await cancelAndRefund({ chadhava: c._id }, req.valid.body.reason, req.admin.name);
      await audit(req, `Cancelled chadhava (refunded ${result.refunded})`, c.title);
      res.json({ data: result });
    });
    router.post("/:id/video", videoUpload.single("file"), validate({ params: zIdParam, body: z.object({ url: str(1000).optional() }) }), async (req, res) => {
      const c = await Chadhava.findById(req.valid.params.id);
      if (!c) throw ApiError.notFound("Chadhava not found");
      const url = req.file ? (await saveUpload(req.file, { allow: "video", folder: "uploads/videos", by: req.admin.email })).url : req.valid.body.url;
      if (!url) throw ApiError.badRequest("Upload a video file or paste a video link");
      c.video = { url, uploadedAt: new Date() };
      await c.save();
      const shared = await shareVideo({ chadhava: c._id }, url, req.admin.name);
      await audit(req, `Uploaded chadhava video (shared with ${shared})`, c.title);
      res.json({ data: { url, shared } });
    });
    return router;
  })(),
);

/* ───────── Categories ───────── */
const categorySchema = z.object({ slug: zSlug.optional(), name: str(100).min(2), icon: str(40).default("Package"), image: img.default(""), parent: zSlug.optional().nullable(), order: z.number().int().default(0), active: z.boolean().default(true) });
const categoryRouter = crudRouter(Category, {
  name: "Category",
  create: categorySchema,
  update: categorySchema.partial(),
  searchFields: ["name", "slug"],
  sort: { order: 1, name: 1 },
  beforeSave: async (b, _req, doc) => {
    const body = ensureSlug(b, "name");
    if (doc && body.slug && body.slug !== doc.slug) throw ApiError.badRequest("Category slug cannot be changed (products and links use it)");
    if (body.parent && body.parent === (body.slug ?? doc?.slug)) throw ApiError.badRequest("A category cannot be its own parent");
    if (body.parent && !(await Category.exists({ slug: body.parent }))) throw ApiError.badRequest("Parent category not found");
    return body;
  },
  onDelete: async (doc) => {
    const n = (await Product.countDocuments({ category: doc.slug })) + (await Category.countDocuments({ parent: doc.slug }));
    if (n) throw ApiError.badRequest("Move its products and sub-categories first");
    await doc.deleteOne();
  },
});
categoryRouter.get("/_stats/counts", async (_req, res) => {
  const rows = await Product.aggregate([{ $group: { _id: "$category", n: { $sum: 1 } } }]);
  res.json({ data: Object.fromEntries(rows.map((x) => [x._id, x.n])) });
});
r.use("/categories", allow("store"), categoryRouter);

/* ───────── Products ───────── */
const productSchema = z.object({
  slug: zSlug.optional(),
  sku: str(40).min(2),
  name: str(200).min(2),
  category: zSlug,
  price: z.number().int().min(1).max(10_000_000),
  mrp: z.number().int().min(1).max(10_000_000),
  gst: z.number().min(0).max(28).default(12),
  hsn: str(20).default(""),
  stock: z.number().int().min(0).max(1_000_000).default(0),
  lowStock: z.number().int().min(0).max(100_000).default(10),
  images: z.array(img).max(20).default([]),
  short: str(300).default(""),
  description: str(10_000).default(""),
  specs: z.array(z.tuple([str(80), str(300)])).max(40).default([]),
  howToUse: str(3000).default(""),
  variants: z.object({ label: str(40), options: z.array(str(60)).max(30) }).optional().nullable(),
  badge: str(30).default(""),
  bestseller: z.boolean().default(false),
  tags: z.array(str(40)).max(30).default([]),
  weight: z.number().min(0).default(0),
  status: z.enum(["Active", "Draft", "Archived"]).default("Active"),
  seo: seo.optional(),
});

const productRouter = crudRouter(Product, {
  name: "Product",
  create: productSchema,
  update: productSchema.omit({ stock: true }).partial(), // stock changes go through /stock (logged)
  searchFields: ["name", "sku", "slug"],
  sort: { createdAt: -1 },
  filters: { category: (v) => ({ category: v }), status: (v) => ({ status: v }), stock: (v) => (v === "low" ? { $expr: { $lte: ["$stock", "$lowStock"] } } : v === "out" ? { stock: 0 } : {}) },
  beforeSave: async (b) => {
    const body = ensureSlug(b, "name");
    if (body.mrp != null && body.price != null && body.price > body.mrp) throw ApiError.badRequest("Sale price cannot be more than MRP");
    if (body.category && !(await Category.exists({ slug: body.category }))) throw ApiError.badRequest("Category not found");
    if (body.variants === null || (body.variants && !body.variants.options.length)) body.variants = undefined;
    return body;
  },
  afterSave: async (doc, req) => {
    if (req.method === "POST" && doc.stock > 0) await InventoryLog.create({ product: doc._id, delta: doc.stock, stockAfter: doc.stock, reason: "Opening stock", by: req.admin.name });
  },
  onDelete: async (doc) => {
    doc.status = "Archived"; // keep order history intact
    await doc.save();
  },
});

productRouter.post("/:id/stock", validate({ params: zIdParam, body: z.object({ delta: z.number().int().min(-100_000).max(100_000).refine((v) => v !== 0, "Change cannot be zero"), reason: str(200).default("Manual adjustment") }) }), async (req, res) => {
  const { delta, reason } = req.valid.body;
  const p = await Product.findOneAndUpdate({ _id: req.valid.params.id, ...(delta < 0 ? { stock: { $gte: -delta } } : {}) }, { $inc: { stock: delta } }, { new: true });
  if (!p) throw ApiError.badRequest("Stock cannot go below zero");
  await InventoryLog.create({ product: p._id, delta, stockAfter: p.stock, reason, by: req.admin.name });
  await audit(req, `Stock adjusted ${delta > 0 ? "+" : ""}${delta}`, p.name);
  res.json({ data: p.toJSON() });
});
r.use("/products", allow("store"), productRouter);

r.get("/inventory/logs", allow("store"), validate({ query: zPage.extend({ product: zId.optional() }) }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 100 });
  const filter = req.valid.query.product ? { product: req.valid.query.product } : {};
  const [items, total] = await Promise.all([InventoryLog.find(filter).sort({ at: -1 }).skip(pg.skip).limit(pg.limit).populate("product", "name sku").lean(), InventoryLog.countDocuments(filter)]);
  res.json({ data: items.map((l) => ({ id: String(l._id), product: l.product ? { id: String(l.product._id), name: l.product.name, sku: l.product.sku } : null, delta: l.delta, stockAfter: l.stockAfter, reason: l.reason, ref: l.ref, by: l.by, at: l.at })), meta: pageMeta(total, pg) });
});

export default r;
