import { Setting } from "../models/index.js";
import { logger } from "../utils/logger.js";

/** Defaults mirror client-site/src/data/site.ts and the admin Settings screen. */
export const DEFAULT_SITE = {
  brand: {
    name: "Rudra Jyoti",
    tagline: "Shiva's Light, Vedic Insight",
    description:
      "Book pujas at sacred temples of India in your name and gotra, receive the puja video on WhatsApp and get the Aashirwad Box at your doorstep. Shop authentic puja samagri and spiritual products.",
    phone: "+91 90000 00000",
    whatsapp: "919000000000",
    email: "seva@rudrajyoti.example",
    supportHours: "8 AM – 9 PM IST, all days",
    address: "12 Temple Road, Kolkata, West Bengal 700001",
    logo: "/media/brand/emblem.png",
    wordmark: "/media/brand/wordmark.png",
  },
  stats: { pujas: 1200, devotees: 18000, temples: 24, rating: 4.8 },
  tax: { gstin: "19ABCDE1234F1Z5", legalName: "Rudra Jyoti Seva Pvt. Ltd.", pujaGst: 18, invoicePrefix: "RJ/26-27/" },
  shipping: { freeShippingThreshold: 499, standardFee: 49, expressFee: 99, codEnabled: true, codFee: 49, pickupLocation: "Kolkata Warehouse" },
  notifications: { booking_confirmed: true, mantra_reminder: true, puja_video_ready: true, box_dispatched: true, order_shipped: true },
  /** Header / decorative images of the website's fixed pages (Admin → Settings → Website images). */
  pageImages: {
    heroDeity: "/media/deity/shiva.webp",
    puja: "/media/puja/durga-aarti.webp",
    chadhava: "/media/hero/deep-daan.webp",
    temples: "/media/temple/somnath.webp",
    store: "/media/product/shankha-thali.webp",
    contact: "/media/temple/dakshineswar.webp",
    faq: "/media/puja/aarti.webp",
    howItWorks: "/media/temple/jagannath-puri.webp",
    about: "/media/temple/kashi-vishwanath.webp",
    aboutStory: "/media/puja/aarti.webp",
    login: "/media/hero/ganga-aarti.webp",
    policy: "/media/hero/temple-dusk.webp",
    appInstall: "/media/hero/ganga-aarti.webp",
  },
  /** "How Puja Seva Works" steps (home/puja/chadhava strip and the How it works page). */
  howItWorks: [
    { title: "Choose your puja", desc: "Pick a puja or chadhava at a sacred temple and select the package that suits your family.", icon: "Flower2", image: "/media/puja/durga-aarti.webp", points: ["Pujas at Jyotirlingas, Shakti Peethas & Dhams", "Clear packages for 1 to 6 people"] },
    { title: "Share name & gotra", desc: "Fill in the names and gotra for the sankalp. Not sure of your gotra? We follow the shastra and use Kashyap.", icon: "ScrollText", image: "/media/puja/havan.webp", points: ["Pick saved family members in one tap", "Kashyap gotra used when unknown"] },
    { title: "Watch your puja", desc: "Temple pandits perform the rituals in your name. The puja video reaches your WhatsApp within 2–4 days.", icon: "Video", image: "/media/hero/ganga-aarti.webp", points: ["Performed by temple pandits", "Video on WhatsApp within 2–4 days"] },
    { title: "Receive Aashirwad", desc: "A blessed Aashirwad Box with prasad and sacred items arrives at your doorstep in 8–10 days.", icon: "Gift", image: "/media/chadhava/laddoo-bhog.webp", points: ["Prasad, raksha sutra & blessed items", "Delivered across India in 8–10 days"] },
  ],
};

const cache = new Map(); // key → { value, at }
const TTL = 30_000;

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== "object" || base === null) return over ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
  return out;
}

export async function getSetting(key, fallback = {}) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  try {
    const doc = await Setting.findOne({ key }).lean();
    const value = merge(fallback, doc?.value ?? {});
    cache.set(key, { value, at: Date.now() });
    return value;
  } catch (err) {
    logger.error({ err, key }, "Failed to read setting, using defaults");
    return hit?.value ?? fallback;
  }
}

export async function setSetting(key, value) {
  const doc = await Setting.findOneAndUpdate({ key }, { $set: { value } }, { upsert: true, new: true, lean: true });
  cache.delete(key);
  return doc.value;
}

export const getSite = () => getSetting("site", DEFAULT_SITE);
export const getHome = () => getSetting("home", {});
