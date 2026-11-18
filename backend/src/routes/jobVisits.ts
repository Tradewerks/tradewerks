import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router, type Request } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
    sendResultErr,
} from "../types/responses.js";
import { getUserContext } from '../lib/context.js';
import { requirePermission, requireAnyPermission, hasPermission } from '../lib/requirePermissions.js';
import { requireAssigned } from '../lib/requireAssigned.js';
import {
    getAllJobVisits,
    getMyJobsForPurchase,
    getJobVisitById,
    getJobVisitsByDateRange,
    insertJobVisit,
    updateJobVisit,
    assignTechniciansToVisit,
    acceptJobVisit,
    cancelJobVisit,
    deleteJobVisit,
    applyVisitTransition,
    LIFECYCLE_TRANSITIONS,
    getRecentStatusEvents,
} from '../controllers/jobVisitsController.js';
import { clockInVisit, clockOutVisit } from "../controllers/visitTimeEntriesController.js";
import { addPartsUsed, updatePartsUsedQty } from "../controllers/vehiclesController.js";
import { updateFieldLineQuantity } from "../controllers/visitFieldLinesController.js";
import { z } from "zod";
import { db } from "../db.js";
import { isTechnicianCaller, resolveActingTechId } from "../lib/visitActor.js";
import type { Response } from "express";

const sendActorError = (res: Response, a: { err: string; status: 400 | 403 }) =>
    res.status(a.status).json(
        a.status === 403
            ? createErrorResponse(ErrorCodes.FORBIDDEN, a.err)
            : createErrorResponse(ErrorCodes.INVALID_INPUT, a.err, null, "tech_id"),
    );


const router = Router();

const assignedVisit = requireAssigned("visit", ["edit_jobs"], "id");

// Caller's id when they may only see visits they're assigned to; undefined means every visit.
const ownVisitsOnly = (req: Request) =>
    hasPermission(req, "view_jobs") || hasPermission(req, "view_visits") ? undefined : (req.user!.uid as string);

router.get("/", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const visits = await getAllJobVisits(orgId, { techId: ownVisitsOnly(req) });
        res.json(createSuccessResponse(visits, { count: visits.length }));
    } catch (err) {
        next(err);
    }
});

// Above "/:id", or Express reads "mine" as a visit id. The technician is the
// caller's own token — never a query param, which would make one tech's work
// readable by asking for it.
router.get("/mine", requireAnyPermission("view_assigned_jobs", "view_visits", "view_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const jobs = await getMyJobsForPurchase(orgId, req.user!.uid as string);
        res.json(createSuccessResponse(jobs, { count: jobs.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/recent-status-events", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const events = await getRecentStatusEvents(orgId, ownVisitsOnly(req));
        res.json(createSuccessResponse(events));
    } catch (err) {
        next(err);
    }
});

router.get("/:id", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), requireAssigned("visit", ["view_jobs", "view_visits"], "id"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const visit = await getJobVisitById(id, orgId);

        if (!visit) {
            return res
                .status(404)
                .json(
                    createErrorResponse(
                        ErrorCodes.NOT_FOUND,
                        "Job visit not found",
                    ),
                );
        }

        res.json(createSuccessResponse(visit));
    } catch (err) {
        next(err);
    }
});

router.get(
    "/date-range/:startDate/:endDate",
    requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"),
    async (req, res, next) => {
        try {
            const { startDate, endDate } = req.params as { startDate: string; endDate: string };
            const start = new Date(startDate);
            const end = new Date(endDate);
            const orgId = req.user!.organization_id as string;

            if (isNaN(start.getTime()) || isNaN(end.getTime())) {
                return res
                    .status(400)
                    .json(
                        createErrorResponse(
                            ErrorCodes.INVALID_INPUT,
                            "Invalid date format. Use YYYY-MM-DD",
                        ),
                    );
            }

            const visits = await getJobVisitsByDateRange(start, end, orgId, ownVisitsOnly(req));
            res.json(createSuccessResponse(visits, { count: visits.length }));
        } catch (err) {
            next(err);
        }
    },
);

router.post("/", requireAnyPermission("create_jobs", "edit_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await insertJobVisit(req, orgId, context);

        if (result.err) {
            return res
                .status(400)
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

const techUseActionsResponse = () =>
    createErrorResponse(ErrorCodes.FORBIDDEN, "Technicians update visits through the visit actions.");

router.put("/:id", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        if (isTechnicianCaller(context)) {
            return res.status(403).json(techUseActionsResponse());
        }
        const result = await updateJobVisit(req, orgId, context);

        if (result.err) {
            return sendResultErr(res, result.err);
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.put("/:id/technicians", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const { tech_ids } = req.body;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);

        if (!Array.isArray(tech_ids)) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.INVALID_INPUT,
                        "tech_ids must be an array",
                        null,
                        "tech_ids",
                    ),
                );
        }

        const result = await assignTechniciansToVisit(id, tech_ids, orgId, context);

        if (result.err) {
            return sendResultErr(res, result.err);
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/accept", requireAnyPermission("edit_jobs", "update_visit_status"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);

        const actor = resolveActingTechId(context, req.body?.tech_id);
        if ("err" in actor) return sendActorError(res, actor);

        const result = await acceptJobVisit(id, actor.techId, orgId, context);

        // Closed or already-claimed visits are a state conflict, not bad input.
        if (result.err) {
            const code = "code" in result ? result.code : undefined;
            if (code === "WRONG_STATE") {
                return res.status(409).json(createErrorResponse(code, result.err));
            }
            return sendResultErr(res, result.err, 409, ErrorCodes.CONFLICT);
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// ── Time tracking ─────────────────────────────────────────────────────────────

router.post("/:id/clock-in", requirePermission("check_in"), assignedVisit, async (req, res, next) => {
    try {
        const context = getUserContext(req);
        const actor = resolveActingTechId(context, req.body?.tech_id);
        if ("err" in actor) return sendActorError(res, actor);
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await clockInVisit(id, actor.techId, orgId, context);
        if (result.err) {
            if (result.err.startsWith("ALREADY_CLOCKED_IN:") || result.err.startsWith("TIMESHEET_LOCKED")) {
                return res.status(409).json(createErrorResponse(ErrorCodes.CONFLICT, result.err));
            }
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }
        res.status(201).json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/clock-out", requirePermission("check_out"), assignedVisit, async (req, res, next) => {
    try {
        const { tech_id, pause_reason } = (req.body ?? {}) as { tech_id?: string; pause_reason?: string };
        const context = getUserContext(req);
        const actor = resolveActingTechId(context, tech_id);
        if ("err" in actor) return sendActorError(res, actor);
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await clockOutVisit(id, actor.techId, orgId, context, pause_reason);
        if (result.err) {
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

// ── Lifecycle actions ────────────────────────────────────────────────────────

router.post("/:id/start", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "start", orgId, getUserContext(req));
        if (result.err) {
            return sendResultErr(res, result.err, 409);
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/pause", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "pause", orgId, getUserContext(req));
        if (result.err) {
            return sendResultErr(res, result.err, 409);
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/resume", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "resume", orgId, getUserContext(req));
        if (result.err) {
            return sendResultErr(res, result.err, 409);
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/complete", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "complete", orgId, getUserContext(req));
        if (result.err) {
            return sendResultErr(res, result.err, 409);
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/cancel", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const context = getUserContext(req);
        if (isTechnicianCaller(context)) {
            return res.status(403).json(techUseActionsResponse());
        }
        const { cancellation_reason } = req.body as { cancellation_reason?: string };
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await cancelJobVisit(id, cancellation_reason ?? "", orgId, context);
        if (result.err) {
            return sendResultErr(res, result.err, 409);
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.post("/:id/delay", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "delay", orgId, getUserContext(req));
        if (result.err) {
            return sendResultErr(res, result.err, 409);
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

router.delete("/:id", requirePermission("delete_jobs"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await deleteJobVisit(id, orgId, context);

        if (result.err) {
            return sendResultErr(res, result.err, 400, ErrorCodes.DELETE_ERROR);
        }

        res.status(200).json(
            createSuccessResponse({
                message: result.message || "Job visit deleted successfully",
                id,
            }),
        );
    } catch (err) {
        next(err);
    }
});

router.post("/:id/parts-used", requireModule("vehicle_stock"), requireAnyPermission("edit_jobs", "use_inventory"), assignedVisit, async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const result = await addPartsUsed(id, req.body, orgId, getUserContext(req));
        if (result.err) {
            if (result.err.toLowerCase().includes("not found")) {
                return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
            }
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }
        res.status(201).json(createSuccessResponse("item" in result ? result.item : null));
    } catch (err) {
        next(err);
    }
});

router.patch("/:id/parts-used/:lineItemId", requireModule("vehicle_stock"), requireAnyPermission("edit_jobs", "use_inventory"), assignedVisit, async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const lineItemId = req.params.lineItemId as string;
        const orgId = req.user!.organization_id as string;
        // The ledger actor is the authenticated caller (dispatcher or technician),
        // never a technician_id from the body.
        const context = getUserContext(req);
        const result = await updatePartsUsedQty(id, lineItemId, req.body, orgId, context);
        if (result.err) {
            if (result.err.toLowerCase().includes("not found")) {
                return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
            }
            return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
        }
        res.json(createSuccessResponse("item" in result ? result.item : null));
    } catch (err) {
        next(err);
    }
});

// The one line write a technician has: quantity only, priced from the stored row.
const fieldLineQuantitySchema = z.object({ quantity: z.number().finite().min(0) });
const FIELD_LINE_STATUS = { FORBIDDEN: 403, WRONG_STATE: 409, CONFLICT: 409, NOT_FOUND: 404 } as const;

router.patch("/:id/field-lines/:lineItemId", requireAnyPermission("edit_jobs", "use_inventory", "update_visit_status"), async (req, res, next) => {
    try {
        const parsed = fieldLineQuantitySchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json(
                createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues.map((i) => i.message).join(", ")),
            );
        }
        const orgId = req.user!.organization_id as string;
        const result = await updateFieldLineQuantity(
            req.params.id as string,
            req.params.lineItemId as string,
            parsed.data.quantity,
            orgId,
            getUserContext(req),
        );
        if (result.err) {
            const status = result.code ? FIELD_LINE_STATUS[result.code] : 400;
            return res.status(status).json(
                createErrorResponse(result.code ?? ErrorCodes.VALIDATION_ERROR, result.err),
            );
        }
        res.json(createSuccessResponse(result.item ?? null));
    } catch (err) {
        next(err);
    }
});

// ── Visit lifecycle routes ────────────────────────────────────────────────────

const LIFECYCLE_ACTIONS = Object.keys(LIFECYCLE_TRANSITIONS) as (keyof typeof LIFECYCLE_TRANSITIONS)[];

router.post("/:id/transition", requireAnyPermission("edit_jobs", "update_visit_status", "check_in", "check_out"), assignedVisit, async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const { action, pause_reason, tech_coords } = req.body;
        if (!action || !LIFECYCLE_ACTIONS.includes(action)) {
            return res
                .status(400)
                .json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, `Invalid action. Must be one of: ${LIFECYCLE_ACTIONS.join(", ")}.`));
        }
        const rawLat = Number(tech_coords?.lat);
        const rawLon = Number(tech_coords?.lon);
        const techCoords =
            Number.isFinite(rawLat) && Number.isFinite(rawLon)
                ? { lat: rawLat, lon: rawLon }
                : null;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        const result = await applyVisitTransition(id, action, orgId, context, pause_reason, techCoords);
        if (result.err) {
            return sendResultErr(res, result.err, 409);
        }
        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

export default router;
