import multer from "multer";
import { env } from "../config/env.js";

const MB = 1024 * 1024;

export const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_IMAGE_MB * MB, files: 10 } });
export const videoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_VIDEO_MB * MB, files: 1 } });
