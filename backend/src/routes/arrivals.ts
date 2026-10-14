import { Router } from "express";
import { z } from "zod";
import { ErrorCodes, createErrorResponse, createSuccessResponse } from "../types/responses.js";
import { requirePermission } from "../lib/requirePermissions.js";
import { getScopedDb } from "../lib/context.js";
import { listArrivals } from "../lib/arrivals.js";

const router = Router();

const querySchema = z.object({
	visitId: z.string().uuid().optional(),
	techId: z.string().uuid().optional(),
});

// Live arrival forecasts: the board when unfiltered, one visit's techs with visitId
router.get("/", requirePermission("view_jobs"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const parsed = querySchema.safeParse(req.query);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		const result = await listArrivals(getScopedDb(orgId), parsed.data);
		res.json(createSuccessResponse(result, { count: result.arrivals.length }));
	} catch (err) {
		next(err);
	}
});

export default router;
