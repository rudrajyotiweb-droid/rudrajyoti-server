import { Coupon, CouponRedemption } from "../models/index.js";
import { ApiError } from "../utils/ApiError.js";
import { rupees } from "../utils/helpers.js";

/**
 * Validates a coupon for a checkout and returns { coupon, discount }.
 * kind: "Puja" | "Chadhava" | "Store". Throws a 400 with a user-friendly message when not applicable.
 * The discount never makes the payable amount less than ₹1.
 */
export async function applyCoupon({ code, kind, subtotal, userId }) {
  if (!code) return { coupon: null, discount: 0 };
  const coupon = await Coupon.findOne({ code: String(code).trim().toUpperCase() });
  const bad = (msg) => ApiError.badRequest(msg, { code: "COUPON_INVALID" });

  if (!coupon || !coupon.active) throw bad("This coupon code is not valid");
  if (coupon.expires && coupon.expires < new Date()) throw bad("This coupon has expired");
  if (coupon.limit > 0 && coupon.used >= coupon.limit) throw bad("This coupon has reached its usage limit");
  if (coupon.appliesTo !== "All" && coupon.appliesTo !== kind) throw bad(`This coupon is only valid on ${coupon.appliesTo.toLowerCase()} ${coupon.appliesTo === "Store" ? "orders" : "bookings"}`);
  if (subtotal < coupon.minOrder) throw bad(`Add ₹${coupon.minOrder - subtotal} more to use this coupon (minimum ₹${coupon.minOrder})`);
  if (coupon.perUser > 0 && userId) {
    const usedByUser = await CouponRedemption.countDocuments({ coupon: coupon._id, user: userId });
    if (usedByUser >= coupon.perUser) throw bad("You have already used this coupon");
  }

  let discount = coupon.type === "Percent" ? (subtotal * coupon.value) / 100 : coupon.value;
  if (coupon.type === "Percent" && coupon.maxDiscount > 0) discount = Math.min(discount, coupon.maxDiscount);
  discount = Math.min(rupees(discount), Math.max(0, subtotal - 1));
  return { coupon, discount };
}

/** GST included in an inclusive price, split for display. */
export function gstBreakup(totalInclusive, ratePct) {
  const taxable = Math.round(totalInclusive / (1 + ratePct / 100));
  return { taxable, gst: totalInclusive - taxable, rate: ratePct };
}
