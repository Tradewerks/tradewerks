import { Router } from "express";
import { openDisputesRoute } from "../controllers/disputesController.js";

const router = Router();

router.get("/open", ...openDisputesRoute);

export default router;
