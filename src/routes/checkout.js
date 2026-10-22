import { Router } from "express";
import { z } from "zod";
import { AddOn, Booking, Chadhava, Coupon, CouponRedemption, nextCode, Order, Product, Puja } from "../models/index.js";
import { requireUser } from "../middleware/auth.js";
import { paymentLimiter } from "../middleware/security.js";
import { validate, zId, zPhone, zPincode } from "../middleware/validate.js";
import { notifyOrderStatus } from "../services/notify.js";
import { createCodPayment, releaseStock, reserveStock, startPayment } from "../services/payments.js";
import { applyCoupon } from "../services/pricing.js";
import { getSite } from "../services/settings.js";
import { ApiError } from "../utils/ApiError.js";

const r = Router();
r.use(requireUser, paymentLimiter);

const KASHYAP = "Kashyap";

const inlineAddress = z.object({
  label: z.string().trim().max(30).default("Home"),
  name: z.string().trim().min(2).max(80),
  line: z.string().trim().min(5).max(250),
  city: z.string().trim().min(2).max(60),
  state: z.string().trim().min(2).max(60),
  pin: zPincode,
  phone: zPhone,
});

/** Resolve the delivery address from a saved address id or an inline address. */
function resolveAddress(user, addressId, address) {
  if (addressId) {
    const a = user.addresses.id(addressId);
    if (!a) throw ApiError.badRequest("Please choose a delivery address", { code: "ADDRESS_REQUIRED" });
    return { label: a.label, name: a.name, line: a.line, city: a.city, state: a.state, pin: a.pin, phone: a.phone };
  }
  if (address) return address;
  throw ApiError.badRequest("Please choose a delivery address", { code: "ADDRESS_REQUIRED" });
}

async function guardPendingSpam(userId) {
  const since = new Date(Date.now() - 3_600_000);
  const n = (await Booking.countDocuments({ user: userId, status: "Pending Payment", createdAt: { $gte: since } })) + (await Order.countDocuments({ user: userId, status: "Pending Payment", createdAt: { $gte: since } }));
  if (n >= 15) throw ApiError.tooMany("Too many unfinished checkouts. Please complete or wait before trying again.");
}

/* ───────── Coupon check (display only; the server re-checks on payment) ───────── */
r.post("/coupon", validate({ body: z.object({ code: z.string().trim().min(2).max(30), kind: z.enum(["Puja", "Chadhava", "Store"]), subtotal: z.number().int().min(0).max(10_000_000) }) }), async (req, res) => {
  const { code, kind, subtotal } = req.valid.body;
  const { coupon, discount } = await applyCoupon({ code, kind, subtotal, userId: req.user._id });
  res.json({ data: { code: coupon.code, type: coupon.type, value: coupon.value, discount } });
});

/* ───────── Puja booking ───────── */
const pujaBody = z.object({
  pujaSlug: z.string().trim().max(100),
  packageId: z.string().trim().max(60),
  participants: z.array(z.string().trim().min(2, "Each name must have at least 2 letters").max(80)).min(1).max(20),
  gotra: z.string().trim().max(60).default(""),
  unknownGotra: z.boolean().default(false),
  whatsapp: zPhone,
  wish: z.string().trim().max(250).default(""),
  box: z.boolean().default(false),
  addressId: zId.optional(),
  address: inlineAddress.optional(),
  addOns: z.array(z.object({ id: z.string().max(60), qty: z.number().int().min(1).max(10) })).max(20).default([]),
  coupon: z.string().trim().max(30).optional(),
});

r.post("/puja", validate({ body: pujaBody }), async (req, res) => {
  const b = req.valid.body;
  await guardPendingSpam(req.user._id);

  const puja = await Puja.findOne({ slug: b.pujaSlug }).populate("temple", "name city").lean();
  if (!puja || !["Published", "Closed"].includes(puja.status)) throw ApiError.notFound("Puja not found");
  if (puja.status !== "Published" || new Date(puja.cutoff) <= new Date()) throw ApiError.badRequest("Booking for this puja has closed", { code: "BOOKING_CLOSED" });

  const pkg = puja.packages.find((p) => p.key === b.packageId);
  if (!pkg) throw ApiError.badRequest("Please choose a valid package");
  if (b.participants.length !== pkg.persons) throw ApiError.badRequest(`This package needs exactly ${pkg.persons} name${pkg.persons > 1 ? "s" : ""} for the sankalp`);
  if (!b.unknownGotra && b.gotra.length < 2) throw ApiError.badRequest("Please enter your gotra, or tick “I don't know my gotra”");

  const allowed = new Set(puja.addOns ?? []);
  const master = await AddOn.find({ key: { $in: b.addOns.map((a) => a.id) }, active: true }).lean();
  const addOns = b.addOns.map((a) => {
    const m = master.find((x) => x.key === a.id);
    if (!m || !allowed.has(a.id)) throw ApiError.badRequest("One of the selected offerings is no longer available");
    return { key: m.key, name: m.name, price: m.price, qty: a.qty };
  });

  const addOnTotal = addOns.reduce((t, a) => t + a.price * a.qty, 0);
  const subtotal = pkg.price + addOnTotal;
  const { coupon, discount } = await applyCoupon({ code: b.coupon, kind: "Puja", subtotal, userId: req.user._id });
  const address = b.box ? resolveAddress(req.user, b.addressId, b.address) : undefined;

  const booking = await Booking.create({
    code: await nextCode("RJ"),
    type: "puja",
    user: req.user._id,
    puja: puja._id,
    snapshot: { title: puja.title, slug: puja.slug, image: puja.images?.[0], templeName: puja.temple?.name, templeCity: puja.temple?.city, date: puja.date },
    customerName: req.user.name || b.participants[0],
    customerPhone: req.user.phone,
    package: { key: pkg.key, name: pkg.name, persons: pkg.persons, price: pkg.price },
    addOns,
    participants: b.participants,
    gotra: b.unknownGotra ? KASHYAP : b.gotra,
    unknownGotra: b.unknownGotra,
    whatsapp: b.whatsapp,
    wish: b.wish,
    box: b.box,
    address,
    pricing: { subtotal, addOns: addOnTotal, discount, total: subtotal - discount, coupon: coupon?.code },
    history: [{ status: "Pending Payment", by: "Customer" }],
  });

  if (!req.user.name) {
    req.user.name = b.participants[0];
    await req.user.save().catch(() => {});
  }

  const checkout = await startPayment({ kind: "Puja", refType: "Booking", doc: booking, user: req.user });
  res.status(201).json({ data: { code: booking.code, amount: booking.pricing.total, checkout } });
});

/* ───────── Chadhava booking ───────── */
const chadhavaBody = z.object({
  slug: z.string().trim().max(100),
  items: z.array(z.object({ id: z.string().max(60), qty: z.number().int().min(1).max(21) })).min(1, "Choose at least one offering").max(30),
  name: z.string().trim().min(2, "Enter the devotee's name").max(80),
  gotra: z.string().trim().max(60).default(""),
  unknownGotra: z.boolean().default(false),
  whatsapp: zPhone,
  wish: z.string().trim().max(250).default(""),
  coupon: z.string().trim().max(30).optional(),
});

r.post("/chadhava", validate({ body: chadhavaBody }), async (req, res) => {
  const b = req.valid.body;
  await guardPendingSpam(req.user._id);
  const c = await Chadhava.findOne({ slug: b.slug }).populate("temple", "name city").lean();
  if (!c || !["Published", "Closed"].includes(c.status)) throw ApiError.notFound("Chadhava not found");
  if (c.status !== "Published" || new Date(c.cutoff ?? c.date) <= new Date()) throw ApiError.badRequest("Offerings for this chadhava have closed", { code: "BOOKING_CLOSED" });
  if (!b.unknownGotra && b.gotra.length < 2) throw ApiError.badRequest("Please enter your gotra, or tick “I don't know my gotra”");

  const items = b.items.map((x) => {
    const it = c.items.find((i) => i.key === x.id);
    if (!it) throw ApiError.badRequest("One of the selected offerings is no longer available");
    if (it.limit > 0 && it.sold + x.qty > it.limit) throw ApiError.badRequest(`Only ${Math.max(0, it.limit - it.sold)} left for ${it.name}`);
    return { key: it.key, name: it.name, price: it.price, qty: x.qty };
  });
  const subtotal = items.reduce((t, i) => t + i.price * i.qty, 0);
  const { coupon, discount } = await applyCoupon({ code: b.coupon, kind: "Chadhava", subtotal, userId: req.user._id });

  const booking = await Booking.create({
    code: await nextCode("RC"),
    type: "chadhava",
    user: req.user._id,
    chadhava: c._id,
    snapshot: { title: c.title, slug: c.slug, image: c.image, templeName: c.temple?.name, templeCity: c.temple?.city, date: c.date },
    customerName: req.user.name || b.name,
    customerPhone: req.user.phone,
    items,
    participants: [b.name],
    gotra: b.unknownGotra ? KASHYAP : b.gotra,
    unknownGotra: b.unknownGotra,
    whatsapp: b.whatsapp,
    wish: b.wish,
    pricing: { subtotal, addOns: 0, discount, total: subtotal - discount, coupon: coupon?.code },
    history: [{ status: "Pending Payment", by: "Customer" }],
  });

  const checkout = await startPayment({ kind: "Chadhava", refType: "Booking", doc: booking, user: req.user });
  res.status(201).json({ data: { code: booking.code, amount: booking.pricing.total, checkout } });
});

/* ───────── Store order ───────── */
const orderBody = z.object({
  items: z.array(z.object({ slug: z.string().max(100), variant: z.string().max(60).optional(), qty: z.number().int().min(1).max(10) })).min(1, "Your cart is empty").max(50),
  addressId: zId.optional(),
  address: inlineAddress.optional(),
  delivery: z.enum(["standard", "express"]).default("standard"),
  payment: z.enum(["online", "cod"]).default("online"),
  coupon: z.string().trim().max(30).optional(),
});

r.post("/order", validate({ body: orderBody }), async (req, res) => {
  const b = req.valid.body;
  await guardPendingSpam(req.user._id);
  const site = await getSite();
  const ship = site.shipping;
  if (b.payment === "cod" && !ship.codEnabled) throw ApiError.badRequest("Cash on delivery is not available right now");

  const products = await Product.find({ slug: { $in: b.items.map((i) => i.slug) } }).lean();
  // merge duplicate lines (same product + variant)
  const merged = new Map();
  for (const it of b.items) {
    const k = `${it.slug}|${it.variant ?? ""}`;
    merged.set(k, { ...it, qty: Math.min(10, (merged.get(k)?.qty ?? 0) + it.qty) });
  }
  const items = [...merged.values()].map((it) => {
    const p = products.find((x) => x.slug === it.slug);
    if (!p || p.status !== "Active") throw ApiError.badRequest(`“${p?.name ?? it.slug}” is no longer available`, { code: "PRODUCT_UNAVAILABLE", details: { slug: it.slug } });
    if (p.variants?.options?.length && it.variant && !p.variants.options.includes(it.variant)) throw ApiError.badRequest(`Choose a valid ${p.variants.label?.toLowerCase() || "option"} for ${p.name}`);
    if (p.stock < it.qty) throw ApiError.conflict(p.stock > 0 ? `Only ${p.stock} left of “${p.name}”` : `“${p.name}” is out of stock`, { code: "OUT_OF_STOCK", details: { slug: p.slug, stock: p.stock } });
    return { product: p._id, slug: p.slug, name: p.name, image: p.images?.[0], variant: it.variant ?? (p.variants?.options?.[0] || undefined), qty: it.qty, price: p.price, gst: p.gst };
  });

  const subtotal = items.reduce((t, i) => t + i.price * i.qty, 0);
  const { coupon, discount } = await applyCoupon({ code: b.coupon, kind: "Store", subtotal, userId: req.user._id });
  const shipping = (subtotal - discount >= ship.freeShippingThreshold ? 0 : ship.standardFee) + (b.delivery === "express" ? ship.expressFee : 0);
  const codFee = b.payment === "cod" ? ship.codFee : 0;
  const total = subtotal - discount + shipping + codFee;
  const address = resolveAddress(req.user, b.addressId, b.address);

  const code = await nextCode("OD");
  if (!(await reserveStock(items, code))) throw ApiError.conflict("Some items just went out of stock. Please review your cart.", { code: "OUT_OF_STOCK" });

  let order;
  try {
    order = await Order.create({
      code,
      user: req.user._id,
      customerName: req.user.name || address.name,
      customerPhone: req.user.phone,
      items,
      address,
      delivery: b.delivery,
      pricing: { subtotal, shipping, codFee, discount, total, coupon: coupon?.code },
      paymentMethod: b.payment === "cod" ? "COD" : "Prepaid",
      status: b.payment === "cod" ? "Placed" : "Pending Payment",
      stockReserved: true,
      history: [{ status: b.payment === "cod" ? "Placed" : "Pending Payment", by: "Customer" }],
    });
  } catch (err) {
    await releaseStock(items, code, "Order creation failed");
    throw err;
  }

  if (b.payment === "cod") {
    await createCodPayment({ doc: order, user: req.user });
    if (coupon) {
      await Coupon.updateOne({ _id: coupon._id }, { $inc: { used: 1 } });
      await CouponRedemption.create({ coupon: coupon._id, user: req.user._id, refCode: order.code, discount });
    }
    for (const it of items) await Product.updateOne({ _id: it.product }, { $inc: { sold: it.qty } });
    await notifyOrderStatus(order);
    return res.status(201).json({ data: { code: order.code, amount: total, checkout: { provider: "cod" } } });
  }

  try {
    const checkout = await startPayment({ kind: "Store", refType: "Order", doc: order, user: req.user });
    res.status(201).json({ data: { code: order.code, amount: total, checkout } });
  } catch (err) {
    await Order.updateOne({ _id: order._id }, { $set: { status: "Payment Failed", paymentStatus: "Failed", stockReserved: false } });
    await releaseStock(items, code, "Payment could not start");
    throw err;
  }
});

/* ───────── Retry a failed / abandoned payment ───────── */
r.post("/retry", validate({ body: z.object({ code: z.string().trim().max(40) }) }), async (req, res) => {
  const { code } = req.valid.body;
  const booking = await Booking.findOne({ code, user: req.user._id });
  if (booking) {
    if (!["Pending Payment", "Payment Failed"].includes(booking.status)) throw ApiError.badRequest("This booking is already paid");
    const parent = booking.type === "puja" ? await Puja.findById(booking.puja).lean() : await Chadhava.findById(booking.chadhava).lean();
    const cutoff = parent?.cutoff ?? parent?.date;
    if (!parent || parent.status !== "Published" || new Date(cutoff) <= new Date()) throw ApiError.badRequest("Booking for this puja has closed", { code: "BOOKING_CLOSED" });
    booking.set({ status: "Pending Payment", paymentStatus: "Pending" });
    await booking.save();
    const checkout = await startPayment({ kind: booking.type === "puja" ? "Puja" : "Chadhava", refType: "Booking", doc: booking, user: req.user });
    return res.json({ data: { code: booking.code, amount: booking.pricing.total, checkout } });
  }

  const order = await Order.findOne({ code, user: req.user._id, paymentMethod: "Prepaid" });
  if (!order) throw ApiError.notFound("Booking or order not found");
  if (!["Pending Payment", "Payment Failed"].includes(order.status)) throw ApiError.badRequest("This order is already paid");
  if (!order.stockReserved) {
    if (!(await reserveStock(order.items, order.code))) throw ApiError.conflict("Some items in this order are now out of stock. Please place a new order.", { code: "OUT_OF_STOCK" });
    order.stockReserved = true;
  }
  order.set({ status: "Pending Payment", paymentStatus: "Pending" });
  await order.save();
  const checkout = await startPayment({ kind: "Store", refType: "Order", doc: order, user: req.user });
  res.json({ data: { code: order.code, amount: order.pricing.total, checkout } });
});

export default r;
