import { Router, type RequestHandler } from "express";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import {
	getTaxRates,
	createTaxRate,
	updateTaxRate,
	deleteTaxRate,
	getTaxGroups,
	getDefaultTaxGroup,
	createTaxGroup,
	updateTaxGroup,
	deleteTaxGroup,
	type TaxResult,
} from "../controllers/taxController.js";
import {
	getTaxSettings,
	previewAutoSwitch,
	updateTaxSettings,
} from "../controllers/taxSettingsController.js";
import {
	acknowledgeTaxReview,
	type TaxReviewKind,
} from "../controllers/taxReviewController.js";
import { getUserContext } from "../lib/context.js";
import { requirePermission } from "../lib/requirePermissions.js";

const router = Router();

// ---------------------------------------------------------------------------
// Helper — maps controller result to HTTP response without string-parsing
// ---------------------------------------------------------------------------

export function sendTaxResult<T>(
	res: import("express").Response,
	result: TaxResult<T>,
	successStatus = 200,
): void {
	if (result.ok) {
		res.status(successStatus).json(createSuccessResponse(result.item));
		return;
	}
	const ERROR_MAP: Record<string, { status: number; code: string }> = {
		NOT_FOUND:  { status: 404, code: ErrorCodes.NOT_FOUND },
		CONFLICT:   { status: 409, code: ErrorCodes.CONFLICT },
		VALIDATION: { status: 400, code: ErrorCodes.VALIDATION_ERROR },
		INTERNAL:   { status: 500, code: ErrorCodes.SERVER_ERROR },
		NOT_IN_PLAN: { status: 403, code: ErrorCodes.MODULE_NOT_IN_PLAN },
	};
	const { status, code: errCode } =
		ERROR_MAP[result.code] ?? { status: 500, code: ErrorCodes.SERVER_ERROR };
	res.status(status).json(createErrorResponse(errCode, result.message));
}

/** "Acknowledge & send": records who accepted a degraded tax path. */
export function acknowledgeTaxReviewRoute(kind: TaxReviewKind): RequestHandler {
	return async (req, res, next) => {
		try {
			const result = await acknowledgeTaxReview(
				kind,
				req.params.id as string,
				req.user!.organization_id as string,
				getUserContext(req),
			);
			sendTaxResult(res, result);
		} catch (err) {
			next(err);
		}
	};
}

// ============================================
// TAX RATE ROUTES
// ============================================

router.get("/rates", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const includeInactive = req.query.include_inactive === "true";
		const rates = await getTaxRates(orgId, includeInactive);
		res.json(createSuccessResponse(rates, { count: rates.length }));
	} catch (err) {
		next(err);
	}
});

router.post("/rates", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await createTaxRate(req.body, orgId);
		sendTaxResult(res, result, 201);
	} catch (err) {
		next(err);
	}
});

router.patch("/rates/:id", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const result = await updateTaxRate(id, req.body, orgId);
		sendTaxResult(res, result);
	} catch (err) {
		next(err);
	}
});

router.delete("/rates/:id", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const result = await deleteTaxRate(id, orgId);
		sendTaxResult(res, result);
	} catch (err) {
		next(err);
	}
});

// ============================================
// TAX GROUP ROUTES
// ============================================

// Must be before /:id to avoid route conflict
router.get("/groups/default", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const group = await getDefaultTaxGroup(orgId);
		res.json(createSuccessResponse(group));
	} catch (err) {
		next(err);
	}
});

router.get("/groups", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const includeInactive = req.query.include_inactive === "true";
		const groups = await getTaxGroups(orgId, includeInactive);
		res.json(createSuccessResponse(groups, { count: groups.length }));
	} catch (err) {
		next(err);
	}
});

router.post("/groups", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await createTaxGroup(req.body, orgId);
		sendTaxResult(res, result, 201);
	} catch (err) {
		next(err);
	}
});

router.patch("/groups/:id", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const result = await updateTaxGroup(id, req.body, orgId);
		sendTaxResult(res, result);
	} catch (err) {
		next(err);
	}
});

router.delete("/groups/:id", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const result = await deleteTaxGroup(id, orgId);
		sendTaxResult(res, result);
	} catch (err) {
		next(err);
	}
});

// ============================================
// TAX SETTINGS (mode + registered states)
// ============================================

router.get("/settings", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		res.json(createSuccessResponse(await getTaxSettings(req.user!.organization_id as string)));
	} catch (err) {
		next(err);
	}
});

router.get("/settings/auto-switch-preview", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		res.json(createSuccessResponse(await previewAutoSwitch(req.user!.organization_id as string)));
	} catch (err) {
		next(err);
	}
});

router.put("/settings", requirePermission("manage_taxes"), async (req, res, next) => {
	try {
		const result = await updateTaxSettings(
			req.user!.organization_id as string,
			req.body,
			getUserContext(req).dispatcherId ?? null,
		);
		sendTaxResult(res, result);
	} catch (err) {
		next(err);
	}
});

export default router;
