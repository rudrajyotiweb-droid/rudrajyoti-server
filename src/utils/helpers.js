import crypto from "node:crypto";

export const slugify = (s = "") =>
  String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

/** Escape a user string for use inside a RegExp (search boxes). */
export const escapeRegex = (s = "") => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString("base64url");

/** Whole-rupee rounding; all money in the API is integer rupees. */
export const rupees = (n) => Math.max(0, Math.round(Number(n) || 0));

/** Indian mobile: returns 10 digits or null. Accepts "+91 98300 12345", "09830012345", etc. */
export function normalizePhone(raw) {
  const d = String(raw ?? "").replace(/\D/g, "");
  const ten = d.length === 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

export const formatPhone = (ten) => (ten ? `+91 ${ten.slice(0, 5)} ${ten.slice(5)}` : "");

/** Pagination from validated query: { page, limit, skip } */
export function paging(q = {}, { max = 100, def = 20 } = {}) {
  const limit = Math.min(max, Math.max(1, Number(q.limit) || def));
  const page = Math.max(1, Number(q.page) || 1);
  return { page, limit, skip: (page - 1) * limit };
}

export const pageMeta = (total, { page, limit }) => ({ total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) });

/** Pick only defined keys from an object. */
export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with timeout; throws on network error/timeout (caller decides how to map it). */
export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Parse JSON body safely; returns null when the body is not JSON. */
export async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
