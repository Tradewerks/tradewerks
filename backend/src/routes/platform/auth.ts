import type { Router } from "express";
import { z } from "zod";
import { createSuccessResponse } from "../../types/responses.js";
import {
	PASSWORD_SCHEMA,
	acceptInvite,
	exchangeEnrollLink,
	getSetupAvailable,
	previewInvite,
	setupFirstStaff,
	staffEnrollFinish,
	staffEnrollStart,
	staffLogin,
	staffVerifyMfa,
} from "../../platform/authService.js";
import { bearer, email, gate, name, open, parse } from "./shared.js";

export function registerAuth(router: Router): void {
	router.get("/setup", ...gate, async (_req, res) => {
		res.json(createSuccessResponse({ available: await getSetupAvailable() }));
	});

	router.post("/setup", ...open, async (req, res) => {
		const body = parse(
			z.object({
				code: z.string().min(1).max(200),
				email,
				name,
				password: PASSWORD_SCHEMA,
			}),
			req.body,
		);
		res.json(createSuccessResponse(await setupFirstStaff(body)));
	});

	router.post("/auth/login", ...open, async (req, res) => {
		const body = parse(
			z.object({ email, password: z.string().min(1).max(128) }),
			req.body,
		);
		res.json(
			createSuccessResponse(await staffLogin(body.email, body.password)),
		);
	});

	router.post("/auth/mfa", ...open, async (req, res) => {
		const body = parse(
			z.object({
				code: z.string().max(10).optional(),
				recoveryCode: z.string().max(20).optional(),
			}),
			req.body,
		);
		res.json(createSuccessResponse(await staffVerifyMfa(bearer(req), body)));
	});

	router.post("/auth/mfa/enroll/link", ...open, async (req, res) => {
		const body = parse(
			z.object({ token: z.string().min(20).max(200) }),
			req.body,
		);
		res.json(createSuccessResponse(await exchangeEnrollLink(body.token)));
	});

	router.post("/auth/mfa/enroll/start", ...open, async (req, res) => {
		res.json(createSuccessResponse(await staffEnrollStart(bearer(req))));
	});

	router.post("/auth/mfa/enroll", ...open, async (req, res) => {
		const body = parse(z.object({ code: z.string().max(10) }), req.body);
		res.json(
			createSuccessResponse(await staffEnrollFinish(bearer(req), body.code)),
		);
	});

	router.post("/invites/preview", ...open, async (req, res) => {
		const body = parse(
			z.object({ token: z.string().min(20).max(200) }),
			req.body,
		);
		res.json(createSuccessResponse(await previewInvite(body.token)));
	});

	router.post("/invites/accept", ...open, async (req, res) => {
		const body = parse(
			z.object({
				token: z.string().min(20).max(200),
				name,
				password: PASSWORD_SCHEMA,
			}),
			req.body,
		);
		res.json(
			createSuccessResponse(
				await acceptInvite(body.token, body.name, body.password),
			),
		);
	});
}
