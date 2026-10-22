import mongoose from "mongoose";
import { env } from "./env.js";
import { logger } from "../utils/logger.js";

mongoose.set("strictQuery", true);

let listenersAttached = false;

export async function connectDB({ retries = 5 } = {}) {
  if (!listenersAttached) {
    listenersAttached = true;
    mongoose.connection.on("disconnected", () => logger.warn("MongoDB disconnected"));
    mongoose.connection.on("reconnected", () => logger.info("MongoDB reconnected"));
    mongoose.connection.on("error", (err) => logger.error({ err }, "MongoDB connection error"));
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(env.MONGODB_URI, {
        serverSelectionTimeoutMS: 15_000,
        maxPoolSize: 20,
        autoIndex: true,
      });
      logger.info({ db: mongoose.connection.name }, "MongoDB connected");
      return mongoose.connection;
    } catch (err) {
      logger.error({ err: err.message, attempt }, "MongoDB connection failed");
      if (attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, Math.min(2000 * attempt, 10_000)));
    }
  }
}

export async function disconnectDB() {
  try {
    await mongoose.disconnect();
  } catch (err) {
    logger.error({ err }, "Error while disconnecting MongoDB");
  }
}

export const dbReady = () => mongoose.connection.readyState === 1;
