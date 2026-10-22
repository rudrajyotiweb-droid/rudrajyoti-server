import { AuditLog } from "../models/index.js";
import { logger } from "../utils/logger.js";

/** Records an admin action. Never throws — auditing must not break the action itself. */
export async function audit(req, action, target = "", meta) {
  try {
    await AuditLog.create({ admin: req.admin?._id, who: req.admin?.name ?? "System", action: String(action).slice(0, 300), target: String(target ?? "").slice(0, 300), ip: req.ip, meta });
  } catch (err) {
    logger.error({ err: err.message, action }, "Failed to write audit log");
  }
}
