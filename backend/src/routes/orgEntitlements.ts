import { Router, type Request } from "express";
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
	tierLabel,
} from "../services/entitlementService.js";
import type { ResolvedEntitlements } from "../lib/entitlements/resolve.js";
import { getUsageSummary, type UsageSummary } from "../lib/entitlements/quota.js";
import { log } from "../services/appLogger.js";
import { db } from "../db.js";
import { upgradeRequestLimiter } from "../platform/rateLimit.js";
import {
	fileRequest,
	listOwnRequests,
	requestableTiers,
	withdrawRequest,
} from "../platform/upgradeRequestService.js";

const router = Router();

// Every signed-in UI loads this endpoint; a usage read must not take module state down with it.
async function usageFor(
	orgId: string,
	limits: Record<string, number | null>,
): Promise<UsageSummary | null> {
	try {
		return await getUsageSummary(orgId, limits);
	} catch (err) {
		log.warn({ err, orgId }, "usage summary unavailable");
		return null;
	}
}

const present = (e: ResolvedEntitlements, label: string) => ({
	plan: {
		key: e.planKey,
		label,
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
		const orgId = req.user!.organization_id as string;
		const ent = await getEntitlements(orgId);
		const canSeeUsage =
			req.user!.role === "admin" ||
			(req.user!.permissions ?? []).includes("manage_organization");
		res.json(
			createSuccessResponse({
				...present(ent, await tierLabel(ent.planKey)),
				usage: canSeeUsage ? await usageFor(orgId, ent.limits) : null,
			}),
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
			res.json(
				createSuccessResponse(
					present(updated, await tierLabel(updated.planKey)),
				),
			);
		} catch (err) {
			next(err);
		}
	},
);

const fileRequestBody = z.object({
	planKey: z.string().min(1).max(40).optional(),
	modules: z.array(z.string().min(1).max(40)).max(20).optional(),
	note: z.string().max(1000).optional(),
});
const requester = async (req: Request) => {
	const user = req.user!;
	const dispatcher = await db.dispatcher.findFirst({
		where: {
			id: user.uid,
			organization_id: user.organization_id as string,
		},
		select: { name: true },
	});
	return { id: user.uid, name: dispatcher?.name ?? user.email ?? "" };
};
const orgOf = (req: Request) => req.user!.organization_id as string;

router.get(
	"/upgrade-requests",
	requirePermission("manage_organization"),
	async (req, res, next) => {
		try {
			res.json(createSuccessResponse(await listOwnRequests(orgOf(req))));
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/upgrade-requests",
	requirePermission("manage_organization"),
	upgradeRequestLimiter,
	async (req, res, next) => {
		try {
			const parsed = fileRequestBody.safeParse(req.body);
			if (!parsed.success)
				return res
					.status(400)
					.json(
						createErrorResponse(
							ErrorCodes.VALIDATION_ERROR,
							parsed.error.issues[0].message,
						),
					);
			res.status(201).json(
				createSuccessResponse(
					await fileRequest(
						orgOf(req),
						await requester(req),
						parsed.data,
					),
				),
			);
		} catch (err) {
			next(err);
		}
	},
);

router.post(
	"/upgrade-requests/:id/withdraw",
	requirePermission("manage_organization"),
	async (req, res, next) => {
		try {
			await withdrawRequest(
				orgOf(req),
				req.params.id as string,
				await requester(req),
			);
			res.json(createSuccessResponse(null));
		} catch (err) {
			next(err);
		}
	},
);

router.get(
	"/tiers",
	requirePermission("manage_organization"),
	async (req, res, next) => {
		try {
			res.json(createSuccessResponse(await requestableTiers(orgOf(req))));
		} catch (err) {
			next(err);
		}
	},
);

export default router;
