import type { Router } from "express";
import { z } from "zod";
import { createSuccessResponse } from "../../types/responses.js";
import {
	inviteStaff,
	listStaff,
	listStaffActivity,
	resendInvite,
	resetStaffMfa,
	setStaffStatus,
} from "../../platform/staffService.js";
import { actor, email, name, param, parse, staff } from "./shared.js";

export function registerStaff(router: Router): void {
	router.get("/staff", ...staff, async (_req, res) => {
		res.json(createSuccessResponse(await listStaff()));
	});

	router.get("/staff/activity", ...staff, async (_req, res) => {
		res.json(createSuccessResponse(await listStaffActivity()));
	});

	router.post("/staff", ...staff, async (req, res) => {
		const body = parse(z.object({ email, name }), req.body);
		res.status(201).json(
			createSuccessResponse(await inviteStaff(actor(req), body)),
		);
	});

	router.post("/staff/:id/resend-invite", ...staff, async (req, res) => {
		res.json(
			createSuccessResponse(
				await resendInvite(actor(req), param(req, "id")),
			),
		);
	});

	router.patch("/staff/:id", ...staff, async (req, res) => {
		const body = parse(
			z.object({ status: z.enum(["active", "disabled"]) }),
			req.body,
		);
		await setStaffStatus(actor(req), param(req, "id"), body.status);
		res.json(createSuccessResponse(null));
	});

	router.post("/staff/:id/reset-mfa", ...staff, async (req, res) => {
		await resetStaffMfa(actor(req), param(req, "id"));
		res.json(createSuccessResponse(null));
	});
}
