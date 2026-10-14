import { Router } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
} from "../types/responses.js";
import * as recurringPlansController from "../controllers/recurringPlansController.js";
import { getUserContext } from '../lib/context.js';
import { requirePermission } from '../lib/requirePermissions.js';
import { getEntityHistory, INVALID_HISTORY_LIMIT, parseHistoryLimit } from '../controllers/logsController.js';

const router = Router();

router.get("/", requirePermission("view_recurring_plans"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const plans = await recurringPlansController.getAllRecurringPlans(orgId);
		res.json(createSuccessResponse(plans, { count: plans.length }));
	} catch (err) {
		next(err);
	}
});

router.get("/:id", requirePermission("view_recurring_plans"), async (req, res, next) => {
	try {
		const id = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		const plan = await recurringPlansController.getRecurringPlanById(id, orgId);

		if (!plan) {
			return res
				.status(404)
				.json(
					createErrorResponse(
						ErrorCodes.NOT_FOUND,
						"Recurring plan not found",
					),
				);
		}

		res.json(createSuccessResponse(plan));
	} catch (err) {
		next(err);
	}
});

router.post("/", requirePermission("manage_recurring_plans"), async (req, res, next) => {
	try {
		const orgId = req.user!.organization_id as string;
		const context = getUserContext(req);
		const result = await recurringPlansController.insertRecurringPlan(
			req,
			orgId,
			context,
		);

		if (result.err) {
			const statusCode = result.err.includes("not found") ? 404 : 400;
			return res
				.status(statusCode)
				.json(
					createErrorResponse(
						ErrorCodes.VALIDATION_ERROR,
						result.err,
					),
				);
		}

		res.status(201).json(createSuccessResponse(result.item));
	} catch (err) {
		next(err);
	}
});


router.get("/:id/changes", requirePermission("view_recurring_plans"),  async (req, res, next) => {
	try {
		const recPlanId = req.params.id as string;
		const orgId = req.user!.organization_id as string;
		let limit: number;
		try {
			limit = parseHistoryLimit(req.query.limit);
		} catch {
			return res
				.status(400)
				.json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, INVALID_HISTORY_LIMIT));
		}

		const results = await getEntityHistory(orgId, "recurring_plan", recPlanId, limit);

		if (results.err) {
			return res
				.status(500)
				.json(createErrorResponse(ErrorCodes.SERVER_ERROR, results.err));
		}

		res.json(createSuccessResponse(results.rows, {
			count: results.rows.length,
			hasMore: results.hasMore,
			total: results.total,
		}));
	} catch (err) {
		next(err);
	}
});

export default router;