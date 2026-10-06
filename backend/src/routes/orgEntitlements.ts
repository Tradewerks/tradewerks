import { Router } from "express";
import { z } from "zod";
import {
	ErrorCodes,
	createErrorResponse,
	createSuccessResponse,
} from "../types/responses.js";
import { requirePermission } from "../lib/requirePermissions.js";
import { MODULES, PERMISSION_MAP } from "../lib/entitlements/registry.js";
import {
	getEntitlements,
	previewDisable,
	setModuleChoices,
} from "../services/entitlementService.js";
import type { ResolvedEntitlements } from "../lib/entitlements/resolve.js";

const router = Router();

const present = (e: ResolvedEntitlements) => ({
	plan: {
		key: e.planKey,
		version: e.planVersion,
		trialActive: e.trialActive,
	},
	modules: MODULES.map((m) => ({
		key: m.key,
		label: m.label,
		description: m.description,
		kind: m.kind,
		requires: m.requires,
		state: e.modules[m.key],
	})),
	permissionMap: PERMISSION_MAP,
	limits: e.limits,
});

// No permission: every signed-in user's UI needs the module state.
router.get("/", async (req, res, next) => {
	try {
		res.json(
			createSuccessResponse(
				present(
					await getEntitlements(req.user!.organization_id as string),
				),
			),
		);
	} catch (err) {
		next(err);
	}
});

router.get(
	"/modules/:key/disable-preview",
	requirePermission("manage_organization"),
	async (req, res, next) => {
		try {
			res.json(
				createSuccessResponse(
					await previewDisable(
						req.user!.organization_id as string,
						req.params.key as string,
					),
				),
			);
		} catch (err) {
			next(err);
		}
	},
);

const patchSchema = z.object({ choices: z.record(z.string(), z.boolean()) });

router.patch(
	"/modules",
	requirePermission("manage_organization"),
	async (req, res, next) => {
		try {
			const parsed = patchSchema.safeParse(req.body);
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
			const { choices } = parsed.data;
			const updated = await setModuleChoices(
				req.user!.organization_id as string,
				choices,
				{
					id: req.user!.uid,
					name: req.user!.email ?? "",
					type: "dispatcher",
				},
			);
			res.json(createSuccessResponse(present(updated)));
		} catch (err) {
			next(err);
		}
	},
);

export default router;
