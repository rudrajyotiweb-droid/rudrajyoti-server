import { Router } from "express";
import { z } from "zod";
import { validate, zIdParam, zPage } from "../../middleware/validate.js";
import { audit } from "../../services/audit.js";
import { ApiError } from "../../utils/ApiError.js";
import { escapeRegex, pageMeta, paging } from "../../utils/helpers.js";

/**
 * Standard admin CRUD for a model:
 *   GET    /           list (search `q` over searchFields, filters from `filters`)
 *   GET    /:id        one
 *   POST   /           create (validated by `create` schema)
 *   PATCH  /:id        update (validated by `update` schema, defaults to create.partial())
 *   DELETE /:id        delete (or `onDelete` hook)
 */
export function crudRouter(Model, opts) {
  const { name, create, update = create.partial(), searchFields = [], sort = { createdAt: -1 }, filters = {}, populate, label = (d) => d.name ?? d.title ?? d.code ?? String(d._id), beforeSave, afterSave, onDelete, list: listMap = (d) => d, maxLimit = 500 } = opts;
  const r = Router();

  const listQuery = zPage.extend(Object.fromEntries(Object.keys(filters).map((k) => [k, z.string().max(100).optional()])));

  r.get("/", validate({ query: listQuery }), async (req, res) => {
    const q = req.valid.query;
    const pg = paging(q, { def: 200, max: maxLimit });
    const filter = {};
    for (const [k, fn] of Object.entries(filters)) if (q[k] !== undefined && q[k] !== "") Object.assign(filter, fn(q[k]));
    if (q.q && searchFields.length) filter.$or = searchFields.map((f) => ({ [f]: { $regex: escapeRegex(q.q), $options: "i" } }));
    let query = Model.find(filter).sort(sort).skip(pg.skip).limit(pg.limit);
    if (populate) query = query.populate(populate);
    const [items, total] = await Promise.all([query.lean(), Model.countDocuments(filter)]);
    res.json({ data: items.map((d) => listMap(clean(d))), meta: pageMeta(total, pg) });
  });

  r.get("/:id", validate({ params: zIdParam }), async (req, res) => {
    let query = Model.findById(req.valid.params.id);
    if (populate) query = query.populate(populate);
    const doc = await query.lean();
    if (!doc) throw ApiError.notFound(`${name} not found`);
    res.json({ data: clean(doc) });
  });

  r.post("/", validate({ body: create }), async (req, res) => {
    const body = beforeSave ? await beforeSave(req.valid.body, req, null) : req.valid.body;
    const doc = await Model.create(body);
    if (afterSave) await afterSave(doc, req);
    await audit(req, `Created ${name.toLowerCase()}`, label(doc));
    res.status(201).json({ data: doc.toJSON() });
  });

  r.patch("/:id", validate({ params: zIdParam, body: update }), async (req, res) => {
    const doc = await Model.findById(req.valid.params.id);
    if (!doc) throw ApiError.notFound(`${name} not found`);
    const body = beforeSave ? await beforeSave(req.valid.body, req, doc) : req.valid.body;
    doc.set(body);
    await doc.save();
    if (afterSave) await afterSave(doc, req);
    await audit(req, `Updated ${name.toLowerCase()}`, label(doc), { fields: Object.keys(req.valid.body) });
    res.json({ data: doc.toJSON() });
  });

  r.delete("/:id", validate({ params: zIdParam }), async (req, res) => {
    const doc = await Model.findById(req.valid.params.id);
    if (!doc) throw ApiError.notFound(`${name} not found`);
    if (onDelete) await onDelete(doc, req);
    else await doc.deleteOne();
    await audit(req, `Deleted ${name.toLowerCase()}`, label(doc));
    res.json({ data: { ok: true } });
  });

  return r;
}

/** Same as models/base clean() — local copy to avoid a cycle. */
function clean(obj) {
  if (Array.isArray(obj)) return obj.map(clean);
  if (!obj || typeof obj !== "object" || obj instanceof Date) return obj;
  if (obj._bsontype === "ObjectId" || obj.constructor?.name === "ObjectId") return String(obj);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "__v") continue;
    if (k === "_id") out.id = String(v);
    else out[k] = clean(v);
  }
  return out;
}
