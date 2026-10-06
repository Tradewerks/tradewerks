import { Router } from "express";
import { z } from "zod";
import {
	ErrorCodes,
	createErrorResponse,
	createSuccessResponse,
} from "../types/responses.js";
import {
	requireAnyPermission,
	requirePermission,
} from "../lib/requirePermissions.js";
import {
	dismissUntrackedStockNotice,
	getUntrackedStockNotice,
} from "../services/moduleWindowService.js";

const router = Router();
const moduleKey = z.enum(["inventory", "vehicle_stock"]);

router.get(
	"/untracked-stock",
	requireAnyPermission("view_inventory", "manage_inventory"),
	async (req, res, next) => {
		try {
			const parsed = moduleKey.safeParse(req.query.module);
			if (!parsed.success) {
				return res
					.status(400)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							"module must be inventory or vehicle_stock",
						),
					);
			}
			res.json(
				createSuccessResponse(
					await getUntrackedStockNotice(
						req.user!.organization_id as string,
						parsed.data,
					),
				),
			);
		} catch (err) {
			next(err);
		}
	},
);

const dismissSchema = z.object({ module: moduleKey, on: z.coerce.date() });

router.post(
	"/untracked-stock/dismiss",
	requirePermission("manage_inventory"),
	async (req, res, next) => {
		try {
			const parsed = dismissSchema.safeParse(req.body);
			if (!parsed.success) {
				return res
					.status(400)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							parsed.error.issues[0].message,
						),
					);
			}
			await dismissUntrackedStockNotice(
				req.user!.organization_id as string,
				parsed.data.module,
				parsed.data.on,
				{ id: req.user!.uid, name: req.user!.email ?? "" },
			);
			res.json(createSuccessResponse(null));
		} catch (err) {
			next(err);
		}
	},
);

export default router;
