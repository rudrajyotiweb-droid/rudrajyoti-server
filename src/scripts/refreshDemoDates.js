/**
 * Moves the seeded demo pujas and chadhavas to upcoming dates again (same offsets as the seed,
 * counted from today, IST) and reopens the ones the background job closed when their cutoff passed.
 * Only records whose slug is in src/seed/data.json are touched; Draft / Cancelled / Completed ones are left alone.
 *   pnpm seed:dates              (seed offsets pushed 3 days ahead, so nothing closes the same day)
 *   pnpm seed:dates -- --shift 0 (exact seed offsets)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDB, disconnectDB } from "../config/db.js";
import { Chadhava, Puja } from "../models/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(await fs.readFile(path.join(here, "../seed/data.json"), "utf8"));

const DAY = 86_400_000;
const IST = 330 * 60_000;
const i = process.argv.indexOf("--shift");
const shift = i > -1 ? Number(process.argv[i + 1]) : 3;
if (!Number.isInteger(shift) || shift < 0 || shift > 60) {
  console.error("--shift must be a whole number of days (0–60)");
  process.exit(1);
}
const today = Math.floor((Date.now() + IST) / DAY) * DAY - IST + shift * DAY;
const rel = (v) => {
  const [, d, h, m] = String(v).split(":").map(Number);
  return new Date(today + d * DAY + (h * 60 + m) * 60_000);
};
const ist = (d) => d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

async function refresh(Model, items, cutoffOf, label) {
  for (const it of items) {
    const date = rel(it.date);
    const cutoff = cutoffOf(it, date);
    const doc = await Model.findOne({ slug: it.slug }, "status").lean();
    if (!doc) {
      console.log(`- ${label} ${it.slug}: not in database, skipped`);
      continue;
    }
    if (!["Published", "Closed"].includes(doc.status)) {
      console.log(`- ${label} ${it.slug}: status ${doc.status}, left unchanged`);
      continue;
    }
    await Model.updateOne({ _id: doc._id }, { $set: { date, cutoff, status: "Published" } });
    console.log(`✔ ${label} ${it.slug}: ${ist(date)} (booking closes ${ist(cutoff)})`);
  }
}

try {
  await connectDB({ retries: 2 });
  await refresh(Puja, data.pujas, (p) => rel(p.cutoff), "puja");
  await refresh(Chadhava, data.chadhavas, (_c, date) => new Date(date.getTime() - 6 * 3_600_000), "chadhava");
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await disconnectDB();
}
