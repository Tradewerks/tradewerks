import { Router } from "express";
import { registerAuth } from "./auth.js";
import { registerOrgs } from "./orgs.js";
import { registerTiers } from "./tiers.js";
import { registerRequests } from "./requests.js";
import { registerStaff } from "./staff.js";

const router = Router();
registerAuth(router);
registerStaff(router);
registerOrgs(router);
registerTiers(router);
registerRequests(router);

export default router;
