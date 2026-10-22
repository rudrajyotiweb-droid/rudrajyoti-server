import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { AddOn, Banner, Category, Chadhava, Faq, Page, Post, Product, Puja, Review, Temple } from "../models/index.js";
import { Types } from "mongoose";
import { validate, zPage, zSlug } from "../middleware/validate.js";
import { getHome, getSite } from "../services/settings.js";
import { ApiError } from "../utils/ApiError.js";
import { escapeRegex, pageMeta, paging } from "../utils/helpers.js";
import { publicAddOn, publicCategory, publicChadhava, publicProduct, publicPuja, publicPujaCard, publicReview, publicTemple, templeCard } from "./serializers.js";

const r = Router();

const LIVE = ["Published", "Closed", "Completed"]; // visible on the website
const TEMPLE_FIELDS = "slug name city state deity image short";
const reviewFilter = () => ({ status: "Approved", ...(env.isProd ? { isDemo: { $ne: true } } : {}) });

/** Short public caching — safe for catalog data, CDN-friendly. */
const cache = (seconds) => (_req, res, next) => {
  res.setHeader("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=${seconds * 4}`);
  next();
};

/* ───────── Site settings ───────── */
r.get("/site", cache(60), async (_req, res) => {
  const [site, home] = await Promise.all([getSite(), getHome()]);
  res.json({ data: { brand: site.brand, stats: site.stats, shipping: site.shipping, tax: { pujaGst: site.tax?.pujaGst ?? 18 }, bottomNav: home.bottomNav ?? [], pageImages: site.pageImages, howItWorks: site.howItWorks } });
});

/* ───────── Home page (one call renders the whole page) ───────── */
r.get("/home", cache(30), async (_req, res) => {
  const [home, site, banners, temples, chadhavas, reviews, minPrices] = await Promise.all([
    getHome(),
    getSite(),
    Banner.find({ placement: { $in: ["Home hero", "Home promo"] }, active: true }).sort({ order: 1 }).lean(),
    Temple.find({ active: true }).sort({ order: 1, name: 1 }).lean(),
    Chadhava.find({ status: "Published", date: { $gte: new Date(Date.now() - 86_400_000) } }).sort({ date: 1 }).limit(8).populate("temple", TEMPLE_FIELDS).lean(),
    Review.find({ ...reviewFilter(), kind: { $in: ["Puja", "Chadhava"] } }).sort({ featured: -1, createdAt: -1 }).limit(8).lean(),
    Product.aggregate([{ $match: { status: "Active" } }, { $group: { _id: "$category", min: { $min: "$price" } } }]),
  ]);

  const count = Math.min(20, Math.max(1, home.upcoming?.count ?? 8));
  const sort = home.upcoming?.source === "Featured first" ? { featured: -1, date: 1 } : { date: 1 };
  const upcoming = await Puja.find({ status: "Published", date: { $gte: new Date() } }).sort(sort).limit(count).populate("temple", TEMPLE_FIELDS).lean();

  const priceByCat = Object.fromEntries(minPrices.map((m) => [m._id, m.min]));
  const templeBySlug = new Map(temples.map((t) => [t.slug, t]));
  const picked = (home.templeSlugs?.length ? home.templeSlugs.map((s) => templeBySlug.get(s)).filter(Boolean) : temples).map(publicTemple);

  res.json({
    data: {
      ...home,
      heroSlides: banners.filter((b) => b.placement === "Home hero").map((b) => ({ id: String(b._id), image: b.image, caption: b.title, link: b.link })),
      promos: banners.filter((b) => b.placement === "Home promo").map((b) => ({ id: String(b._id), title: b.title, subtitle: b.subtitle, tagline: b.tagline, pujaSlug: b.pujaSlug, image: b.image, link: b.link })),
      productTiles: (home.productTiles ?? []).map((t) => ({ ...t, fromPrice: priceByCat[t.category] ?? null })),
      upcomingPujas: upcoming.map(publicPujaCard),
      temples: picked,
      chadhavas: chadhavas.map((c) => publicChadhava(c, false)),
      reviews: reviews.map(publicReview),
      stats: site.stats,
    },
  });
});

r.get("/banners", cache(60), validate({ query: z.object({ placement: z.enum(["Home hero", "Home promo", "Puja listing", "Store"]).optional() }) }), async (req, res) => {
  const q = { active: true, ...(req.valid.query.placement ? { placement: req.valid.query.placement } : {}) };
  const list = await Banner.find(q).sort({ placement: 1, order: 1 }).lean();
  res.json({ data: list.map((b) => ({ id: String(b._id), title: b.title, subtitle: b.subtitle, tagline: b.tagline, pujaSlug: b.pujaSlug, image: b.image, link: b.link, placement: b.placement })) });
});

/* ───────── Temples ───────── */
r.get("/temples", cache(60), validate({ query: zPage.extend({ state: z.string().max(60).optional(), deity: z.string().max(40).optional() }) }), async (req, res) => {
  const { q, state, deity } = req.valid.query;
  const filter = { active: true };
  if (state) filter.state = state;
  if (deity) filter.deity = deity;
  if (q) filter.$or = [{ name: { $regex: escapeRegex(q), $options: "i" } }, { city: { $regex: escapeRegex(q), $options: "i" } }];
  const list = await Temple.find(filter).sort({ order: 1, name: 1 }).lean();
  res.json({ data: list.map(publicTemple) });
});

r.get("/temples/:slug", cache(60), validate({ params: z.object({ slug: zSlug }) }), async (req, res) => {
  const t = await Temple.findOne({ slug: req.valid.params.slug, active: true }).lean();
  if (!t) throw ApiError.notFound("Temple not found");
  const [pujas, chadhavas] = await Promise.all([
    Puja.find({ temple: t._id, status: "Published", date: { $gte: new Date() } }).sort({ date: 1 }).limit(12).populate("temple", TEMPLE_FIELDS).lean(),
    Chadhava.find({ temple: t._id, status: "Published", date: { $gte: new Date() } }).sort({ date: 1 }).limit(12).populate("temple", TEMPLE_FIELDS).lean(),
  ]);
  res.json({ data: { ...publicTemple(t), pujas: pujas.map(publicPujaCard), chadhavas: chadhavas.map((c) => publicChadhava(c, false)) } });
});

/* ───────── Pujas ───────── */
const pujaQuery = zPage.extend({
  deity: z.string().max(40).optional(),
  purpose: z.string().max(40).optional(),
  temple: z.string().max(100).optional(),
  featured: z.enum(["true", "false"]).optional(),
  include: z.enum(["upcoming", "all"]).optional(),
  sort: z.enum(["date", "popular", "price"]).optional(),
});

r.get("/pujas", cache(30), validate({ query: pujaQuery }), async (req, res) => {
  const { q, deity, purpose, temple, featured, include = "upcoming", sort = "date" } = req.valid.query;
  const pg = paging(req.valid.query, { def: 50, max: 100 });
  const filter = include === "all" ? { status: { $in: LIVE } } : { status: { $in: ["Published", "Closed"] }, date: { $gte: new Date() } };
  if (deity) filter.deity = deity;
  if (purpose) filter.purposes = purpose;
  if (featured === "true") filter.featured = true;
  if (temple) {
    const t = await Temple.findOne({ slug: temple }, { _id: 1 }).lean();
    filter.temple = t?._id ?? new Types.ObjectId(); // unknown slug → no results
  }
  if (q) filter.$or = [{ title: { $regex: escapeRegex(q), $options: "i" } }, { subtitle: { $regex: escapeRegex(q), $options: "i" } }, { deity: { $regex: escapeRegex(q), $options: "i" } }];

  const sortBy = sort === "popular" ? { devotees: -1 } : sort === "price" ? { "packages.0.price": 1 } : { date: 1 };
  const [list, total] = await Promise.all([Puja.find(filter).sort(sortBy).skip(pg.skip).limit(pg.limit).populate("temple", TEMPLE_FIELDS).lean(), Puja.countDocuments(filter)]);
  res.json({ data: list.map(publicPujaCard), meta: pageMeta(total, pg) });
});

r.get("/pujas/:slug", cache(20), validate({ params: z.object({ slug: zSlug }) }), async (req, res) => {
  const p = await Puja.findOne({ slug: req.valid.params.slug, status: { $in: LIVE } }).populate("temple").lean();
  if (!p) throw ApiError.notFound("Puja not found");
  const [addOns, reviews, related] = await Promise.all([
    AddOn.find({ key: { $in: p.addOns ?? [] } }).lean(),
    Review.find({ ...reviewFilter(), kind: "Puja", targetId: p._id }).sort({ featured: -1, createdAt: -1 }).limit(10).lean(),
    Puja.find({ _id: { $ne: p._id }, status: "Published", date: { $gte: new Date() } }).sort({ date: 1 }).limit(6).populate("temple", TEMPLE_FIELDS).lean(),
  ]);
  const data = publicPuja(p, addOns);
  data.temple = p.temple ? publicTemple(p.temple) : null;
  res.json({ data: { ...data, reviews: reviews.map(publicReview), related: related.map(publicPujaCard) } });
});

r.get("/addons", cache(60), async (_req, res) => {
  const list = await AddOn.find({ active: true }).sort({ order: 1, name: 1 }).lean();
  res.json({ data: list.map(publicAddOn) });
});

/* ───────── Chadhava ───────── */
r.get("/chadhava", cache(30), validate({ query: zPage.extend({ temple: z.string().max(100).optional() }) }), async (req, res) => {
  const filter = { status: { $in: ["Published", "Closed"] }, date: { $gte: new Date(Date.now() - 86_400_000) } };
  if (req.valid.query.temple) {
    const t = await Temple.findOne({ slug: req.valid.query.temple }, { _id: 1 }).lean();
    filter.temple = t?._id ?? new Types.ObjectId(); // unknown slug → no results
  }
  const list = await Chadhava.find(filter).sort({ date: 1 }).populate("temple", TEMPLE_FIELDS).lean();
  res.json({ data: list.map((c) => publicChadhava(c, true)) });
});

r.get("/chadhava/:slug", cache(20), validate({ params: z.object({ slug: zSlug }) }), async (req, res) => {
  const c = await Chadhava.findOne({ slug: req.valid.params.slug, status: { $in: LIVE } }).populate("temple").lean();
  if (!c) throw ApiError.notFound("Chadhava not found");
  const data = publicChadhava(c, true);
  data.temple = c.temple ? publicTemple(c.temple) : null;
  res.json({ data });
});

/* ───────── Store ───────── */
r.get("/categories", cache(60), async (_req, res) => {
  const [cats, counts] = await Promise.all([Category.find({ active: true }).sort({ order: 1, name: 1 }).lean(), Product.aggregate([{ $match: { status: "Active" } }, { $group: { _id: "$category", n: { $sum: 1 }, min: { $min: "$price" } } }])]);
  const by = Object.fromEntries(counts.map((c) => [c._id, c]));
  res.json({ data: cats.map((c) => ({ ...publicCategory(c), products: by[c.slug]?.n ?? 0, fromPrice: by[c.slug]?.min ?? null })) });
});

const productQuery = zPage.extend({
  category: z.string().max(60).optional(),
  min: z.coerce.number().min(0).optional(),
  max: z.coerce.number().min(0).optional(),
  inStock: z.enum(["true", "false"]).optional(),
  bestseller: z.enum(["true", "false"]).optional(),
  slugs: z.string().max(3000).optional(), // comma-separated, for cart / wishlist
  sort: z.enum(["popular", "price-asc", "price-desc", "rating", "new"]).optional(),
});

r.get("/products", cache(30), validate({ query: productQuery }), async (req, res) => {
  const { q, category, min, max, inStock, bestseller, slugs, sort = "popular" } = req.valid.query;
  const pg = paging(req.valid.query, { def: 48, max: 200 });
  const filter = { status: "Active" };
  if (category) {
    const children = await Category.find({ parent: category }, { slug: 1 }).lean();
    filter.category = { $in: [category, ...children.map((c) => c.slug)] };
  }
  if (min != null || max != null) filter.price = { ...(min != null ? { $gte: min } : {}), ...(max != null ? { $lte: max } : {}) };
  if (inStock === "true") filter.stock = { $gt: 0 };
  if (bestseller === "true") filter.bestseller = true;
  if (slugs) filter.slug = { $in: slugs.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100) };
  if (q) filter.$or = [{ name: { $regex: escapeRegex(q), $options: "i" } }, { short: { $regex: escapeRegex(q), $options: "i" } }, { tags: { $regex: escapeRegex(q), $options: "i" } }];
  const sortBy = { popular: { bestseller: -1, sold: -1 }, "price-asc": { price: 1 }, "price-desc": { price: -1 }, rating: { rating: -1 }, new: { createdAt: -1 } }[sort];
  const [list, total] = await Promise.all([Product.find(filter).sort(sortBy).skip(pg.skip).limit(pg.limit).lean(), Product.countDocuments(filter)]);
  res.json({ data: list.map(publicProduct), meta: pageMeta(total, pg) });
});

r.get("/products/:slug", cache(20), validate({ params: z.object({ slug: zSlug }) }), async (req, res) => {
  const p = await Product.findOne({ slug: req.valid.params.slug, status: "Active" }).lean();
  if (!p) throw ApiError.notFound("Product not found");
  const [related, reviews] = await Promise.all([
    Product.find({ category: p.category, _id: { $ne: p._id }, status: "Active" }).sort({ sold: -1 }).limit(8).lean(),
    Review.find({ ...reviewFilter(), kind: "Product", targetId: p._id }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  res.json({ data: { ...publicProduct(p), related: related.map(publicProduct), reviewList: reviews.map(publicReview) } });
});

/* ───────── Reviews / content ───────── */
r.get("/reviews", cache(60), validate({ query: z.object({ kind: z.enum(["Puja", "Product", "Chadhava"]).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }) }), async (req, res) => {
  const list = await Review.find({ ...reviewFilter(), ...(req.valid.query.kind ? { kind: req.valid.query.kind } : {}) })
    .sort({ featured: -1, createdAt: -1 })
    .limit(req.valid.query.limit ?? 12)
    .lean();
  res.json({ data: list.map(publicReview) });
});

r.get("/faqs", cache(120), async (_req, res) => {
  const list = await Faq.find({ active: true }).sort({ group: 1, order: 1 }).lean();
  res.json({ data: list.map((f) => ({ id: String(f._id), q: f.q, a: f.a, group: f.group })) });
});

r.get("/pages/:slug", cache(120), validate({ params: z.object({ slug: zSlug }) }), async (req, res) => {
  const p = await Page.findOne({ slug: req.valid.params.slug }).lean();
  if (!p) throw ApiError.notFound("Page not found");
  res.json({ data: { slug: p.slug, title: p.title, body: p.body, updatedAt: p.updatedAt } });
});

r.get("/posts", cache(60), validate({ query: zPage }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 12 });
  const filter = { status: "Published" };
  const [list, total] = await Promise.all([Post.find(filter, { body: 0 }).sort({ publishAt: -1, createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), Post.countDocuments(filter)]);
  res.json({ data: list.map((p) => ({ id: String(p._id), slug: p.slug, title: p.title, category: p.category, excerpt: p.excerpt, image: p.image, author: p.author, date: p.publishAt ?? p.createdAt })), meta: pageMeta(total, pg) });
});

r.get("/posts/:slug", cache(60), validate({ params: z.object({ slug: zSlug }) }), async (req, res) => {
  const p = await Post.findOneAndUpdate({ slug: req.valid.params.slug, status: "Published" }, { $inc: { views: 1 } }, { new: true }).lean();
  if (!p) throw ApiError.notFound("Post not found");
  res.json({ data: { id: String(p._id), slug: p.slug, title: p.title, category: p.category, body: p.body, image: p.image, author: p.author, date: p.publishAt ?? p.createdAt, seo: p.seo } });
});

/* ───────── Search (header overlay) ───────── */
r.get("/search", validate({ query: z.object({ q: z.string().trim().min(1).max(80) }) }), async (req, res) => {
  const rx = { $regex: escapeRegex(req.valid.query.q), $options: "i" };
  const [pujas, products, temples] = await Promise.all([
    Puja.find({ status: { $in: ["Published", "Closed"] }, $or: [{ title: rx }, { deity: rx }, { subtitle: rx }] }).sort({ date: 1 }).limit(6).populate("temple", TEMPLE_FIELDS).lean(),
    Product.find({ status: "Active", $or: [{ name: rx }, { short: rx }] }).limit(6).lean(),
    Temple.find({ active: true, $or: [{ name: rx }, { city: rx }, { deity: rx }] }).limit(6).lean(),
  ]);
  res.json({ data: { pujas: pujas.map(publicPujaCard), products: products.map(publicProduct), temples: temples.map(templeCard) } });
});

export default r;
