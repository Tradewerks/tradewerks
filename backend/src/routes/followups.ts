import { Router } from "express";
import type { NextFunction, Response } from "express";
import {
	ErrorCodes,
	createSuccessResponse,
	createErrorResponse,
} from "../types/responses.js";
import { requirePermission } from "../lib/requirePermissions.js";
import * as followupsController from "../controllers/followupsController.js";
import * as templatesController from "../controllers/emailTemplatesController.js";
import {
	createSequenceSchema,
	updateSequenceSchema,
	enrollSchema,
} from "../lib/validate/followups.js";
import {
	EmailTemplateCategory,
	upsertTemplateSchema,
} from "../lib/validate/emailTemplates.js";

const router = Router();

/** Validate a :category path param against the template category enum. */
function parseCategory(value: string) {
	const parsed = EmailTemplateCategory.safeParse(value);
	if (!parsed.success) throw Object.assign(new Error("Unknown template category"), { status: 404 });
	return parsed.data;
}

// Controller functions throw plain Errors with a `.status` (404/400/409) —
// see followupsController.ts. Map those to the matching HTTP response here;
// anything else falls through to the global error handler. This mirrors the
// existing ad hoc `err?.status === 404` checks in routes/invoices.ts and
// routes/quotes.ts, generalized to the handful of statuses this controller uses.
function handleControllerError(err: any, res: Response, next: NextFunction) {
	if (err?.status === 404) {
		return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, err.message));
	}
	if (err?.status === 409) {
		return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, err.message));
	}
	if (err?.status === 400) {
		return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, err.message));
	}
	next(err);
}

// ============================================================================
// Sequences
// ============================================================================

router.get("/sequences", requirePermission("view_followups"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const items = await followupsController.listSequences(orgId);
		res.json(createSuccessResponse(items, { count: items.length }));
	} catch (err) {
		next(err);
	}
});

router.get("/sequences/:id", requirePermission("view_followups"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const item = await followupsController.getSequence(req.params.id as string, orgId);
		res.json(createSuccessResponse(item));
	} catch (err) {
		handleControllerError(err, res, next);
	}
});

router.post("/sequences", requirePermission("manage_followups"), async (req, res, next) => {
	try {
		const parsed = createSequenceSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		const orgId = req.user!.organization_id as string;
		const dispatcherId = req.user!.uid;
		const item = await followupsController.createSequence(parsed.data, orgId, dispatcherId);
		res.json(createSuccessResponse(item));
	} catch (err) {
		handleControllerError(err, res, next);
	}
});

router.patch("/sequences/:id", requirePermission("manage_followups"), async (req, res, next) => {
	try {
		const parsed = updateSequenceSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		const orgId = req.user!.organization_id as string;
		const item = await followupsController.updateSequence(
			req.params.id as string,
			parsed.data,
			orgId,
		);
		res.json(createSuccessResponse(item));
	} catch (err) {
		handleControllerError(err, res, next);
	}
});

router.delete("/sequences/:id", requirePermission("manage_followups"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const result = await followupsController.deleteSequence(req.params.id as string, orgId);
		res.json(createSuccessResponse(result));
	} catch (err) {
		handleControllerError(err, res, next);
	}
});

// ============================================================================
// Enrollments
// ============================================================================

router.get("/enrollments", requirePermission("view_followups"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const status = typeof req.query.status === "string" ? req.query.status : undefined;
		const client_id = typeof req.query.client_id === "string" ? req.query.client_id : undefined;
		const items = await followupsController.listEnrollments(orgId, { status, client_id });
		res.json(createSuccessResponse(items, { count: items.length }));
	} catch (err) {
		next(err);
	}
});

router.post("/enroll", requirePermission("manage_followups"), async (req, res, next) => {
	try {
		const parsed = enrollSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		const orgId = req.user!.organization_id as string;
		const dispatcherId = req.user!.uid;
		const item = await followupsController.enroll(parsed.data, orgId, dispatcherId);
		res.json(createSuccessResponse(item));
	} catch (err) {
		handleControllerError(err, res, next);
	}
});

router.post(
	"/enrollments/:id/stop",
	requirePermission("manage_followups"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const item = await followupsController.stopEnrollment(req.params.id as string, orgId);
			res.json(createSuccessResponse(item));
		} catch (err) {
			handleControllerError(err, res, next);
		}
	},
);

// ============================================================================
// Email templates (editor + live preview)
// ============================================================================

router.get("/templates", requirePermission("view_followups"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const items = await templatesController.listTemplates(orgId);
		res.json(createSuccessResponse(items, { count: items.length }));
	} catch (err) {
		next(err);
	}
});

// Registered before "/templates/:category" so it isn't swallowed as a category.
router.get("/templates/context", requirePermission("view_followups"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const context = await templatesController.getPreviewContext(orgId);
		res.json(createSuccessResponse(context));
	} catch (err) {
		next(err);
	}
});

router.get("/templates/:category", requirePermission("view_followups"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const category = parseCategory(req.params.category as string);
		const item = await templatesController.getTemplate(orgId, category);
		res.json(createSuccessResponse(item));
	} catch (err) {
		handleControllerError(err, res, next);
	}
});

router.put("/templates/:category", requirePermission("manage_followups"), async (req, res, next) => {
	try {
		const category = parseCategory(req.params.category as string);
		const parsed = upsertTemplateSchema.safeParse(req.body);
		if (!parsed.success) {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues[0].message));
		}
		if (parsed.data.sms_body != null) {
			return res
				.status(400)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						"Follow-up templates have no text-message body",
					),
				);
		}
		const orgId = req.user!.organization_id as string;
		const dispatcherId = req.user!.uid ?? null;
		const item = await templatesController.upsertTemplate(orgId, category, parsed.data, dispatcherId);
		res.json(createSuccessResponse(item));
	} catch (err) {
		handleControllerError(err, res, next);
	}
});

router.post(
	"/templates/:category/reset",
	requirePermission("manage_followups"),
	async (req, res, next) => {
		try {
			const orgId = req.user!.organization_id as string;
			const category = parseCategory(req.params.category as string);
			const item = await templatesController.resetTemplate(orgId, category);
			res.json(createSuccessResponse(item));
		} catch (err) {
			handleControllerError(err, res, next);
		}
	},
);

export default router;
