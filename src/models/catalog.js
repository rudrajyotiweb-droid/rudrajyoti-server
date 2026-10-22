import { Schema, model, sub } from "./base.js";

export const PUBLISH_STATUSES = ["Draft", "Published", "Closed", "Completed", "Cancelled"];

const QA = sub({ q: { type: String, trim: true, default: "" }, a: { type: String, trim: true, default: "" } });
const Seo = sub({ title: { type: String, default: "" }, desc: { type: String, default: "" } });
const Video = sub({ url: String, uploadedAt: Date });

/* ───────── Temple ───────── */
const templeSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    deity: { type: String, default: "" },
    image: { type: String, default: "" },
    gallery: { type: [String], default: [] },
    short: { type: String, default: "" },
    history: { type: [String], default: [] },
    timings: { type: String, default: "" },
    mapQuery: { type: String, default: "" },
    coords: sub({ lat: Number, lng: Number }),
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
    seo: { type: Seo, default: () => ({}) },
  },
  { timestamps: true },
);
export const Temple = model("Temple", templeSchema);

/* ───────── Add-on offerings master ───────── */
const addOnSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    desc: { type: String, default: "" },
    image: { type: String, default: "" },
    active: { type: Boolean, default: true },
    order: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const AddOn = model("AddOn", addOnSchema);

/* ───────── Puja ───────── */
const Package = sub({
  key: { type: String, required: true },
  name: { type: String, required: true },
  persons: { type: Number, required: true, min: 1, max: 20 },
  price: { type: Number, required: true, min: 0 },
  strike: Number,
  popular: { type: Boolean, default: false },
  desc: { type: String, default: "" },
});

const pujaSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: "" },
    ribbon: { type: String, default: "" },
    deity: { type: String, default: "", index: true },
    purposes: { type: [String], default: [] },
    temple: { type: Schema.Types.ObjectId, ref: "Temple" },
    date: { type: Date, required: true, index: true },
    cutoff: { type: Date, required: true },
    tithi: { type: String, default: "" },
    images: { type: [String], default: [] },
    devotees: { type: Number, default: 0 },
    featured: { type: Boolean, default: false },
    status: { type: String, enum: PUBLISH_STATUSES, default: "Draft", index: true },
    about: { type: [QA], default: [] },
    benefits: { type: [sub({ title: String, desc: String, icon: { type: String, default: "Sparkles" } })], default: [] },
    process: { type: [sub({ title: String, desc: String })], default: [] },
    faqs: { type: [QA], default: [] },
    packages: { type: [Package], default: [] },
    addOns: { type: [String], default: [] }, // AddOn.key
    boxContents: { type: String, default: "" },
    seo: { type: Seo, default: () => ({}) },
    bn: { type: sub({ title: String, subtitle: String }), default: () => ({}) },
    video: Video,
    bookingsCount: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
  },
  { timestamps: true },
);
pujaSchema.index({ title: "text", subtitle: "text", deity: "text" });
export const Puja = model("Puja", pujaSchema);

/* ───────── Chadhava ───────── */
const ChadhavaItem = sub({
  key: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true, min: 0 },
  image: { type: String, default: "" },
  desc: { type: String, default: "" },
  limit: { type: Number, default: 0 }, // 0 = unlimited
  sold: { type: Number, default: 0 },
});

const chadhavaSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: "" },
    temple: { type: Schema.Types.ObjectId, ref: "Temple" },
    date: { type: Date, required: true, index: true },
    cutoff: Date,
    tithi: { type: String, default: "" },
    image: { type: String, default: "" },
    about: { type: String, default: "" },
    items: { type: [ChadhavaItem], default: [] },
    devotees: { type: Number, default: 0 },
    status: { type: String, enum: PUBLISH_STATUSES, default: "Draft", index: true },
    video: Video,
    bookingsCount: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Chadhava = model("Chadhava", chadhavaSchema);

/* ───────── Store ───────── */
const categorySchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    icon: { type: String, default: "Package" },
    image: { type: String, default: "" },
    parent: { type: String, default: null }, // parent slug
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Category = model("Category", categorySchema);

const productSchema = new Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    sku: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, index: true }, // Category.slug
    price: { type: Number, required: true, min: 0 },
    mrp: { type: Number, required: true, min: 0 },
    gst: { type: Number, default: 12, min: 0, max: 28 },
    hsn: { type: String, default: "" },
    stock: { type: Number, default: 0, min: 0 },
    lowStock: { type: Number, default: 10 },
    sold: { type: Number, default: 0 },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    reviews: { type: Number, default: 0 },
    images: { type: [String], default: [] },
    short: { type: String, default: "" },
    description: { type: String, default: "" },
    specs: { type: [[String]], default: [] },
    howToUse: { type: String, default: "" },
    variants: sub({ label: String, options: [String] }),
    badge: { type: String, default: "" },
    bestseller: { type: Boolean, default: false },
    tags: { type: [String], default: [] },
    weight: { type: Number, default: 0 }, // grams
    status: { type: String, enum: ["Active", "Draft", "Archived"], default: "Active", index: true },
    seo: { type: Seo, default: () => ({}) },
  },
  { timestamps: true },
);
productSchema.index({ name: "text", short: "text", tags: "text" });
export const Product = model("Product", productSchema);

const inventoryLogSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    delta: { type: Number, required: true },
    stockAfter: Number,
    reason: { type: String, default: "" },
    ref: String,
    by: { type: String, default: "System" },
  },
  { timestamps: { createdAt: "at", updatedAt: false } },
);
export const InventoryLog = model("InventoryLog", inventoryLogSchema);
