import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ quiet: true });

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []));

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    PORT: z.coerce.number().int().positive().default(5000),
    API_PUBLIC_URL: z.string().url().default("http://localhost:5000"),
    CLIENT_URL: z.string().url(),
    ADMIN_URL: z.string().url(),
    CORS_EXTRA_ORIGINS: csv,

    MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

    JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    JWT_ADMIN_SECRET: z.string().min(32, "JWT_ADMIN_SECRET must be at least 32 characters"),
    JWT_ACCESS_TTL: z.string().default("15m"),
    JWT_ADMIN_TTL: z.string().default("8h"),
    REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),

    OTP_PROVIDER: z.enum(["messagecentral", "console"]).default("console"),
    OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
    OTP_DEV_CODE: z.string().regex(/^\d{4,8}$/).default("123456"),
    MESSAGE_CENTRAL_CUSTOMER_ID: z.string().optional().default(""),
    MESSAGE_CENTRAL_PASSWORD: z.string().optional().default(""),
    MESSAGE_CENTRAL_EMAIL: z.string().optional().default(""),
    MESSAGE_CENTRAL_COUNTRY_CODE: z.string().regex(/^\d{1,4}$/).default("91"),
    MESSAGE_CENTRAL_FLOW_TYPE: z.enum(["SMS", "WHATSAPP"]).default("SMS"),

    PAYMENT_PROVIDER: z.enum(["paytm", "mock"]).default("mock"),
    PAYTM_MID: z.string().optional().default(""),
    PAYTM_MERCHANT_KEY: z.string().optional().default(""),
    PAYTM_WEBSITE: z.string().default("WEBSTAGING"),
    PAYTM_HOST: z.string().url().default("https://securegw-stage.paytm.in"),

    MAX_IMAGE_MB: z.coerce.number().positive().default(8),
    MAX_VIDEO_MB: z.coerce.number().positive().default(80),

    SEED_ASSETS_DIR: z.string().default("../client-site/public/assets"),
    SEED_ADMIN_EMAIL: z.string().email().default("admin@rudrajyoti.in"),
    SEED_ADMIN_PASSWORD: z.string().optional().default(""),
    SEED_ADMIN_NAME: z.string().default("Super Admin"),

    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    TRUST_PROXY: bool.optional(),
  })
  .superRefine((e, ctx) => {
    const prod = e.NODE_ENV === "production";
    if (e.OTP_PROVIDER === "messagecentral" && (!e.MESSAGE_CENTRAL_CUSTOMER_ID || !e.MESSAGE_CENTRAL_PASSWORD))
      ctx.addIssue({ code: "custom", path: ["MESSAGE_CENTRAL_CUSTOMER_ID"], message: "MESSAGE_CENTRAL_CUSTOMER_ID and MESSAGE_CENTRAL_PASSWORD are required when OTP_PROVIDER=messagecentral" });
    if (e.PAYMENT_PROVIDER === "paytm" && (!e.PAYTM_MID || !e.PAYTM_MERCHANT_KEY))
      ctx.addIssue({ code: "custom", path: ["PAYTM_MID"], message: "PAYTM_MID and PAYTM_MERCHANT_KEY are required when PAYMENT_PROVIDER=paytm" });
    if (prod && e.OTP_PROVIDER === "console") ctx.addIssue({ code: "custom", path: ["OTP_PROVIDER"], message: "OTP_PROVIDER=console is not allowed in production" });
    if (prod && e.PAYMENT_PROVIDER === "mock") ctx.addIssue({ code: "custom", path: ["PAYMENT_PROVIDER"], message: "PAYMENT_PROVIDER=mock is not allowed in production" });
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail fast with a readable list instead of crashing later with an obscure error
  console.error("\n✖ Invalid environment configuration:\n");
  for (const issue of parsed.error.issues) console.error(`  • ${issue.path.join(".") || "env"}: ${issue.message}`);
  console.error("\nCopy .env.example to .env and fill in the values.\n");
  process.exit(1);
}

const e = parsed.data;

export const env = {
  ...e,
  isProd: e.NODE_ENV === "production",
  isDev: e.NODE_ENV === "development",
  trustProxy: e.TRUST_PROXY ?? e.NODE_ENV === "production",
  corsOrigins: [...new Set([e.CLIENT_URL, e.ADMIN_URL, ...e.CORS_EXTRA_ORIGINS].map((u) => u.replace(/\/+$/, "")))],
};
