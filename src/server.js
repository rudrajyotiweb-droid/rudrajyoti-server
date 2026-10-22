import { env } from "./config/env.js";
import { connectDB, disconnectDB } from "./config/db.js";
import { createApp } from "./app.js";
import { startJobs, stopJobs } from "./jobs/reconcile.js";
import { logger } from "./utils/logger.js";

// Last-resort guards: log and keep serving instead of crashing on a stray promise.
process.on("unhandledRejection", (reason) => logger.error({ err: reason }, "Unhandled promise rejection"));
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "Uncaught exception — shutting down");
  shutdown("uncaughtException", 1);
});

const app = createApp();
let server;

async function start() {
  try {
    await connectDB();
  } catch (err) {
    logger.fatal({ err: err.message }, "Could not connect to MongoDB. Check MONGODB_URI and your Atlas IP access list.");
    process.exit(1);
  }

  server = app.listen(env.PORT, () => {
    logger.info(`API ready on http://localhost:${env.PORT}  (env=${env.NODE_ENV}, otp=${env.OTP_PROVIDER}, payments=${env.PAYMENT_PROVIDER})`);
  });
  server.on("error", (err) => {
    logger.fatal({ err: err.message }, err.code === "EADDRINUSE" ? `Port ${env.PORT} is already in use` : "Server error");
    process.exit(1);
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  startJobs();
}

let shuttingDown = false;
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down gracefully");
  stopJobs();
  const force = setTimeout(() => process.exit(code || 1), 10_000);
  force.unref();
  try {
    if (server) await new Promise((r) => server.close(() => r()));
    await disconnectDB();
  } finally {
    process.exit(code);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start();
