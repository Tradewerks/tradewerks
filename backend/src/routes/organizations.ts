import { Router } from "express";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import { 
	registerOrganization,
 } from "../controllers/organizationsController.js";
import { BUSINESS_TYPES } from "../lib/entitlements/businessTypes.js";
import { z } from "zod";
import { orgInviteLimiter, signupLimiter } from "../platform/rateLimit.js";
import { acceptOrgInvite, previewOrgInvite } from "../services/orgAdminInvite.js";
import { SIGNUP_REGION_MESSAGE, signupRegion } from "../lib/signupRegion.js";
import { log } from "../services/appLogger.js";

const router = Router();

router.get("/business-types", (_req, res) => {
	res.json(createSuccessResponse(BUSINESS_TYPES.map(({ key, label }) => ({ key, label }))));
});

router.post("/register", signupLimiter, async (req, res, next) => {
	try {
		const region = signupRegion(req);
		if (!region.allowed) {
			log.info({ evt: "signup.region_blocked", country: region.country }, "Signup refused outside the US");
			return res
				.status(403)
				.json(createErrorResponse(ErrorCodes.SIGNUP_REGION_UNAVAILABLE, SIGNUP_REGION_MESSAGE));
		}
		const result = await registerOrganization(req.body, region.country);

		if (result.err) {
			const isDuplicate = result.err.toLowerCase().includes("already exists");
			return res
				.status(isDuplicate ? 409 : 400)
				.json(
					createErrorResponse(
						isDuplicate ? ErrorCodes.CONFLICT : ErrorCodes.VALIDATION_ERROR,
						result.err,
					),
				);
		}

		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});

const inviteToken = z.string().min(20).max(200);

router.post("/invites/preview", orgInviteLimiter, async (req, res, next) => {
	try {
		const body = z.object({ token: inviteToken }).safeParse(req.body);
		if (!body.success)
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, "Invalid invite link"));
		res.json(createSuccessResponse(await previewOrgInvite(body.data.token)));
	} catch (err) {
		next(err);
	}
});

router.post("/invites/accept", orgInviteLimiter, async (req, res, next) => {
	try {
		const body = z
			.object({
				token: inviteToken,
				password: z.string().min(8, "Password must be at least 8 characters").max(128),
			})
			.safeParse(req.body);
		if (!body.success)
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, body.error.issues[0].message));
		res.json(createSuccessResponse(await acceptOrgInvite(body.data.token, body.data.password)));
	} catch (err) {
		next(err);
	}
});

export default router;
