import type { Router } from "express";
import { z } from "zod";
import { createSuccessResponse } from "../../types/responses.js";
import {
	approveSatisfied,
	declineRequest,
	listRequests,
	openRequestCount,
} from "../../platform/upgradeRequestService.js";
import { actor, note, param, parse, staff } from "./shared.js";

export function registerRequests(router: Router): void {
	router.get("/upgrade-requests", ...staff, async (req, res) => {
		const q = parse(
			z.object({
				status: z.enum(["open", "all"]).default("open"),
				orgId: z.string().min(1).optional(),
				page: z.coerce.number().int().min(1).max(10_000).default(1),
			}),
			req.query,
		);
		res.json(createSuccessResponse(await listRequests(q)));
	});

	router.get("/upgrade-requests/open-count", ...staff, async (_req, res) => {
		res.json(createSuccessResponse({ count: await openRequestCount() }));
	});

	router.patch("/upgrade-requests/:id", ...staff, async (req, res) => {
		const body = parse(
			z.object({ status: z.enum(["declined", "approved"]), note }),
			req.body,
		);
		const id = param(req, "id");
		if (body.status === "declined")
			await declineRequest(actor(req), id, body.note);
		else await approveSatisfied(actor(req), id, body.note);
		res.json(createSuccessResponse(null));
	});
}
