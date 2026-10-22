import pino from "pino";
import { env } from "../config/env.js";

let transport;
if (!env.isProd) {
  try {
    // pretty logs in development only (devDependency)
    await import("pino-pretty");
    transport = { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } };
  } catch {
    transport = undefined;
  }
}

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.otp", "*.code", "*.token", "*.refreshToken", "*.CHECKSUMHASH"],
    censor: "[redacted]",
  },
  transport,
});
