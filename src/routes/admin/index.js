import { Router } from "express";
import { requireAdmin } from "../../middleware/auth.js";
import authRouter, { staffRouter } from "./auth.js";
import catalogRouter from "./catalog.js";
import contentRouter from "./content.js";
import dashboardRouter from "./dashboard.js";
import operationsRouter from "./operations.js";

const r = Router();

r.use("/auth", authRouter); // login is public; the rest of /auth requires a token internally
r.use(requireAdmin());
r.use("/staff", staffRouter);
r.use(dashboardRouter);
r.use(catalogRouter);
r.use(operationsRouter);
r.use(contentRouter);

export default r;
