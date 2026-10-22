import { Router } from "express";
import { z } from "zod";
import { Booking, BOOKING_STATUSES, Order, ORDER_STATUSES, Payment, User } from "../../models/index.js";
import { allow } from "../../middleware/auth.js";
import { videoUpload } from "../../middleware/upload.js";
import { validate, zId, zIdParam, zPage } from "../../middleware/validate.js";
import { audit } from "../../services/audit.js";
import { saveUpload } from "../../services/media.js";
import { notifyBookingStatus, notifyOrderStatus } from "../../services/notify.js";
import { refundPayment, releaseStock, syncPayment } from "../../services/payments.js";
import { revokeAllSessions } from "../../services/tokens.js";
import { ApiError } from "../../utils/ApiError.js";
import { escapeRegex, formatPhone, pageMeta, paging } from "../../utils/helpers.js";

const r = Router();
const str = (max = 300) => z.string().trim().max(max);
const dateRange = (from, to) => (from || to ? { createdAt: { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(new Date(to).getTime() + 86_399_999) } : {}) } } : {});

/* ═════════ Bookings (puja + chadhava) ═════════ */
const bookingRow = (b) => ({
  id: String(b._id),
  code: b.code,
  type: b.type,
  pujaId: b.puja ? String(b.puja) : undefined,
  chadhavaId: b.chadhava ? String(b.chadhava) : undefined,
  title: b.snapshot?.title,
  slug: b.snapshot?.slug,
  date: b.snapshot?.date,
  temple: b.snapshot?.templeName,
  customerId: String(b.user?._id ?? b.user),
  customer: b.customerName,
  phone: formatPhone(b.customerPhone),
  whatsapp: b.whatsapp,
  pkg: b.type === "puja" ? b.package?.name : b.items?.map((i) => (i.qty > 1 ? `${i.name} × ${i.qty}` : i.name)).join(", "),
  package: b.package,
  items: b.items,
  names: b.participants,
  gotra: b.gotra,
  wish: b.wish,
  addOns: (b.addOns ?? []).map((a) => (a.qty > 1 ? `${a.name} × ${a.qty}` : a.name)),
  addOnItems: b.addOns,
  amount: b.pricing?.total,
  pricing: b.pricing,
  status: b.status,
  paymentStatus: b.paymentStatus,
  paymentId: b.payment ? String(b.payment) : undefined,
  box: b.box,
  address: b.address,
  video: b.video?.url,
  shipment: b.shipment,
  history: b.history,
  adminNote: b.adminNote,
  createdAt: b.createdAt,
});

const bookingQuery = zPage.extend({
  type: z.enum(["puja", "chadhava"]).optional(),
  puja: zId.optional(),
  chadhava: zId.optional(),
  status: str(40).optional(),
  payment: str(40).optional(),
  customer: zId.optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  includePending: z.enum(["true", "false"]).optional(),
});

function bookingFilter(q) {
  const f = { ...dateRange(q.from, q.to) };
  if (q.type) f.type = q.type;
  if (q.puja) f.puja = q.puja;
  if (q.chadhava) f.chadhava = q.chadhava;
  if (q.customer) f.user = q.customer;
  if (q.payment) f.paymentStatus = q.payment;
  if (q.status) f.status = q.status;
  else if (q.includePending !== "true") f.status = { $nin: ["Pending Payment", "Payment Failed"] };
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: "i" };
    f.$or = [{ code: rx }, { customerName: rx }, { customerPhone: rx }, { participants: rx }, { whatsapp: rx }, { "snapshot.title": rx }];
  }
  return f;
}

const bookings = Router();
bookings.use(allow("operations", "support"));

bookings.get("/", validate({ query: bookingQuery }), async (req, res) => {
  const pg = paging(req.valid.query, { def: 100, max: 5000 }); // large limit for sankalp export
  const f = bookingFilter(req.valid.query);
  const [items, total] = await Promise.all([Booking.find(f).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), Booking.countDocuments(f)]);
  res.json({ data: items.map(bookingRow), meta: pageMeta(total, pg) });
});

/** Per-puja / per-chadhava status counts for the Operations board. */
bookings.get("/_summary", async (_req, res) => {
  const rows = await Booking.aggregate([
    { $match: { status: { $nin: ["Pending Payment", "Payment Failed"] } } },
    { $group: { _id: { puja: "$puja", chadhava: "$chadhava", status: "$status" }, n: { $sum: 1 }, revenue: { $sum: "$pricing.total" }, names: { $sum: { $size: "$participants" } }, boxes: { $sum: { $cond: ["$box", 1, 0] } } } },
  ]);
  const out = {};
  for (const x of rows) {
    const id = String(x._id.puja ?? x._id.chadhava);
    out[id] ??= { total: 0, revenue: 0, names: 0, boxes: 0, byStatus: {} };
    out[id].total += x.n;
    out[id].names += x.names;
    out[id].boxes += x.boxes;
    if (x._id.status !== "Cancelled") out[id].revenue += x.revenue;
    out[id].byStatus[x._id.status] = x.n;
  }
  res.json({ data: out });
});

bookings.get("/:id", validate({ params: zIdParam }), async (req, res) => {
  const b = await Booking.findById(req.valid.params.id).lean();
  if (!b) throw ApiError.notFound("Booking not found");
  const payment = b.payment ? await Payment.findById(b.payment).lean() : null;
  res.json({ data: { ...bookingRow(b), payment: payment && { id: String(payment._id), orderId: payment.orderId, txnId: payment.txnId, status: payment.status, amount: payment.amount, refundedAmount: payment.refundedAmount, method: payment.method, provider: payment.provider } } });
});

async function setBookingStatus(b, status, by, note) {
  if (b.status === status) return false;
  if (["Pending Payment", "Payment Failed"].includes(b.status)) throw ApiError.badRequest(`Booking ${b.code} is not paid yet`);
  if (b.status === "Cancelled") throw ApiError.badRequest(`Booking ${b.code} is cancelled`);
  b.status = status;
  b.history.push({ status, by, note });
  await b.save();
  await notifyBookingStatus(b);
  return true;
}

const statusBody = z.object({ status: z.enum(BOOKING_STATUSES), note: str(300).optional(), courier: str(60).optional(), awb: str(60).optional() });

bookings.patch("/:id", validate({ params: zIdParam, body: statusBody.partial().extend({ adminNote: str(2000).optional(), gotra: str(60).optional(), names: z.array(str(80).min(2)).max(20).optional(), whatsapp: z.string().regex(/^[6-9]\d{9}$/).optional() }) }), async (req, res) => {
  const b = await Booking.findById(req.valid.params.id);
  if (!b) throw ApiError.notFound("Booking not found");
  const { status, note, courier, awb, adminNote, gotra, names, whatsapp } = req.valid.body;
  if (adminNote !== undefined) b.adminNote = adminNote;
  if (gotra) b.gotra = gotra;
  if (whatsapp) b.whatsapp = whatsapp;
  if (names) {
    if (b.type === "puja" && names.length !== b.package?.persons) throw ApiError.badRequest(`This package needs exactly ${b.package?.persons} names`);
    b.participants = names;
  }
  if (courier || awb) b.shipment = { ...(b.shipment?.toObject?.() ?? {}), courier: courier ?? b.shipment?.courier, awb: awb ?? b.shipment?.awb, ...(status === "Box Dispatched" ? { dispatchedAt: new Date() } : {}) };
  if (status === "Cancelled") throw ApiError.badRequest("Use the cancel action to cancel and refund a booking");
  if (status) await setBookingStatus(b, status, req.admin.name, note);
  else await b.save();
  await audit(req, status ? `Updated booking status → ${status}` : "Edited booking", b.code);
  res.json({ data: bookingRow(b.toObject()) });
});

/** Bulk status update, e.g. mark all bookings of a puja "Puja Performed". */
bookings.post("/bulk-status", validate({ body: z.object({ ids: z.array(zId).min(1).max(5000), status: z.enum(BOOKING_STATUSES.filter((s) => s !== "Cancelled")), note: str(300).optional() }) }), async (req, res) => {
  const list = await Booking.find({ _id: { $in: req.valid.body.ids } });
  let updated = 0;
  const skipped = [];
  for (const b of list) {
    try {
      if (await setBookingStatus(b, req.valid.body.status, req.admin.name, req.valid.body.note)) updated++;
    } catch (err) {
      skipped.push({ code: b.code, reason: err.message });
    }
  }
  await audit(req, `Bulk status → ${req.valid.body.status} (${updated})`, `${list.length} bookings`);
  res.json({ data: { updated, skipped } });
});

bookings.post("/:id/cancel", validate({ params: zIdParam, body: z.object({ reason: str(300).default("Cancelled by admin"), refund: z.boolean().default(true) }) }), async (req, res) => {
  const b = await Booking.findById(req.valid.params.id);
  if (!b) throw ApiError.notFound("Booking not found");
  if (b.status === "Cancelled") throw ApiError.badRequest("Already cancelled");
  if (req.valid.body.refund && b.payment && ["Paid", "Partially refunded"].includes(b.paymentStatus)) await refundPayment(b.payment, { reason: req.valid.body.reason, by: req.admin.name });
  b.status = "Cancelled";
  b.history.push({ status: "Cancelled", by: req.admin.name, note: req.valid.body.reason });
  await b.save();
  await notifyBookingStatus(b);
  await audit(req, `Cancelled booking${req.valid.body.refund ? " + refund" : ""}`, b.code);
  res.json({ data: bookingRow((await Booking.findById(b._id).lean()) ?? b.toObject()) });
});

bookings.post("/:id/video", videoUpload.single("file"), validate({ params: zIdParam, body: z.object({ url: str(1000).optional() }) }), async (req, res) => {
  const b = await Booking.findById(req.valid.params.id);
  if (!b) throw ApiError.notFound("Booking not found");
  const url = req.file ? (await saveUpload(req.file, { allow: "video", folder: "uploads/videos", by: req.admin.email })).url : req.valid.body.url;
  if (!url) throw ApiError.badRequest("Upload a video file or paste a video link");
  b.video = { url, sharedAt: new Date() };
  if (["Booked", "Sankalp Confirmed", "Puja Scheduled", "Puja Performed"].includes(b.status)) await setBookingStatus(b, "Video Shared", req.admin.name);
  else await b.save();
  await audit(req, "Uploaded booking video", b.code);
  res.json({ data: bookingRow(b.toObject()) });
});

r.use("/bookings", bookings);

/* ═════════ Store orders ═════════ */
const orderRow = (o) => ({
  id: String(o._id),
  code: o.code,
  customer: o.customerName,
  customerId: String(o.user?._id ?? o.user),
  phone: formatPhone(o.customerPhone),
  city: o.address?.city,
  address: o.address,
  items: o.items.map((i) => ({ productId: String(i.product), slug: i.slug, name: i.name, image: i.image, qty: i.qty, price: i.price, variant: i.variant })),
  delivery: o.delivery,
  pricing: o.pricing,
  total: o.pricing?.total,
  payment: o.paymentMethod,
  paymentStatus: o.paymentStatus,
  paymentId: o.payment ? String(o.payment) : undefined,
  status: o.status,
  history: o.history,
  courier: o.courier,
  awb: o.awb,
  returnReason: o.returnReason,
  adminNote: o.adminNote,
  createdAt: o.createdAt,
});

const orders = Router();
orders.use(allow("store", "support"));

orders.get("/", validate({ query: zPage.extend({ status: str(40).optional(), payment: z.enum(["Prepaid", "COD"]).optional(), customer: zId.optional(), from: z.string().date().optional(), to: z.string().date().optional(), includePending: z.enum(["true", "false"]).optional() }) }), async (req, res) => {
  const q = req.valid.query;
  const pg = paging(q, { def: 100, max: 2000 });
  const f = { ...dateRange(q.from, q.to) };
  if (q.status) f.status = q.status;
  else if (q.includePending !== "true") f.status = { $nin: ["Pending Payment", "Payment Failed"] };
  if (q.payment) f.paymentMethod = q.payment;
  if (q.customer) f.user = q.customer;
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: "i" };
    f.$or = [{ code: rx }, { customerName: rx }, { customerPhone: rx }, { awb: rx }, { "address.city": rx }];
  }
  const [items, total] = await Promise.all([Order.find(f).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), Order.countDocuments(f)]);
  res.json({ data: items.map(orderRow), meta: pageMeta(total, pg) });
});

orders.get("/:id", validate({ params: zIdParam }), async (req, res) => {
  const o = await Order.findById(req.valid.params.id).lean();
  if (!o) throw ApiError.notFound("Order not found");
  const payment = o.payment ? await Payment.findById(o.payment).lean() : null;
  res.json({ data: { ...orderRow(o), paymentInfo: payment && { id: String(payment._id), orderId: payment.orderId, txnId: payment.txnId, status: payment.status, amount: payment.amount, refundedAmount: payment.refundedAmount, method: payment.method, provider: payment.provider } } });
});

const NEXT = {
  Placed: ["Packed", "Shipped", "Cancelled"],
  Packed: ["Shipped", "Cancelled", "Placed"],
  Shipped: ["Out for delivery", "Delivered"],
  "Out for delivery": ["Delivered", "Shipped"],
  Delivered: ["Return requested", "Returned"],
  "Return requested": ["Returned", "Delivered"],
  Returned: [],
  Cancelled: [],
};

async function setOrderStatus(o, status, by, { note, courier, awb } = {}) {
  if (["Pending Payment", "Payment Failed"].includes(o.status)) throw ApiError.badRequest(`Order ${o.code} is not paid yet`);
  if (o.status === status) return false;
  if (!NEXT[o.status]?.includes(status)) throw ApiError.badRequest(`Order ${o.code} cannot move from “${o.status}” to “${status}”`);
  if (status === "Shipped" && !(awb || o.awb)) throw ApiError.badRequest(`Add the AWB / tracking number for ${o.code} before marking it shipped`);
  if (courier) o.courier = courier;
  if (awb) o.awb = awb;
  const wasReserved = o.stockReserved;
  if (["Cancelled", "Returned"].includes(status)) o.stockReserved = false;
  o.status = status;
  o.history.push({ status, by, note });
  await o.save();
  if (status === "Cancelled" && wasReserved) await releaseStock(o.items, o.code, "Cancelled by admin");
  if (status === "Returned") await releaseStock(o.items, o.code, "Returned");
  // COD money is collected on delivery
  if (status === "Delivered" && o.paymentMethod === "COD" && o.payment) {
    await Payment.updateOne({ _id: o.payment, status: "Pending" }, { $set: { status: "Captured", processedAt: new Date() } });
    await Order.updateOne({ _id: o._id, paymentStatus: "Pending" }, { $set: { paymentStatus: "Paid", paidAt: new Date() } });
  }
  await notifyOrderStatus(o);
  return true;
}

orders.patch("/:id", validate({ params: zIdParam, body: z.object({ status: z.enum(ORDER_STATUSES).optional(), note: str(300).optional(), courier: str(60).optional(), awb: str(60).optional(), adminNote: str(2000).optional() }) }), async (req, res) => {
  const o = await Order.findById(req.valid.params.id);
  if (!o) throw ApiError.notFound("Order not found");
  const { status, adminNote, ...rest } = req.valid.body;
  if (adminNote !== undefined) o.adminNote = adminNote;
  if (status) await setOrderStatus(o, status, req.admin.name, rest);
  else {
    if (rest.courier) o.courier = rest.courier;
    if (rest.awb) o.awb = rest.awb;
    await o.save();
  }
  await audit(req, status ? `Updated order status → ${status}` : "Edited order", o.code);
  res.json({ data: orderRow(o.toObject()) });
});

orders.post("/bulk-status", validate({ body: z.object({ ids: z.array(zId).min(1).max(1000), status: z.enum(ORDER_STATUSES) }) }), async (req, res) => {
  const list = await Order.find({ _id: { $in: req.valid.body.ids } });
  let updated = 0;
  const skipped = [];
  for (const o of list) {
    try {
      if (await setOrderStatus(o, req.valid.body.status, req.admin.name)) updated++;
    } catch (err) {
      skipped.push({ code: o.code, reason: err.message });
    }
  }
  await audit(req, `Bulk order status → ${req.valid.body.status} (${updated})`, `${list.length} orders`);
  res.json({ data: { updated, skipped } });
});

r.use("/orders", orders);

/* ═════════ Payments & refunds ═════════ */
const payments = Router();
payments.use(allow("store", "operations", "support"));

const paymentRow = (p) => ({
  id: String(p._id),
  orderId: p.orderId,
  ref: p.refCode,
  refType: p.refType,
  refId: String(p.ref),
  kind: p.kind,
  customer: p.customerName,
  amount: p.amount,
  refundedAmount: p.refundedAmount,
  provider: p.provider,
  method: p.method ?? (p.provider === "cod" ? "COD" : undefined),
  status: p.status,
  txnId: p.txnId,
  bankTxnId: p.bankTxnId,
  message: p.resultMsg,
  refunds: p.refunds,
  at: p.createdAt,
  processedAt: p.processedAt,
});

payments.get("/", validate({ query: zPage.extend({ status: str(40).optional(), kind: z.enum(["Puja", "Chadhava", "Store"]).optional(), from: z.string().date().optional(), to: z.string().date().optional() }) }), async (req, res) => {
  const q = req.valid.query;
  const pg = paging(q, { def: 100, max: 2000 });
  const f = { ...dateRange(q.from, q.to), status: { $ne: "Created" } };
  if (q.status) f.status = q.status;
  if (q.kind) f.kind = q.kind;
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: "i" };
    f.$or = [{ orderId: rx }, { refCode: rx }, { customerName: rx }, { txnId: rx }];
  }
  const [items, total, sums] = await Promise.all([
    Payment.find(f).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    Payment.countDocuments(f),
    Payment.aggregate([{ $match: { ...dateRange(q.from, q.to) } }, { $group: { _id: "$status", amount: { $sum: "$amount" }, refunded: { $sum: "$refundedAmount" }, n: { $sum: 1 } } }]),
  ]);
  res.json({ data: items.map(paymentRow), meta: { ...pageMeta(total, pg), totals: Object.fromEntries(sums.map((s) => [s._id, { amount: s.amount, refunded: s.refunded, count: s.n }])) } });
});

payments.get("/:id", validate({ params: zIdParam }), async (req, res) => {
  const p = await Payment.findById(req.valid.params.id).lean();
  if (!p) throw ApiError.notFound("Payment not found");
  res.json({ data: { ...paymentRow(p), gateway: p.gateway } });
});

payments.post("/:id/sync", validate({ params: zIdParam }), async (req, res) => {
  const p = await Payment.findById(req.valid.params.id);
  if (!p) throw ApiError.notFound("Payment not found");
  const updated = await syncPayment(p.orderId);
  res.json({ data: paymentRow(updated.toObject()) });
});

payments.post("/:id/refund", validate({ params: zIdParam, body: z.object({ amount: z.number().int().min(1).optional(), reason: str(300).default("Refund by admin") }) }), async (req, res) => {
  const p = await refundPayment(req.valid.params.id, { amount: req.valid.body.amount, reason: req.valid.body.reason, by: req.admin.name });
  await audit(req, `Initiated refund ₹${req.valid.body.amount ?? "full"}`, p.refCode);
  res.json({ data: paymentRow(p.toObject()) });
});

r.use("/payments", payments);

/* ═════════ Customers ═════════ */
const customers = Router();
customers.use(allow("support", "operations", "store"));

customers.get("/", validate({ query: zPage.extend({ status: z.enum(["Active", "Blocked"]).optional() }) }), async (req, res) => {
  const q = req.valid.query;
  const pg = paging(q, { def: 100, max: 1000 });
  const f = { deletedAt: null };
  if (q.status) f.status = q.status;
  if (q.q) {
    const rx = { $regex: escapeRegex(q.q), $options: "i" };
    f.$or = [{ name: rx }, { phone: rx }, { email: rx }, { city: rx }];
  }
  const [users, total] = await Promise.all([User.find(f).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(), User.countDocuments(f)]);
  const ids = users.map((u) => u._id);
  const paid = { $in: ["Paid", "Partially refunded"] };
  const [b, o] = await Promise.all([
    Booking.aggregate([{ $match: { user: { $in: ids }, paymentStatus: paid } }, { $group: { _id: "$user", n: { $sum: 1 }, spent: { $sum: "$pricing.total" } } }]),
    Order.aggregate([{ $match: { user: { $in: ids }, paymentStatus: { $in: ["Paid", "Partially refunded", "Pending"] }, status: { $nin: ["Pending Payment", "Payment Failed", "Cancelled"] } } }, { $group: { _id: "$user", n: { $sum: 1 }, spent: { $sum: "$pricing.total" } } }]),
  ]);
  const bm = new Map(b.map((x) => [String(x._id), x]));
  const om = new Map(o.map((x) => [String(x._id), x]));
  res.json({
    data: users.map((u) => ({
      id: String(u._id),
      name: u.name || "—",
      phone: formatPhone(u.phone),
      email: u.email,
      city: u.city || u.addresses?.find((a) => a.isDefault)?.city || "",
      gotra: u.gotra,
      joined: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      bookings: bm.get(String(u._id))?.n ?? 0,
      orders: om.get(String(u._id))?.n ?? 0,
      spent: (bm.get(String(u._id))?.spent ?? 0) + (om.get(String(u._id))?.spent ?? 0),
      status: u.status,
    })),
    meta: pageMeta(total, pg),
  });
});

customers.get("/:id", validate({ params: zIdParam }), async (req, res) => {
  const u = await User.findById(req.valid.params.id).lean();
  if (!u) throw ApiError.notFound("Customer not found");
  const [bk, od] = await Promise.all([Booking.find({ user: u._id }).sort({ createdAt: -1 }).limit(50).lean(), Order.find({ user: u._id }).sort({ createdAt: -1 }).limit(50).lean()]);
  res.json({
    data: {
      id: String(u._id),
      name: u.name,
      phone: formatPhone(u.phone),
      email: u.email,
      city: u.city,
      gotra: u.gotra,
      dob: u.dob,
      status: u.status,
      notes: u.notes,
      joined: u.createdAt,
      family: u.family,
      addresses: u.addresses,
      bookings: bk.map(bookingRow),
      orders: od.map(orderRow),
    },
  });
});

customers.patch("/:id", validate({ params: zIdParam, body: z.object({ status: z.enum(["Active", "Blocked"]).optional(), notes: str(2000).optional() }) }), async (req, res) => {
  const u = await User.findById(req.valid.params.id);
  if (!u) throw ApiError.notFound("Customer not found");
  u.set(req.valid.body);
  await u.save();
  if (req.valid.body.status === "Blocked") await revokeAllSessions(u._id);
  await audit(req, req.valid.body.status ? `${req.valid.body.status === "Blocked" ? "Blocked" : "Unblocked"} customer` : "Edited customer notes", u.name || u.phone);
  res.json({ data: { id: String(u._id), status: u.status, notes: u.notes } });
});

r.use("/customers", customers);

export default r;
