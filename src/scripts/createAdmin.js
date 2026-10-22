/**
 * Create or reset a staff account:
 *   pnpm create-admin -- --email ops@rudrajyoti.in --name "Ops Team" --role operations --password "S3cure-pass"
 * Roles: super_admin | operations | store | content | support
 */
import bcrypt from "bcryptjs";
import { connectDB, disconnectDB } from "../config/db.js";
import { Admin, ROLES } from "../models/index.js";

const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const email = arg("email")?.toLowerCase();
const password = arg("password");
const name = arg("name") ?? "Admin";
const role = arg("role") ?? "super_admin";

if (!email || !password || password.length < 8 || !ROLES.includes(role)) {
  console.error(`Usage: pnpm create-admin -- --email <email> --password <8+ chars> [--name <name>] [--role ${ROLES.join("|")}]`);
  process.exit(1);
}

try {
  await connectDB({ retries: 2 });
  const passwordHash = await bcrypt.hash(password, 12);
  const a = await Admin.findOneAndUpdate({ email }, { $set: { name, role, passwordHash, active: true, failedLogins: 0 }, $unset: { lockUntil: 1 }, $inc: { tokenVersion: 1 } }, { upsert: true, new: true });
  console.log(`✔ ${a.email} (${a.role}) is ready`);
} catch (err) {
  console.error("Failed:", err.message);
  process.exitCode = 1;
} finally {
  await disconnectDB();
}
