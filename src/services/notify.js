/**
 * Notification fan-out. In-app notifications are stored in MongoDB; WhatsApp / SMS / push
 * adapters plug in here later. A failed notification never breaks the request that sent it.
 */
import { Notification, User } from "../models/index.js";
import { logger } from "../utils/logger.js";

export async function notifyUser(userId, { title, body = "", kind = "system", link }) {
  try {
    if (!userId) return;
    await Notification.create({ user: userId, title, body, kind, link });
  } catch (err) {
    logger.error({ err: err.message, userId, title }, "Failed to create notification");
  }
}

/** In-app broadcast to a segment; returns the number of users reached. */
export async function broadcast(userIds, { title, body, kind = "offer", link }) {
  try {
    const docs = userIds.map((user) => ({ user, title, body, kind, link }));
    for (let i = 0; i < docs.length; i += 1000) await Notification.insertMany(docs.slice(i, i + 1000), { ordered: false });
    return docs.length;
  } catch (err) {
    logger.error({ err: err.message }, "Broadcast failed");
    return 0;
  }
}

export async function activeUserIds() {
  return (await User.find({ status: "Active", deletedAt: null }, { _id: 1 }).lean()).map((u) => u._id);
}

const BOOKING_MESSAGES = {
  Booked: (b) => ["Booking confirmed 🙏", `Your booking ${b.code} for ${b.snapshot?.title} is confirmed.`, "booking"],
  "Sankalp Confirmed": (b) => ["Sankalp confirmed", `Your names for ${b.snapshot?.title} have been confirmed by the temple pandit.`, "booking"],
  "Puja Scheduled": (b) => ["Puja scheduled", `${b.snapshot?.title} is scheduled. Light a diya at home at the puja time.`, "booking"],
  "Puja Performed": (b) => ["Puja performed", `${b.snapshot?.title} was performed in your name. The video will reach you soon.`, "booking"],
  "Video Shared": (b) => ["Your puja video is ready", `Watch the video of ${b.snapshot?.title} performed in your name.`, "video"],
  "Box Dispatched": (b) => ["Aashirwad Box dispatched", `Your Aashirwad Box for ${b.code} is on its way.`, "order"],
  Delivered: (b) => ["Aashirwad Box delivered", `Your Aashirwad Box for ${b.code} has been delivered.`, "order"],
  Cancelled: (b) => ["Booking cancelled", `Booking ${b.code} was cancelled. Any amount paid will be refunded to the original payment method.`, "booking"],
};

export function notifyBookingStatus(booking) {
  const m = BOOKING_MESSAGES[booking.status];
  if (!m) return;
  const [title, body, kind] = m(booking);
  return notifyUser(booking.user, { title, body, kind, link: "/account/bookings" });
}

const ORDER_MESSAGES = {
  Placed: (o) => ["Order placed", `Your order ${o.code} has been placed.`],
  Packed: (o) => ["Order packed", `Order ${o.code} is packed and will ship soon.`],
  Shipped: (o) => ["Order shipped", `Order ${o.code} is on its way${o.courier ? ` with ${o.courier}` : ""}.`],
  "Out for delivery": (o) => ["Out for delivery", `Order ${o.code} will be delivered today.`],
  Delivered: (o) => ["Order delivered", `Order ${o.code} has been delivered. We hope you love it!`],
  Cancelled: (o) => ["Order cancelled", `Order ${o.code} was cancelled.`],
  Returned: (o) => ["Return completed", `Return for order ${o.code} is complete.`],
};

export function notifyOrderStatus(order) {
  const m = ORDER_MESSAGES[order.status];
  if (!m) return;
  const [title, body] = m(order);
  return notifyUser(order.user, { title, body, kind: "order", link: "/account/orders" });
}
