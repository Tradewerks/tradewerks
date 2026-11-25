import { requireModule } from "../lib/entitlements/requireModule.js";
import { Router, type Request } from 'express';
import {
    ErrorCodes,
    createSuccessResponse,
    createErrorResponse,
    sendResultErr,
} from "../types/responses.js";
import { getUserContext } from '../lib/context.js';
import { REFUSAL_STATUS } from '../lib/refusalStatus.js';
import { requirePermission, requireAnyPermission, hasPermission } from '../lib/requirePermissions.js';
import { requireAssigned } from '../lib/requireAssigned.js';
import { assignedTechId } from '../lib/assignedScope.js';
import { visit_status } from "../../generated/prisma/client.js";
import type { ListSpec } from "../lib/listQuery.js";
import { singleParam } from "../lib/listSearch.js";
import { ListQueryError, markLegacyList, parseListQuery, sendList, sendListError } from '../lib/listQuery.js';
import {
    getAllJobVisits,
    listJobVisits,
    getMyJobsForPurchase,
    getJobVisitById,
    getJobVisitsByDateRange,
    getBoardVisits,
    getAssignedVisits,
    getAssignedPastVisits,
    defaultAssignedWindow,
    insertJobVisit,
    updateJobVisit,
    assignTechniciansToVisit,
    patchVisitTechnicians,
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
import { patchVisitTechniciansSchema, putVisitTechniciansSchema } from "../lib/validate/jobVisits.js";
import { db } from "../db.js";
import { isTechnicianCaller, resolveActingTechId } from "../lib/visitActor.js";
import type { Response } from "express";

const sendActorError = (res: Response, a: { err: string; status: 400 | 403 }) =>
    res.status(a.status).json(
        a.status === 403
            ? createErrorResponse(ErrorCodes.FORBIDDEN, a.err)
            : createErrorResponse(ErrorCodes.INVALID_INPUT, a.err, null, "tech_id"),
    );

const sendTransitionResult = (
    res: Response,
    result: Awaited<ReturnType<typeof applyVisitTransition>>,
) => {
    if (!result.err) return res.json(createSuccessResponse(result.item));
    const refusal = "code" in result ? result.code : undefined;
    if (!refusal) return sendResultErr(res, result.err, 409);
    const status = refusal ? REFUSAL_STATUS[refusal] : 409;
    // 409s keep the code the clients already handle.
    const code = refusal && status !== 409 ? refusal : ErrorCodes.VALIDATION_ERROR;
    return res.status(status).json(createErrorResponse(code, result.err));
};

const VISIT_LIST_SPEC = {
    sortable: ["scheduled_start_at", "status"] as const,
    defaultSort: "scheduled_start_at" as const,
    defaultDir: "asc" as const,
    statuses: Object.values(visit_status),
} satisfies ListSpec<"scheduled_start_at" | "status", visit_status>;

const router = Router();

const assignedVisit = requireAssigned("visit", ["edit_jobs"], "id");

// Caller's id when they may only see visits they're assigned to; undefined means every visit.
const ownVisitsOnly = (req: Request) => assignedTechId(req);

router.get("/", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        let parsed;
        let clientId: string | undefined;
        try {
            parsed = parseListQuery(req.query, VISIT_LIST_SPEC);
            // client_id is the list convention; clientId stays for existing callers.
            if (parsed.paged) {
                clientId = singleParam(req.query, "client_id") ?? singleParam(req.query, "clientId");
            }
        } catch (err) {
            if (sendListError(res, err)) return;
            throw err;
        }
        if (!parsed.paged) {
            // Legacy calls are never validated: stray or repeated params are ignored, not a 400.
            const raw = [req.query.client_id, req.query.clientId].flat().find(
                (v): v is string => typeof v === "string" && v.trim() !== "",
            );
            clientId = raw?.trim();
            markLegacyList(res);
            const visits = await getAllJobVisits(orgId, { clientId, techId: ownVisitsOnly(req) });
            return res.json(createSuccessResponse(visits, { count: visits.length }));
        }
        const { rows, total } = await listJobVisits(orgId, parsed, {
            clientId,
            techId: ownVisitsOnly(req),
        });
        sendList(res, parsed, rows, total);
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

const DAY_MS = 24 * 60 * 60 * 1000;
const BOARD_MAX_SPAN_DAYS = 62;
const boardQuerySchema = z
    .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        techId: z.string().uuid().optional(),
        includeUnscheduled: z.enum(["0", "1", "true", "false"]).optional(),
    })
    .refine((q) => q.to > q.from, { message: "to must be after from" })
    .refine((q) => q.to.getTime() - q.from.getTime() <= BOARD_MAX_SPAN_DAYS * DAY_MS, {
        message: `Range can span at most ${BOARD_MAX_SPAN_DAYS} days`,
    });

// Above "/:id" for the same reason as "/mine".
router.get("/board", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), async (req, res, next) => {
    try {
        const parsed = boardQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json(
                createErrorResponse(ErrorCodes.INVALID_INPUT, parsed.error.issues.map((i) => i.message).join(", ")),
            );
        }
        const { from, to, techId, includeUnscheduled } = parsed.data;
        const orgId = req.user!.organization_id as string;
        const result = await getBoardVisits(orgId, {
            from,
            to,
            techId,
            assignedTechId: ownVisitsOnly(req),
            includeUnscheduled: includeUnscheduled === "1" || includeUnscheduled === "true",
            // The rail lists jobs, not visits, so it needs what GET /jobs needs.
            canListJobs: hasPermission(req, "view_jobs"),
        });
        res.json(createSuccessResponse(result, { count: result.visits.length }));
    } catch (err) {
        next(err);
    }
});

const assignedQuerySchema = z
    .object({ from: z.coerce.date(), to: z.coerce.date() })
    .refine((q) => q.to > q.from, { message: "to must be after from" })
    .refine((q) => q.to.getTime() - q.from.getTime() <= BOARD_MAX_SPAN_DAYS * DAY_MS, {
        message: `Range can span at most ${BOARD_MAX_SPAN_DAYS} days`,
    });

// Past history's order is fixed (newest first, id tiebreak): any other `sort` is
// refused by the spec, and `dir` other than desc is refused rather than ignored.
const PAST_SPEC = {
    sortable: ["scheduled_start_at"] as const,
    defaultSort: "scheduled_start_at" as const,
    defaultDir: "desc" as const,
    defaultLimit: 20,
};

// The technician phone's list. Above "/:id" like "/mine", and keyed to the
// caller's own token for the same reason: any techId in the query is ignored.
router.get("/assigned", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        if (req.query.scope !== undefined) {
            if (req.query.scope !== "past") {
                return res.status(400).json(
                    createErrorResponse(ErrorCodes.INVALID_INPUT, "scope must be past", null, "scope"),
                );
            }
            let parsed;
            try {
                parsed = parseListQuery(req.query, PAST_SPEC);
                if (parsed.dir !== "desc") throw new ListQueryError("dir", "dir must be desc");
            } catch (err) {
                if (sendListError(res, err)) return;
                throw err;
            }
            const { rows, total } = await getAssignedPastVisits(orgId, req.user!.uid as string, parsed);
            // Always paged: this mode is new, so there is no legacy array shape to keep.
            return sendList(res, { ...parsed, paged: true }, rows, total);
        }
        let range: { from: Date; to: Date };
        if (req.query.from === undefined && req.query.to === undefined) {
            range = await defaultAssignedWindow(orgId);
        } else {
            const parsed = assignedQuerySchema.safeParse(req.query);
            if (!parsed.success) {
                return res.status(400).json(
                    createErrorResponse(ErrorCodes.INVALID_INPUT, parsed.error.issues.map((i) => i.message).join(", ")),
                );
            }
            range = parsed.data;
        }
        const visits = await getAssignedVisits(orgId, req.user!.uid as string, {
            ...range,
            // The Available tab: only callers who can accept a visit see the pool; own=1
            // (dashboard, map, mileage) skips that query.
            withClaimable:
                req.query.own !== "1" &&
                (hasPermission(req, "edit_jobs") || hasPermission(req, "update_visit_status")),
        });
        res.json(createSuccessResponse(visits, { count: visits.length }));
    } catch (err) {
        next(err);
    }
});

router.get("/:id", requireAnyPermission("view_jobs", "view_visits", "view_assigned_jobs"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const techId = assignedTechId(req);
        const visit = await getJobVisitById(
            id,
            orgId,
            techId ? {
                techId,
                // The Available tab's Details button opens a visit before it is claimed.
                withClaimable: hasPermission(req, "edit_jobs") || hasPermission(req, "update_visit_status"),
            } : undefined,
        );

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

router.put("/:id", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        if (isTechnicianCaller(context)) {
            return res.status(403).json(techUseActionsResponse());
        }
        const result = await updateJobVisit(req, orgId, context);

        if ("code" in result && result.code === "CONFLICT") {
            return res.status(409).json({
                ...createErrorResponse(ErrorCodes.CONFLICT, result.err),
                data: { current_updated_at: result.current_updated_at },
            });
        }
        if ("code" in result && result.code) {
            const status = REFUSAL_STATUS[result.code];
            const code = status === 409 ? ErrorCodes.VALIDATION_ERROR : result.code;
            return res.status(status).json(createErrorResponse(code, result.err));
        }
        if (result.err) {
            return sendResultErr(res, result.err);
        }

        res.json(createSuccessResponse(result.item));
    } catch (err) {
        next(err);
    }
});

const sendAssignmentResult = (
    res: Response,
    result: { err: string; code?: keyof typeof REFUSAL_STATUS; item?: unknown },
) => {
    if (result.err) {
        if (!result.code) return sendResultErr(res, result.err);
        return res.status(REFUSAL_STATUS[result.code]).json(createErrorResponse(result.code, result.err));
    }
    return res.json(createSuccessResponse(result.item));
};

const techAssignmentForbidden = () =>
    createErrorResponse(ErrorCodes.FORBIDDEN, "Only dispatchers can change a visit's technicians.");

router.patch("/:id/technicians", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const context = getUserContext(req);
        if (isTechnicianCaller(context)) {
            return res.status(403).json(techAssignmentForbidden());
        }
        const parsed = patchVisitTechniciansSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return res.status(400).json(
                createErrorResponse(ErrorCodes.VALIDATION_ERROR, parsed.error.issues.map((i) => i.message).join(", ")),
            );
        }
        const orgId = req.user!.organization_id as string;
        const result = await patchVisitTechnicians(req.params.id as string, parsed.data, orgId, context);
        sendAssignmentResult(res, result);
    } catch (err) {
        next(err);
    }
});

router.put("/:id/technicians", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const context = getUserContext(req);
        if (isTechnicianCaller(context)) {
            return res.status(403).json(techAssignmentForbidden());
        }

        const parsed = putVisitTechniciansSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
            return res
                .status(400)
                .json(
                    createErrorResponse(
                        ErrorCodes.INVALID_INPUT,
                        parsed.error.issues.map((i) => i.message).join(", "),
                        null,
                        "tech_ids",
                    ),
                );
        }

        const result = await assignTechniciansToVisit(id, parsed.data.tech_ids, orgId, context);
        sendAssignmentResult(res, result);
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
            if (code) {
                return res.status(REFUSAL_STATUS[code]).json(createErrorResponse(code, result.err));
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
        sendTransitionResult(res, result);
    } catch (err) {
        next(err);
    }
});

router.post("/:id/pause", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "pause", orgId, getUserContext(req));
        sendTransitionResult(res, result);
    } catch (err) {
        next(err);
    }
});

router.post("/:id/resume", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "resume", orgId, getUserContext(req));
        sendTransitionResult(res, result);
    } catch (err) {
        next(err);
    }
});

router.post("/:id/complete", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "complete", orgId, getUserContext(req));
        sendTransitionResult(res, result);
    } catch (err) {
        next(err);
    }
});

router.post("/:id/cancel", requirePermission("edit_jobs"), async (req, res, next) => {
    try {
        const context = getUserContext(req);
        if (isTechnicianCaller(context)) {
            return res.status(403).json(techUseActionsResponse());
        }
        const { cancellation_reason } = req.body as { cancellation_reason?: string };
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await cancelJobVisit(id, cancellation_reason ?? "", orgId, context);
        sendTransitionResult(res, result);
    } catch (err) {
        next(err);
    }
});

router.post("/:id/delay", requireAnyPermission("edit_jobs", "update_visit_status"), assignedVisit, async (req, res, next) => {
    try {
        const orgId = req.user!.organization_id as string;
        const id = req.params.id as string;
        const result = await applyVisitTransition(id, "delay", orgId, getUserContext(req));
        sendTransitionResult(res, result);
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

const sendPartsUsedError = (
    res: Response,
    result: { err: string; code?: keyof typeof REFUSAL_STATUS },
) => {
    if (result.code) {
        return res.status(REFUSAL_STATUS[result.code]).json(createErrorResponse(result.code, result.err));
    }
    if (result.err.toLowerCase().includes("not found")) {
        return res.status(404).json(createErrorResponse(ErrorCodes.NOT_FOUND, result.err));
    }
    return res.status(400).json(createErrorResponse(ErrorCodes.VALIDATION_ERROR, result.err));
};

router.post("/:id/parts-used", requireModule("vehicle_stock"), requireAnyPermission("edit_jobs", "use_inventory"), assignedVisit, async (req, res, next) => {
    try {
        const id = req.params.id as string;
        const orgId = req.user!.organization_id as string;
        const result = await addPartsUsed(id, req.body, orgId, getUserContext(req));
        if (result.err) return sendPartsUsedError(res, result);
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
        if (result.err) return sendPartsUsedError(res, result);
        res.json(createSuccessResponse("item" in result ? result.item : null));
    } catch (err) {
        next(err);
    }
});

// The one line write a technician has: quantity only, priced from the stored row.
const fieldLineQuantitySchema = z.object({ quantity: z.number().finite().min(0) });

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
            const status = result.code ? REFUSAL_STATUS[result.code] : 400;
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
        sendTransitionResult(res, result);
    } catch (err) {
        next(err);
    }
});

export default router;
