import { Router } from "express";
import { z } from "zod";
import { Booking, Chadhava, Metric, Order, Payment, Product, Puja, Review, Ticket, User } from "../../models/index.js";
import { validate } from "../../middleware/validate.js";

const r = Router();
const DAY = 86_400_000;
const IST = 330 * 60_000;
const istStart = (ms = Date.now()) => new Date(Math.floor((ms + IST) / DAY) * DAY - IST);
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : a ? 100 : 0);
const PAID = { $in: ["Paid", "Partially refunded"] };
const LIVE_ORDER = { $nin: ["Pending Payment", "Payment Failed", "Cancelled"] };

/** Revenue per IST day for the last `days` days, split by puja / chadhava / store. */
async function revenueSeries(days) {
  const from = new Date(istStart().getTime() - (days - 1) * DAY);
  const rows = await Payment.aggregate([
    { $match: { status: { $in: ["Captured", "Partially refunded"] }, processedAt: { $gte: from } } },
    { $group: { _id: { d: { $dateToString: { format: "%Y-%m-%d", date: "$processedAt", timezone: "+05:30" } }, k: "$kind" }, amount: { $sum: { $subtract: ["$amount", "$refundedAmount"] } } } },
  ]);
  const map = new Map(rows.map((x) => [`${x._id.d}|${x._id.k}`, x.amount]));
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(from.getTime() + i * DAY + IST);
    const key = d.toISOString().slice(0, 10);
    return {
      date: key,
      day: new Date(from.getTime() + i * DAY).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }),
      puja: map.get(`${key}|Puja`) ?? 0,
      store: map.get(`${key}|Store`) ?? 0,
      chadhava: map.get(`${key}|Chadhava`) ?? 0,
    };
  });
}

async function windowStats(from, to) {
  const range = { $gte: from, $lt: to };
  const [rev, bookings, orders, users, started] = await Promise.all([
    Payment.aggregate([{ $match: { status: { $in: ["Captured", "Partially refunded"] }, processedAt: range } }, { $group: { _id: null, amount: { $sum: { $subtract: ["$amount", "$refundedAmount"] } }, n: { $sum: 1 } } }]),
    Booking.countDocuments({ paidAt: range }),
    Order.countDocuments({ createdAt: range, status: LIVE_ORDER }),
    User.countDocuments({ createdAt: range }),
    Booking.countDocuments({ createdAt: range }),
  ]);
  const revenue = rev[0]?.amount ?? 0;
  const count = rev[0]?.n ?? 0;
  return { revenue, bookings, orders, users, aov: count ? Math.round(revenue / count) : 0, conversion: started ? Math.round((bookings / started) * 1000) / 10 : 0 };
}

r.get("/dashboard", validate({ query: z.object({ days: z.coerce.number().int().min(7).max(90).optional() }) }), async (req, res) => {
  const today = istStart();
  const now = new Date();
  const yesterday = new Date(today.getTime() - DAY);
  const weekAgo = new Date(today.getTime() - 7 * DAY);
  const twoWeeksAgo = new Date(today.getTime() - 14 * DAY);

  const [t, y, w, pw, series, topPujas, topProducts, recentBookings, recentOrders, alerts] = await Promise.all([
    windowStats(today, now),
    windowStats(yesterday, today),
    windowStats(weekAgo, now),
    windowStats(twoWeeksAgo, weekAgo),
    revenueSeries(req.valid.query.days ?? 30),
    Puja.find({ bookingsCount: { $gt: 0 } }, { title: 1, slug: 1, bookingsCount: 1, revenue: 1, images: { $slice: 1 } }).sort({ revenue: -1 }).limit(5).lean(),
    Product.find({ sold: { $gt: 0 } }, { name: 1, sold: 1, price: 1, images: { $slice: 1 }, stock: 1 }).sort({ sold: -1 }).limit(5).lean(),
    Booking.find({ paymentStatus: PAID }).sort({ paidAt: -1 }).limit(6).lean(),
    Order.find({ status: LIVE_ORDER }).sort({ createdAt: -1 }).limit(6).lean(),
    buildAlerts(),
  ]);

  res.json({
    data: {
      kpis: {
        revenueToday: t.revenue,
        revenueChange: pct(t.revenue, y.revenue),
        bookingsToday: t.bookings,
        bookingsChange: pct(t.bookings, y.bookings),
        ordersToday: t.orders,
        ordersChange: pct(t.orders, y.orders),
        aov: w.aov,
        aovChange: pct(w.aov, pw.aov),
        conversion: w.conversion,
        conversionChange: Math.round((w.conversion - pw.conversion) * 10) / 10,
        newUsers: w.users,
        newUsersChange: pct(w.users, pw.users),
      },
      revenueSeries: series,
      topPujas: topPujas.map((p) => ({ id: String(p._id), title: p.title, slug: p.slug, bookings: p.bookingsCount, revenue: p.revenue, image: p.images?.[0] })),
      topProducts: topProducts.map((p) => ({ id: String(p._id), name: p.name, sold: p.sold, revenue: p.sold * p.price, image: p.images?.[0], stock: p.stock })),
      recentBookings: recentBookings.map((b) => ({ id: String(b._id), code: b.code, customer: b.customerName, title: b.snapshot?.title, amount: b.pricing?.total, status: b.status, at: b.paidAt ?? b.createdAt })),
      recentOrders: recentOrders.map((o) => ({ id: String(o._id), code: o.code, customer: o.customerName, items: o.items.length, total: o.pricing?.total, status: o.status, at: o.createdAt })),
      alerts,
    },
  });
});

/** Operational alerts (BRD §7.1) — also used by the top-bar bell. */
async function buildAlerts() {
  const now = Date.now();
  const [closing, videoLate, lowStock, refundsPending, unshipped, highTickets, pendingReviews] = await Promise.all([
    Puja.find({ status: "Published", cutoff: { $gte: new Date(now), $lte: new Date(now + DAY) } }, { title: 1, bookingsCount: 1, cutoff: 1 }).lean(),
    Puja.find({ status: { $in: ["Published", "Closed", "Completed"] }, date: { $lte: new Date(now - 2 * DAY), $gte: new Date(now - 30 * DAY) }, "video.url": { $exists: false }, bookingsCount: { $gt: 0 } }, { title: 1, bookingsCount: 1, date: 1 }).lean(),
    Product.find({ status: "Active", $expr: { $lte: ["$stock", "$lowStock"] } }, { name: 1, stock: 1 }).sort({ stock: 1 }).limit(10).lean(),
    Payment.countDocuments({ "refunds.status": "Pending" }),
    Order.countDocuments({ status: { $in: ["Placed", "Packed"] }, createdAt: { $lte: new Date(now - 2 * DAY) } }),
    Ticket.find({ status: "Open", priority: "High" }, { code: 1, subject: 1, updatedAt: 1 }).sort({ updatedAt: -1 }).limit(5).lean(),
    Review.countDocuments({ status: "Pending" }),
  ]);
  const out = [];
  for (const p of videoLate) out.push({ id: `video-${p._id}`, title: "Video pending > 48h", body: `${p.title} — ${p.bookingsCount} devotees waiting`, tone: "danger", href: `/operations?puja=${p._id}`, at: p.date });
  for (const p of closing) out.push({ id: `close-${p._id}`, title: "Booking closes soon", body: `${p.title} — ${p.bookingsCount} bookings`, tone: "warning", href: `/pujas/${p._id}`, at: p.cutoff });
  for (const p of lowStock) out.push({ id: `stock-${p._id}`, title: p.stock === 0 ? "Out of stock" : "Low stock", body: `${p.name} — ${p.stock} left`, tone: "warning", href: "/inventory", at: new Date() });
  if (unshipped) out.push({ id: "unshipped", title: "Unshipped orders > 48h", body: `${unshipped} order(s) waiting to ship`, tone: "warning", href: "/orders", at: new Date() });
  if (refundsPending) out.push({ id: "refunds", title: "Refunds in progress", body: `${refundsPending} refund(s) awaiting gateway confirmation`, tone: "info", href: "/payments", at: new Date() });
  for (const t of highTickets) out.push({ id: `ticket-${t._id}`, title: "High-priority ticket", body: `${t.code} · ${t.subject}`, tone: "info", href: "/support", at: t.updatedAt });
  if (pendingReviews) out.push({ id: "reviews", title: "Reviews awaiting moderation", body: `${pendingReviews} new review(s)`, tone: "info", href: "/reviews", at: new Date() });
  return out;
}

r.get("/alerts", async (_req, res) => res.json({ data: await buildAlerts() }));

/** Sidebar badge counts. */
r.get("/counts", async (_req, res) => {
  const [bookings, orders, tickets, reviews] = await Promise.all([
    Booking.countDocuments({ status: "Booked" }),
    Order.countDocuments({ status: { $in: ["Placed", "Return requested"] } }),
    Ticket.countDocuments({ status: "Open" }),
    Review.countDocuments({ status: "Pending" }),
  ]);
  res.json({ data: { bookings, orders, tickets, reviews } });
});

/* ───────── Reports ───────── */
r.get("/reports", validate({ query: z.object({ months: z.coerce.number().int().min(1).max(24).optional() }) }), async (req, res) => {
  const months = req.valid.query.months ?? 6;
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCMonth(start.getUTCMonth() - (months - 1));

  const [rows, kinds, funnelRows, sourceRows, paidBookings, startedBookings, chadhavaTop] = await Promise.all([
    Payment.aggregate([
      { $match: { status: { $in: ["Captured", "Partially refunded"] }, processedAt: { $gte: start } } },
      { $group: { _id: { m: { $dateToString: { format: "%Y-%m", date: "$processedAt", timezone: "+05:30" } }, k: "$kind" }, amount: { $sum: { $subtract: ["$amount", "$refundedAmount"] } } } },
    ]),
    Payment.aggregate([{ $match: { status: { $in: ["Captured", "Partially refunded", "Refunded"] }, processedAt: { $gte: start } } }, { $group: { _id: "$kind", amount: { $sum: "$amount" }, refunded: { $sum: "$refundedAmount" }, n: { $sum: 1 } } }]),
    Metric.aggregate([{ $match: { day: { $gte: new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10) }, key: { $regex: "^funnel:" } } }, { $group: { _id: "$key", n: { $sum: "$n" } } }]),
    Metric.aggregate([{ $match: { day: { $gte: new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10) }, key: { $regex: "^source:" } } }, { $group: { _id: "$key", n: { $sum: "$n" } } }]),
    Booking.countDocuments({ type: "puja", paidAt: { $gte: new Date(Date.now() - 30 * DAY) } }),
    Booking.countDocuments({ type: "puja", createdAt: { $gte: new Date(Date.now() - 30 * DAY) } }),
    Chadhava.find({ bookingsCount: { $gt: 0 } }, { title: 1, bookingsCount: 1, revenue: 1 }).sort({ revenue: -1 }).limit(5).lean(),
  ]);

  const map = new Map(rows.map((x) => [`${x._id.m}|${x._id.k}`, x.amount]));
  const monthly = Array.from({ length: months }, (_, i) => {
    const d = new Date(start);
    d.setUTCMonth(start.getUTCMonth() + i);
    const key = d.toISOString().slice(0, 7);
    return { month: d.toLocaleDateString("en-IN", { month: "short", timeZone: "UTC" }), key, puja: map.get(`${key}|Puja`) ?? 0, store: map.get(`${key}|Store`) ?? 0, chadhava: map.get(`${key}|Chadhava`) ?? 0 };
  });

  const f = Object.fromEntries(funnelRows.map((x) => [x._id.slice(7), x.n]));
  const funnel = [
    { step: "Puja page views", value: f.puja_view ?? 0 },
    { step: "Package selected", value: f.package_selected ?? 0 },
    { step: "Sankalp filled", value: f.sankalp_filled ?? 0 },
    { step: "Payment started", value: startedBookings },
    { step: "Paid", value: paidBookings },
  ];
  const totalSrc = sourceRows.reduce((t, x) => t + x.n, 0);
  const trafficSources = sourceRows
    .map((x) => ({ name: x._id.slice(7), value: totalSrc ? Math.round((x.n / totalSrc) * 100) : 0, visits: x.n }))
    .sort((a, b) => b.visits - a.visits);

  res.json({ data: { monthly, byKind: kinds.map((k) => ({ kind: k._id, amount: k.amount, refunded: k.refunded, count: k.n })), funnel, trafficSources, topChadhava: chadhavaTop.map((c) => ({ id: String(c._id), title: c.title, bookings: c.bookingsCount, revenue: c.revenue })) } });
});

export default r;
