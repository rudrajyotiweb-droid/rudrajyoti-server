import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { dbReady } from "./config/db.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { apiLimiter, sanitizeBody } from "./middleware/security.js";
import routes from "./routes/index.js";
import { serveMedia } from "./services/media.js";
import { ApiError } from "./utils/ApiError.js";
import { logger } from "./utils/logger.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", env.trustProxy ? 1 : false);
  app.set("query parser", "simple"); // no nested objects from query strings

  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url.startsWith("/media/") || req.url === "/health" },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info"),
      serializers: { req: (req) => ({ method: req.method, url: req.url }), res: (res) => ({ status: res.statusCode }) },
    }),
  );

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));

  const allowed = new Set(env.corsOrigins);
  const corsMw = cors({
    origin(origin, cb) {
      // no Origin header = same-origin, curl or server-to-server (Next.js SSR)
      if (!origin || allowed.has(origin.replace(/\/+$/, ""))) return cb(null, true);
      cb(new ApiError(403, "Origin not allowed", { code: "CORS" }));
    },
    credentials: false,
    maxAge: 86400,
  });
  // PayU's return is a top-level form POST from PayU's page, so the browser sends PayU's (or a "null")
  // Origin. CORS does not apply to page navigations; this route is protected by the PayU hash and the
  // verify_payment API instead, so it skips the origin check.
  const CORS_EXEMPT = new Set(["/api/v1/payments/payu/callback", "/api/v1/payments/payu/callback/"]);
  app.use((req, res, next) => (CORS_EXEMPT.has(req.path) ? next() : corsMw(req, res, next)));
  app.use(compression());

  app.get("/health", (_req, res) => {
    const ok = dbReady();
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", db: ok ? "connected" : "disconnected", uptime: Math.round(process.uptime()), env: env.NODE_ENV });
  });

  // images & videos from GridFS
  app.get("/media/*key", serveMedia);
  app.head("/media/*key", serveMedia);

  // refuse requests while the database is down instead of hanging
  app.use("/api", (_req, _res, next) => (dbReady() ? next() : next(ApiError.unavailable("Service is starting up or the database is unavailable. Please try again shortly."))));

  app.use("/api", express.json({ limit: "1mb" }), express.urlencoded({ extended: false, limit: "100kb" }), sanitizeBody, apiLimiter);
  app.use("/api/v1", routes);

  app.get("/", (_req, res) => res.json({ name: "Rudra Jyoti API", version: "v1", health: "/health" }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
