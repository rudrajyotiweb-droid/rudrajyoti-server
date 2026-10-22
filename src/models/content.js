import { Schema, model, sub } from "./base.js";

/* ───────── Banners ───────── */
export const BANNER_PLACEMENTS = ["Home hero", "Home promo", "Puja listing", "Store"];
const bannerSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: "" },
    tagline: { type: String, default: "" },
    pujaSlug: { type: String, default: "" },
    image: { type: String, required: true },
    link: { type: String, default: "/" },
    placement: { type: String, enum: BANNER_PLACEMENTS, required: true, index: true },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Banner = model("Banner", bannerSchema);

/* ───────── Reviews ───────── */
const reviewSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    customerName: { type: String, default: "" },
    city: { type: String, default: "" },
    kind: { type: String, enum: ["Puja", "Product", "Chadhava"], required: true },
    targetId: { type: Schema.Types.ObjectId, index: true },
    targetSlug: String,
    target: { type: String, default: "" }, // title snapshot
    refCode: String, // booking / order code that proves purchase
    rating: { type: Number, required: true, min: 1, max: 5 },
    text: { type: String, default: "", maxlength: 2000 },
    status: { type: String, enum: ["Pending", "Approved", "Rejected"], default: "Pending", index: true },
    featured: { type: Boolean, default: false },
    reply: { type: String, default: "" },
    isDemo: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export const Review = model("Review", reviewSchema);

/* ───────── Support tickets ───────── */
const ticketSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    customerName: String,
    subject: { type: String, required: true, maxlength: 200 },
    channel: { type: String, enum: ["WhatsApp", "Email", "Phone", "App"], default: "App" },
    priority: { type: String, enum: ["High", "Medium", "Low"], default: "Medium" },
    status: { type: String, enum: ["Open", "Pending", "Resolved"], default: "Open", index: true },
    refCode: String,
    assignee: String,
    messages: {
      type: [sub({ from: { type: String, enum: ["customer", "agent", "note"] }, text: { type: String, maxlength: 4000 }, by: String, at: { type: Date, default: Date.now } })],
      default: [],
    },
  },
  { timestamps: true },
);
export const Ticket = model("Ticket", ticketSchema);

/* ───────── In-app notifications (user) ───────── */
const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    kind: { type: String, enum: ["booking", "order", "video", "offer", "support", "system"], default: "system" },
    link: String,
    read: { type: Boolean, default: false },
  },
  { timestamps: true },
);
notificationSchema.index({ user: 1, createdAt: -1 });
export const Notification = model("Notification", notificationSchema);

const pushSchema = new Schema(
  {
    title: { type: String, required: true },
    body: { type: String, default: "" },
    link: { type: String, default: "/" },
    segment: { type: String, enum: ["All users", "Booked users", "Store buyers"], default: "All users" },
    sent: { type: Number, default: 0 },
    opened: { type: Number, default: 0 },
    by: String,
  },
  { timestamps: { createdAt: "at", updatedAt: false } },
);
export const PushCampaign = model("PushCampaign", pushSchema);

/* ───────── Settings / CMS ───────── */
const settingSchema = new Schema({ key: { type: String, required: true, unique: true }, value: Schema.Types.Mixed }, { timestamps: true, minimize: false });
export const Setting = model("Setting", settingSchema);

const pageSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    body: { type: String, default: "" },
    updatedBy: String,
  },
  { timestamps: true },
);
export const Page = model("Page", pageSchema);

const postSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    category: { type: String, default: "General" },
    author: { type: String, default: "Rudra Jyoti" },
    status: { type: String, enum: ["Published", "Draft", "Scheduled"], default: "Draft", index: true },
    excerpt: { type: String, default: "" },
    body: { type: String, default: "" },
    image: { type: String, default: "" },
    views: { type: Number, default: 0 },
    publishAt: Date,
    seo: sub({ title: String, desc: String }),
  },
  { timestamps: true },
);
export const Post = model("Post", postSchema);

const faqSchema = new Schema(
  {
    q: { type: String, required: true },
    a: { type: String, default: "" },
    group: { type: String, default: "General" },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Faq = model("Faq", faqSchema);

/* ───────── Daily counters for the funnel / traffic report ───────── */
const metricSchema = new Schema({ day: { type: String, required: true }, key: { type: String, required: true }, n: { type: Number, default: 0 } });
metricSchema.index({ day: 1, key: 1 }, { unique: true });
export const Metric = model("Metric", metricSchema);

/** IST calendar day, e.g. "2026-10-17". */
export const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);

export async function bumpMetric(key, by = 1) {
  try {
    await Metric.updateOne({ day: istDay(), key }, { $inc: { n: by } }, { upsert: true });
  } catch {
    /* metrics are best-effort */
  }
}
