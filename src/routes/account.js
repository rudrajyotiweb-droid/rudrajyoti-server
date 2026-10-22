import { Router } from "express";
import { z } from "zod";
import { Booking, nextCode, Notification, Order, Product, Review, Ticket } from "../models/index.js";
import { requireUser } from "../middleware/auth.js";
import { validate, zId, zIdParam, zPage, zPhone, zPincode } from "../middleware/validate.js";
import { notifyOrderStatus } from "../services/notify.js";
import { releaseStock } from "../services/payments.js";
import { revokeAllSessions } from "../services/tokens.js";
import { ApiError } from "../utils/ApiError.js";
import { formatPhone, pageMeta, paging } from "../utils/helpers.js";
import { publicProduct } from "./serializers.js";

/** The signed-in user's own profile shape. */
export const me = (u) => ({
  id: String(u._id),
  phone: u.phone,
  phoneDisplay: formatPhone(u.phone),
  name: u.name,
  email: u.email,
  dob: u.dob,
  gotra: u.gotra,
  city: u.city,
  language: u.language,
  family: (u.family ?? []).map((f) => ({ id: String(f._id), name: f.name, relation: f.relation, gotra: f.gotra, dob: f.dob })),
  addresses: (u.addresses ?? []).map((a) => ({ id: String(a._id), label: a.label, name: a.name, line: a.line, city: a.city, state: a.state, pin: a.pin, phone: a.phone, default: !!a.isDefault })),
  wishlist: (u.wishlist ?? []).map(String),
  notifPrefs: u.notifPrefs,
  createdAt: u.createdAt,
});

const r = Router();
r.use(requireUser);

/* ───────── Profile ───────── */
const profileSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(80).optional(),
  email: z.union([z.string().trim().toLowerCase().email("Enter a valid email"), z.literal("")]).optional(),
  dob: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"), z.literal("")]).optional(),
  gotra: z.string().trim().max(60).optional(),
  city: z.string().trim().max(60).optional(),
  language: z.enum(["en", "bn", "hi"]).optional(),
  notifPrefs: z.object({ whatsapp: z.boolean(), sms: z.boolean(), email: z.boolean(), push: z.boolean(), offers: z.boolean() }).partial().optional(),
});

r.get("/profile", (req, res) => res.json({ data: me(req.user) }));

r.patch("/profile", validate({ body: profileSchema }), async (req, res) => {
  const { notifPrefs, ...rest } = req.valid.body;
  req.user.set(rest);
  if (notifPrefs) req.user.notifPrefs = { ...req.user.notifPrefs.toObject?.(), ...notifPrefs };
  await req.user.save();
  res.json({ data: me(req.user) });
});

r.delete("/", async (req, res) => {
  const active = await Booking.countDocuments({ user: req.user._id, status: { $in: ["Booked", "Sankalp Confirmed", "Puja Scheduled"] } });
  if (active) throw ApiError.badRequest("You have upcoming pujas. Please wait until they are completed or contact support.");
  req.user.set({ deletedAt: new Date(), name: "", email: "", family: [], addresses: [], wishlist: [] });
  await req.user.save();
  await revokeAllSessions(req.user._id);
  res.json({ data: { ok: true } });
});

/* ───────── Family members ───────── */
const familySchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(80),
  relation: z.string().trim().max(40).default("Other"),
  gotra: z.string().trim().max(60).default(""),
  dob: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).default(""),
});

r.post("/family", validate({ body: familySchema }), async (req, res) => {
  if (req.user.family.length >= 20) throw ApiError.badRequest("You can save up to 20 family members");
  req.user.family.push(req.valid.body);
  await req.user.save();
  res.status(201).json({ data: me(req.user).family });
});

r.patch("/family/:id", validate({ params: zIdParam, body: familySchema.partial() }), async (req, res) => {
  const m = req.user.family.id(req.valid.params.id);
  if (!m) throw ApiError.notFound("Family member not found");
  m.set(req.valid.body);
  await req.user.save();
  res.json({ data: me(req.user).family });
});

r.delete("/family/:id", validate({ params: zIdParam }), async (req, res) => {
  req.user.family.pull({ _id: req.valid.params.id });
  await req.user.save();
  res.json({ data: me(req.user).family });
});

/* ───────── Addresses ───────── */
const addressSchema = z.object({
  label: z.string().trim().max(30).default("Home"),
  name: z.string().trim().min(2, "Enter the recipient's name").max(80),
  line: z.string().trim().min(5, "Enter the full address").max(250),
  city: z.string().trim().min(2, "Enter the city").max(60),
  state: z.string().trim().min(2, "Enter the state").max(60),
  pin: zPincode,
  phone: zPhone,
  default: z.boolean().optional(),
});

function setDefault(user, id) {
  for (const a of user.addresses) a.isDefault = String(a._id) === String(id);
}

r.post("/addresses", validate({ body: addressSchema }), async (req, res) => {
  if (req.user.addresses.length >= 15) throw ApiError.badRequest("You can save up to 15 addresses");
  const { default: isDefault, ...a } = req.valid.body;
  req.user.addresses.push(a);
  const added = req.user.addresses[req.user.addresses.length - 1];
  if (isDefault || req.user.addresses.length === 1) setDefault(req.user, added._id);
  await req.user.save();
  res.status(201).json({ data: me(req.user).addresses, created: String(added._id) });
});

r.patch("/addresses/:id", validate({ params: zIdParam, body: addressSchema.partial() }), async (req, res) => {
  const a = req.user.addresses.id(req.valid.params.id);
  if (!a) throw ApiError.notFound("Address not found");
  const { default: isDefault, ...rest } = req.valid.body;
  a.set(rest);
  if (isDefault) setDefault(req.user, a._id);
  await req.user.save();
  res.json({ data: me(req.user).addresses });
});

r.delete("/addresses/:id", validate({ params: zIdParam }), async (req, res) => {
  const wasDefault = req.user.addresses.id(req.valid.params.id)?.isDefault;
  req.user.addresses.pull({ _id: req.valid.params.id });
  if (wasDefault && req.user.addresses[0]) req.user.addresses[0].isDefault = true;
  await req.user.save();
  res.json({ data: me(req.user).addresses });
});

/* ───────── Wishlist ───────── */
r.get("/wishlist", async (req, res) => {
  const list = await Product.find({ _id: { $in: req.user.wishlist }, status: "Active" }).lean();
  res.json({ data: list.map(publicProduct) });
});

r.post("/wishlist/toggle", validate({ body: z.object({ slug: z.string().trim().max(100) }) }), async (req, res) => {
  const p = await Product.findOne({ slug: req.valid.body.slug }, { _id: 1 }).lean();
  if (!p) throw ApiError.notFound("Product not found");
  const has = req.user.wishlist.some((x) => String(x) === String(p._id));
  if (has) req.user.wishlist.pull(p._id);
  else req.user.wishlist.addToSet(p._id);
  await req.user.save();
  const slugs = (await Product.find({ _id: { $in: req.user.wishlist } }, { slug: 1 }).lean()).map((x) => x.slug);
  res.json({ data: { added: !has, slugs } });
});

r.post("/wishlist/merge", validate({ body: z.object({ slugs: z.array(z.string().max(100)).max(100) }) }), async (req, res) => {
  const ps = await Product.find({ slug: { $in: req.valid.body.slugs } }, { _id: 1 }).lean();
  for (const p of ps) req.user.wishlist.addToSet(p._id);
  await req.user.save();
  const slugs = (await Product.find({ _id: { $in: req.user.wishlist } }, { slug: 1 }).lean()).map((x) => x.slug);
  res.json({ data: { slugs } });
});

/* ───────── Bookings ───────── */
const bookingView = (b) => ({
  id: String(b._id),
  code: b.code,
  type: b.type,
  slug: b.snapshot?.slug,
  title: b.snapshot?.title,
  image: b.snapshot?.image,
  temple: [b.snapshot?.templeName, b.snapshot?.templeCity].filter(Boolean).join(", "),
  date: b.snapshot?.date,
  pkg: b.type === "puja" ? b.package?.name : b.items.map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(", "),
  package: b.package,
  items: b.items,
  addOns: b.addOns,
  names: b.participants,
  gotra: b.gotra,
  whatsapp: b.whatsapp,
  wish: b.wish,
  box: b.box,
  address: b.address,
  pricing: b.pricing,
  amount: b.pricing?.total,
  status: b.status,
  paymentStatus: b.paymentStatus,
  history: b.history,
  video: b.video?.url,
  shipment: b.shipment,
  createdAt: b.createdAt,
});

r.get("/bookings", validate({ query: zPage.extend({ type: z.enum(["puja", "chadhava"]).optional() }) }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 50 });
  // abandoned checkouts are not shown as bookings
  const filter = { user: req.user._id, status: { $nin: ["Pending Payment", "Payment Failed"] }, ...(req.valid.query.type ? { type: req.valid.query.type } : {}) };
  const [list, total] = await Promise.all([Booking.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), Booking.countDocuments(filter)]);
  res.json({ data: list.map(bookingView), meta: pageMeta(total, pg) });
});

r.get("/bookings/:code", validate({ params: z.object({ code: z.string().max(40) }) }), async (req, res) => {
  const b = await Booking.findOne({ code: req.valid.params.code, user: req.user._id }).lean();
  if (!b) throw ApiError.notFound("Booking not found");
  res.json({ data: bookingView(b) });
});

/* ───────── Orders ───────── */
const orderView = (o) => ({
  id: String(o._id),
  code: o.code,
  date: o.createdAt,
  items: o.items.map((i) => ({ slug: i.slug, name: i.name, image: i.image, qty: i.qty, price: i.price, variant: i.variant })),
  address: o.address,
  delivery: o.delivery,
  pricing: o.pricing,
  total: o.pricing?.total,
  paymentMethod: o.paymentMethod,
  paymentStatus: o.paymentStatus,
  status: o.status,
  history: o.history,
  courier: o.courier,
  awb: o.awb,
  canCancel: ["Placed", "Packed"].includes(o.status),
  canReturn: o.status === "Delivered" && Date.now() - new Date(o.history?.findLast?.((h) => h.status === "Delivered")?.at ?? o.updatedAt).getTime() < 7 * 86_400_000,
});

r.get("/orders", validate({ query: zPage }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 50 });
  const filter = { user: req.user._id, status: { $nin: ["Pending Payment", "Payment Failed"] } };
  const [list, total] = await Promise.all([Order.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), Order.countDocuments(filter)]);
  res.json({ data: list.map(orderView), meta: pageMeta(total, pg) });
});

r.get("/orders/:code", validate({ params: z.object({ code: z.string().max(40) }) }), async (req, res) => {
  const o = await Order.findOne({ code: req.valid.params.code, user: req.user._id }).lean();
  if (!o) throw ApiError.notFound("Order not found");
  res.json({ data: orderView(o) });
});

/** BRD §13.7: cancel until shipped. Prepaid orders are flagged for refund by the admin team. */
r.post("/orders/:code/cancel", validate({ params: z.object({ code: z.string().max(40) }), body: z.object({ reason: z.string().trim().max(300).optional() }) }), async (req, res) => {
  const o = await Order.findOneAndUpdate(
    { code: req.valid.params.code, user: req.user._id, status: { $in: ["Placed", "Packed"] } },
    { $set: { status: "Cancelled", stockReserved: false }, $push: { history: { status: "Cancelled", by: "Customer", note: req.valid.body.reason } } },
    { new: false },
  );
  if (!o) throw ApiError.badRequest("This order can no longer be cancelled");
  if (o.stockReserved) await releaseStock(o.items, o.code, "Cancelled by customer");
  const updated = await Order.findById(o._id).lean();
  await notifyOrderStatus(updated);
  if (o.paymentStatus === "Paid") {
    await Ticket.create({ code: await nextCode("TK"), user: req.user._id, customerName: req.user.name, subject: `Refund for cancelled order ${o.code}`, channel: "App", priority: "High", refCode: o.code, messages: [{ from: "customer", text: `Order cancelled by customer. Reason: ${req.valid.body.reason || "—"}` }] });
  }
  res.json({ data: orderView(updated) });
});

r.post("/orders/:code/return", validate({ params: z.object({ code: z.string().max(40) }), body: z.object({ reason: z.string().trim().min(5, "Please describe the problem").max(500) }) }), async (req, res) => {
  const o = await Order.findOne({ code: req.valid.params.code, user: req.user._id });
  if (!o) throw ApiError.notFound("Order not found");
  if (!orderView(o.toObject()).canReturn) throw ApiError.badRequest("Returns are accepted within 7 days of delivery for damaged or wrong items only");
  o.status = "Return requested";
  o.returnReason = req.valid.body.reason;
  o.history.push({ status: "Return requested", by: "Customer", note: req.valid.body.reason });
  await o.save();
  res.json({ data: orderView(o.toObject()) });
});

/* ───────── Notifications ───────── */
r.get("/notifications", validate({ query: zPage }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 30 });
  const [list, total, unread] = await Promise.all([
    Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    Notification.countDocuments({ user: req.user._id }),
    Notification.countDocuments({ user: req.user._id, read: false }),
  ]);
  res.json({ data: list.map((n) => ({ id: String(n._id), title: n.title, body: n.body, kind: n.kind, link: n.link, unread: !n.read, time: n.createdAt })), meta: { ...pageMeta(total, pg), unread } });
});

r.post("/notifications/read", validate({ body: z.object({ ids: z.array(zId).max(100).optional() }) }), async (req, res) => {
  const filter = { user: req.user._id, ...(req.valid.body.ids?.length ? { _id: { $in: req.valid.body.ids } } : {}) };
  await Notification.updateMany(filter, { $set: { read: true } });
  res.json({ data: { ok: true } });
});

/* ───────── Support tickets ───────── */
r.get("/tickets", async (req, res) => {
  const list = await Ticket.find({ user: req.user._id }).sort({ updatedAt: -1 }).limit(50).lean();
  res.json({ data: list.map((t) => ({ id: t.code, subject: t.subject, status: t.status, updated: t.updatedAt, messages: t.messages.filter((m) => m.from !== "note") })) });
});

r.post("/tickets", validate({ body: z.object({ subject: z.string().trim().min(4, "Subject is too short").max(200), message: z.string().trim().min(5, "Please describe your issue").max(4000), refCode: z.string().trim().max(40).optional() }) }), async (req, res) => {
  const open = await Ticket.countDocuments({ user: req.user._id, status: { $ne: "Resolved" } });
  if (open >= 10) throw ApiError.tooMany("You have too many open tickets. Please wait for our team to respond.");
  const t = await Ticket.create({ code: await nextCode("TK"), user: req.user._id, customerName: req.user.name || req.user.phone, subject: req.valid.body.subject, channel: "App", refCode: req.valid.body.refCode, messages: [{ from: "customer", text: req.valid.body.message }] });
  res.status(201).json({ data: { id: t.code, subject: t.subject, status: t.status, updated: t.updatedAt } });
});

r.post("/tickets/:code/reply", validate({ params: z.object({ code: z.string().max(40) }), body: z.object({ message: z.string().trim().min(1).max(4000) }) }), async (req, res) => {
  const t = await Ticket.findOneAndUpdate({ code: req.valid.params.code, user: req.user._id }, { $push: { messages: { from: "customer", text: req.valid.body.message } }, $set: { status: "Open" } }, { new: true }).lean();
  if (!t) throw ApiError.notFound("Ticket not found");
  res.json({ data: { id: t.code, status: t.status, messages: t.messages.filter((m) => m.from !== "note") } });
});

/* ───────── Reviews (only after a completed booking / delivered order) ───────── */
r.get("/reviews", async (req, res) => {
  const list = await Review.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({ data: list.map((x) => ({ id: String(x._id), target: x.target, kind: x.kind, rating: x.rating, text: x.text, status: x.status, reply: x.reply, date: x.createdAt })) });
});

r.post(
  "/reviews",
  validate({ body: z.object({ refCode: z.string().trim().max(40), productSlug: z.string().max(100).optional(), rating: z.number().int().min(1).max(5), text: z.string().trim().max(2000).default("") }) }),
  async (req, res) => {
    const { refCode, productSlug, rating, text } = req.valid.body;
    let review;
    if (refCode.startsWith("OD")) {
      const o = await Order.findOne({ code: refCode, user: req.user._id, status: "Delivered" }).lean();
      if (!o) throw ApiError.badRequest("You can review products after your order is delivered");
      const line = o.items.find((i) => i.slug === productSlug) ?? o.items[0];
      if (!line) throw ApiError.badRequest("Product not found in this order");
      review = { kind: "Product", targetId: line.product, targetSlug: line.slug, target: line.name };
    } else {
      const b = await Booking.findOne({ code: refCode, user: req.user._id, status: { $in: ["Puja Performed", "Video Shared", "Box Dispatched", "Delivered"] } }).lean();
      if (!b) throw ApiError.badRequest("You can review a puja after it has been performed");
      review = { kind: b.type === "puja" ? "Puja" : "Chadhava", targetId: b.puja ?? b.chadhava, targetSlug: b.snapshot?.slug, target: b.snapshot?.title };
    }
    const dupe = await Review.findOne({ user: req.user._id, refCode, targetId: review.targetId });
    if (dupe) throw ApiError.conflict("You have already reviewed this");
    const created = await Review.create({ ...review, user: req.user._id, customerName: req.user.name || "Devotee", city: req.user.city, refCode, rating, text, status: "Pending" });
    res.status(201).json({ data: { id: String(created._id), status: created.status } });
  },
);

/** Items the user can review now (for the account Reviews page). */
r.get("/reviews/pending", async (req, res) => {
  const [bookings, orders, done] = await Promise.all([
    Booking.find({ user: req.user._id, status: { $in: ["Puja Performed", "Video Shared", "Box Dispatched", "Delivered"] } }, { code: 1, snapshot: 1, type: 1, puja: 1, chadhava: 1 }).sort({ createdAt: -1 }).limit(30).lean(),
    Order.find({ user: req.user._id, status: "Delivered" }, { code: 1, items: 1 }).sort({ createdAt: -1 }).limit(30).lean(),
    Review.find({ user: req.user._id }, { refCode: 1, targetId: 1 }).lean(),
  ]);
  const key = (ref, id) => `${ref}:${id}`;
  const seen = new Set(done.map((d) => key(d.refCode, d.targetId)));
  const out = [
    ...bookings.filter((b) => !seen.has(key(b.code, b.puja ?? b.chadhava))).map((b) => ({ refCode: b.code, title: b.snapshot?.title, image: b.snapshot?.image, kind: b.type === "puja" ? "Puja" : "Chadhava" })),
    ...orders.flatMap((o) => o.items.filter((i) => !seen.has(key(o.code, i.product))).map((i) => ({ refCode: o.code, productSlug: i.slug, title: i.name, image: i.image, kind: "Product" }))),
  ];
  res.json({ data: out });
});

/** Upcoming / recent summary for the account dashboard. */
r.get("/summary", async (req, res) => {
  const live = { $nin: ["Pending Payment", "Payment Failed"] };
  const [upcoming, orders, unread, bookingCount, orderCount, latestVideo] = await Promise.all([
    Booking.find({ user: req.user._id, status: { $in: ["Booked", "Sankalp Confirmed", "Puja Scheduled"] } }).sort({ "snapshot.date": 1 }).limit(5).lean(),
    Order.find({ user: req.user._id, status: live }).sort({ createdAt: -1 }).limit(3).lean(),
    Notification.countDocuments({ user: req.user._id, read: false }),
    Booking.countDocuments({ user: req.user._id, status: live }),
    Order.countDocuments({ user: req.user._id, status: live }),
    Booking.findOne({ user: req.user._id, "video.url": { $exists: true } }).sort({ "video.sharedAt": -1 }).lean(),
  ]);
  res.json({ data: { upcoming: upcoming.map(bookingView), orders: orders.map(orderView), unread, counts: { bookings: bookingCount, orders: orderCount }, latestVideo: latestVideo ? bookingView(latestVideo) : null } });
});


export default r;
