/**
 * Images and videos are stored in MongoDB GridFS (bucket "media") and served at /media/<key>.
 * Keys look like "puja/kali.webp" (seeded from client-site) or "uploads/2026/10/ab12cd-name.webp".
 */
import path from "node:path";
import mongoose from "mongoose";
import { ApiError } from "../utils/ApiError.js";
import { randomToken, slugify } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";

let bucket;
export function getBucket() {
  if (!bucket || bucket.s?.db !== mongoose.connection.db) {
    if (!mongoose.connection.db) throw ApiError.unavailable("Database is not connected");
    bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "media" });
  }
  return bucket;
}
const files = () => mongoose.connection.db.collection("media.files");

const TYPES = {
  "image/webp": { ext: "webp", kind: "image" },
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "image/gif": { ext: "gif", kind: "image" },
  "image/svg+xml": { ext: "svg", kind: "image" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
};
const EXT_TYPES = { webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", ico: "image/x-icon" };

export const contentTypeFor = (filename) => EXT_TYPES[path.extname(filename).slice(1).toLowerCase()] ?? "application/octet-stream";

/** Detect the real file type from magic bytes (never trust the client's mimetype). */
export function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  const hex = buf.subarray(0, 12).toString("hex");
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("89504e470d0a1a0a")) return "image/png";
  if (hex.startsWith("47494638")) return "image/gif";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(4, 8).toString() === "ftyp") return buf.subarray(8, 12).toString().startsWith("qt") ? "video/quicktime" : "video/mp4";
  if (hex.startsWith("1a45dfa3")) return "video/webm";
  return null;
}

export const urlFor = (key) => `/media/${key}`;
export const keyFromUrl = (url = "") => (String(url).startsWith("/media/") ? String(url).slice(7) : null);

/** Store a buffer under `key`, replacing any existing file with the same key. */
export async function putFile(key, buffer, contentType, metadata = {}) {
  const b = getBucket();
  const old = await files().find({ filename: key }, { projection: { _id: 1 } }).toArray();
  await new Promise((resolve, reject) => {
    const up = b.openUploadStream(key, { metadata: { contentType, size: buffer.length, ...metadata } });
    up.once("error", reject);
    up.once("finish", resolve);
    up.end(buffer);
  });
  for (const f of old) await b.delete(f._id).catch(() => {});
  return urlFor(key);
}

/** Save an uploaded file (multer memory storage). `allow` = "image" | "video" | "any". */
export async function saveUpload(file, { allow = "image", folder = "uploads", by } = {}) {
  if (!file?.buffer?.length) throw ApiError.badRequest("No file uploaded");
  const type = sniff(file.buffer);
  const info = type && TYPES[type];
  if (!info) throw ApiError.badRequest("Unsupported file type. Use WebP, JPEG, PNG, GIF, MP4 or WebM.");
  if (allow !== "any" && info.kind !== allow) throw ApiError.badRequest(`Please upload ${allow === "image" ? "an image" : "a video"} file`);

  const d = new Date();
  const base = slugify(path.parse(file.originalname || "file").name).slice(0, 40) || "file";
  const key = `${folder}/${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${randomToken(6)}-${base}.${info.ext}`;
  const url = await putFile(key, file.buffer, type, { kind: info.kind, originalName: file.originalname, uploadedBy: by });
  return { url, key, contentType: type, size: file.buffer.length, kind: info.kind };
}

export async function deleteByKey(key) {
  const list = await files().find({ filename: key }, { projection: { _id: 1 } }).toArray();
  for (const f of list) await getBucket().delete(f._id).catch(() => {});
  return list.length;
}

export async function listMedia({ kind, prefix, skip = 0, limit = 60 } = {}) {
  const q = {};
  if (kind) q["metadata.kind"] = kind;
  if (prefix) q.filename = { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` };
  const [items, total] = await Promise.all([files().find(q).sort({ uploadDate: -1 }).skip(skip).limit(limit).toArray(), files().countDocuments(q)]);
  return {
    items: items.map((f) => ({ id: String(f._id), key: f.filename, url: urlFor(f.filename), size: f.length, contentType: f.metadata?.contentType, kind: f.metadata?.kind, uploadedAt: f.uploadDate })),
    total,
  };
}

/** Express handler: GET /media/* — streams from GridFS with ETag, caching and Range support. */
export async function serveMedia(req, res, next) {
  try {
    const raw = Array.isArray(req.params.key) ? req.params.key.join("/") : String(req.params.key ?? "");
    const key = decodeURIComponent(raw).replace(/^\/+/, "");
    if (!key || key.includes("..") || key.length > 300) throw ApiError.notFound("File not found");

    const file = await files().findOne({ filename: key }, { sort: { uploadDate: -1 } });
    if (!file) throw ApiError.notFound("File not found");

    const etag = `"${file._id}"`;
    const type = file.metadata?.contentType || contentTypeFor(key);
    res.setHeader("ETag", etag);
    res.setHeader("Content-Type", type);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", key.startsWith("uploads/") ? "public, max-age=31536000, immutable" : "public, max-age=86400, stale-while-revalidate=604800");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    if (type === "image/svg+xml") res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    let start = 0;
    let end = file.length - 1;
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [s, e] = range.replace("bytes=", "").split("-");
      start = s ? parseInt(s, 10) : Math.max(0, file.length - parseInt(e, 10));
      end = s && e ? Math.min(parseInt(e, 10), file.length - 1) : file.length - 1;
      if (Number.isNaN(start) || start > end || start >= file.length) {
        res.setHeader("Content-Range", `bytes */${file.length}`);
        return res.status(416).end();
      }
      res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${file.length}`);
    }
    res.setHeader("Content-Length", end - start + 1);
    if (req.method === "HEAD") return res.end();

    const stream = getBucket().openDownloadStream(file._id, { start, end: end + 1 });
    stream.on("error", (err) => {
      logger.error({ err: err.message, key }, "Media stream error");
      if (!res.headersSent) next(ApiError.notFound("File not found"));
      else res.destroy();
    });
    req.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
}
