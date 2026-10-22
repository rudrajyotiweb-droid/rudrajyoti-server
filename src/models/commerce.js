import { Schema, model, sub } from "./base.js";

export const BOOKING_STATUSES = ["Booked", "Sankalp Confirmed", "Puja Scheduled", "Puja Performed", "Video Shared", "Box Dispatched", "Delivered", "Cancelled"];
export const BOOKING_INTERNAL = ["Pending Payment", "Payment Failed"];
export const ORDER_STATUSES = ["Placed", "Packed", "Shipped", "Out for delivery", "Delivered", "Cancelled", "Return requested", "Returned"];
export const PAYMENT_STATES = ["Pending", "Paid", "Failed", "Refunded", "Partially refunded"];

const History = sub({ status: String, at: { type: Date, default: Date.now }, by: { type: String, default: "System" }, note: String });
const AddressSnap = sub({ label: String, name: String, line: String, city: String, state: String, pin: String, phone: String });
const LineItem = sub({ key: String, name: String, price: Number, qty: { type: Number, default: 1 } });

/* ───────── Counter (human-readable codes) ───────── */
const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } });
export const Counter = model("Counter", counterSchema);

/** e.g. nextCode("RJ") → RJ2610000123 (prefix + YYMM + 6-digit sequence) */
export async function nextCode(prefix) {
  const d = new Date(Date.now() + 330 * 60_000); // IST
  const yymm = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const c = await Counter.findOneAndUpdate({ _id: prefix }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `${prefix}${yymm}${String(c.seq).padStart(6, "0")}`;
}

/* ───────── Puja & Chadhava bookings ───────── */
const bookingSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    type: { type: String, enum: ["puja", "chadhava"], required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    puja: { type: Schema.Types.ObjectId, ref: "Puja", index: true },
    chadhava: { type: Schema.Types.ObjectId, ref: "Chadhava", index: true },
    snapshot: sub({ title: String, slug: String, image: String, templeName: String, templeCity: String, date: Date }),
    customerName: String,
    customerPhone: String,
    package: sub({ key: String, name: String, persons: Number, price: Number }),
    items: { type: [LineItem], default: [] }, // chadhava offerings
    addOns: { type: [LineItem], default: [] },
    participants: { type: [String], default: [] },
    gotra: { type: String, default: "" },
    unknownGotra: { type: Boolean, default: false },
    whatsapp: String,
    wish: { type: String, maxlength: 250, default: "" },
    box: { type: Boolean, default: false },
    address: AddressSnap,
    pricing: sub({ subtotal: Number, addOns: Number, discount: { type: Number, default: 0 }, total: Number, coupon: String }),
    status: { type: String, enum: [...BOOKING_STATUSES, ...BOOKING_INTERNAL], default: "Pending Payment", index: true },
    paymentStatus: { type: String, enum: PAYMENT_STATES, default: "Pending", index: true },
    payment: { type: Schema.Types.ObjectId, ref: "Payment" },
    history: { type: [History], default: [] },
    video: sub({ url: String, sharedAt: Date }),
    shipment: sub({ courier: String, awb: String, dispatchedAt: Date }),
    adminNote: { type: String, default: "" },
    paidAt: Date,
  },
  { timestamps: true },
);
bookingSchema.index({ createdAt: -1 });
export const Booking = model("Booking", bookingSchema);

/* ───────── Store orders ───────── */
const orderSchema = new Schema(
  {
    code: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    customerName: String,
    customerPhone: String,
    items: {
      type: [sub({ product: { type: Schema.Types.ObjectId, ref: "Product" }, slug: String, name: String, image: String, variant: String, qty: Number, price: Number, gst: Number })],
      default: [],
    },
    address: AddressSnap,
    delivery: { type: String, enum: ["standard", "express"], default: "standard" },
    pricing: sub({ subtotal: Number, shipping: Number, codFee: Number, discount: { type: Number, default: 0 }, total: Number, coupon: String }),
    paymentMethod: { type: String, enum: ["Prepaid", "COD"], required: true },
    paymentStatus: { type: String, enum: PAYMENT_STATES, default: "Pending", index: true },
    payment: { type: Schema.Types.ObjectId, ref: "Payment" },
    status: { type: String, enum: [...ORDER_STATUSES, ...BOOKING_INTERNAL], default: "Pending Payment", index: true },
    stockReserved: { type: Boolean, default: false },
    history: { type: [History], default: [] },
    courier: String,
    awb: String,
    returnReason: String,
    adminNote: { type: String, default: "" },
    paidAt: Date,
  },
  { timestamps: true },
);
orderSchema.index({ createdAt: -1 });
export const Order = model("Order", orderSchema);

/* ───────── Payments (one per gateway attempt) ───────── */
const paymentSchema = new Schema(
  {
    orderId: { type: String, required: true, unique: true }, // gateway order id
    kind: { type: String, enum: ["Puja", "Chadhava", "Store"], required: true, index: true },
    refType: { type: String, enum: ["Booking", "Order"], required: true },
    ref: { type: Schema.Types.ObjectId, required: true, refPath: "refType", index: true },
    refCode: String,
    user: { type: Schema.Types.ObjectId, ref: "User", index: true },
    customerName: String,
    amount: { type: Number, required: true, min: 0 },
    provider: { type: String, enum: ["paytm", "mock", "cod"], required: true },
    status: { type: String, enum: ["Created", "Pending", "Captured", "Failed", "Refunded", "Partially refunded"], default: "Created", index: true },
    txnId: String,
    bankTxnId: String,
    method: String,
    resultMsg: String,
    gateway: Schema.Types.Mixed, // last status response (non-secret fields)
    refundedAmount: { type: Number, default: 0 },
    refunds: {
      type: [sub({ refId: String, refundId: String, amount: Number, status: String, reason: String, by: String, at: { type: Date, default: Date.now }, message: String })],
      default: [],
    },
    processedAt: Date,
  },
  { timestamps: true },
);
paymentSchema.index({ createdAt: -1 });
export const Payment = model("Payment", paymentSchema);

/* ───────── Coupons ───────── */
const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    type: { type: String, enum: ["Percent", "Flat"], required: true },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, default: 0 }, // 0 = no cap
    minOrder: { type: Number, default: 0 },
    appliesTo: { type: String, enum: ["All", "Puja", "Store", "Chadhava"], default: "All" },
    used: { type: Number, default: 0 },
    limit: { type: Number, default: 0 }, // 0 = unlimited
    perUser: { type: Number, default: 0 }, // 0 = unlimited
    expires: Date,
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);
export const Coupon = model("Coupon", couponSchema);

const redemptionSchema = new Schema(
  {
    coupon: { type: Schema.Types.ObjectId, ref: "Coupon", required: true, index: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    refCode: String,
    discount: Number,
  },
  { timestamps: true },
);
redemptionSchema.index({ coupon: 1, user: 1 });
export const CouponRedemption = model("CouponRedemption", redemptionSchema);
