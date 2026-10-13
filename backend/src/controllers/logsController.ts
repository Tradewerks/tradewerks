import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getScopedDb } from "../lib/context.js";
import { log } from "../services/appLogger.js";
import { Prisma } from "../../generated/prisma/client.js";
import { createErrorResponse, createSuccessResponse, ErrorCodes } from "../types/responses.js";
import { FEED_EVENT_TYPES } from "../lib/activityFeedEvents.js";
import { weekRangeIn, weekStartOf } from "../lib/dayRange.js";

export type actor = "technician" | "dispatcher";
export type entity =
    | "job"
    | "quote"
    | "request"
    | "invoice"
    | "client"
    | "project"
    | "recurring_plan"
    | "vehicle"
    | "technician"
    | "dispatcher"
    | "timesheet";

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 200;

const historyLimitSchema = z.coerce.number().int().min(1).max(MAX_HISTORY_LIMIT);
export const INVALID_HISTORY_LIMIT = `limit must be an integer between 1 and ${MAX_HISTORY_LIMIT}`;

/**
 * Parses the `?limit=` query value for the change-history routes.
 * Returns DEFAULT_HISTORY_LIMIT when absent; throws a ZodError for anything
 * that is not an integer in [1, MAX_HISTORY_LIMIT] so the route can answer 400
 * instead of handing Prisma a negative/fractional `take`.
 */
export const parseHistoryLimit = (raw: unknown): number => {
    if (raw === undefined || raw === null || raw === "") return DEFAULT_HISTORY_LIMIT;
    return historyLimitSchema.parse(raw);
};

const RENDERABLE = {
    OR: [
        { action: { not: "updated" } },
        {
            AND: [
                { changes: { not: Prisma.DbNull } },
                { changes: { not: {} } },
            ],
        },
    ],
};

/**
 * Read-side denylist for the change-history views. Credential and session
 * events (password changes/resets, logins, MFA, OAuth) are audit-only and are
 * never surfaced through /:id/changes, whatever the caller's permissions.
 */
const SENSITIVE_EVENT_PREFIXES = ["auth.", "mfa.", "oauth"] as const;
const NOT_SENSITIVE_EVENT = {
    NOT: [
        ...SENSITIVE_EVENT_PREFIXES.map((prefix) => ({ event_type: { startsWith: prefix } })),
        { event_type: { contains: ".password." } },
    ],
};

// Keys that must never leave the server inside `changes`, even on otherwise
// harmless events (defence in depth on top of the event-type denylist).
const SENSITIVE_CHANGE_KEY = /password|token|secret|otp|mfa/i;

export const redactSensitiveChanges = <T extends { changes: unknown }>(row: T): T => {
    const changes = row.changes;
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) return row;
    const entries = Object.entries(changes as Record<string, unknown>);
    if (!entries.some(([key]) => SENSITIVE_CHANGE_KEY.test(key))) return row;
    return {
        ...row,
        changes: Object.fromEntries(entries.filter(([key]) => !SENSITIVE_CHANGE_KEY.test(key))),
    };
};

// "agent" rows carry the HUMAN in actor_id, so pairing the type with an actor_id
// filter (as getActorHistory does) keeps them scoped to that one person — there
// is no cross-contamination from listing it under both buckets. A dispatcher
// reviewing someone's activity should see what that person's agent did for them.
const ACTOR_TYPES: Record<actor, string[]> = {
    technician: ["technician", "agent"],
    dispatcher: ["dispatcher", "admin", "agent"],
}

type ScopedDb = ReturnType<typeof getScopedDb>;

type log_row = Prisma.logGetPayload<Record<string, never>>;

type GroupMember = {
    entity_type: string;
    resolve?: (sdb: ScopedDb, parentId: string) => Promise<string[]>;
};

const pluck = (rows: { id: string }[]) => rows.map((r) => r.id);

/**
 * Parent breadcrumb on child log rows.
 *
 * Child ids for an entity's history are resolved from the *current* child
 * tables, so a `*.deleted` row for a child that no longer exists would never be
 * matched. Child-delete log sites therefore stamp the parent on the row itself:
 *
 *   changes: { ..., _parent_type: { old: null, new: "job" }, _parent_id: { old: null, new: "<jobId>" } }
 *
 * `_`-prefixed keys are treated as breadcrumbs (hidden from the rendered rows)
 * by the frontend formatter, and the `{ old, new }` shape keeps the ChangeSet
 * contract. getEntityHistory ORs `changes->_parent_id->new == <id>` into the
 * lookup for every child entity type of the group (Postgres JSON path filter).
 */
export const PARENT_ID_PATH = ["_parent_id", "new"] as const;

export const timesheetWeekId = (technicianId: string, weekStart: Date) =>
    `${technicianId}:${weekStart.toISOString().slice(0, 10)}`;

const weekShiftIds = async (sdb: ScopedDb, id: string) => {
    const [techId, date] = id.split(":");
    const tech = await sdb.technician.findFirst({
        where: { id: techId },
        select: { organization: { select: { timezone: true } } },
    });
    if (!tech) return [];
    const { start, end } = weekRangeIn(weekStartOf(date), tech.organization?.timezone ?? "UTC");
    return sdb.technician_shift
        .findMany({ where: { tech_id: techId, started_at: { gte: start, lt: end } }, select: { id: true } })
        .then(pluck);
};

export const parentBreadcrumb = (type: entity, id: string) => ({
    _parent_type: { old: null, new: type },
    _parent_id: { old: null, new: id },
});

const ENTITY_GROUPS: Record<entity, GroupMember[]> = {
    job: [
        { entity_type: "job" },
        {
            entity_type: "job_visit",
            resolve: (sdb, jobId) =>
                sdb.job_visit
                    .findMany({ where: { job_id: jobId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "job_line_item",
            resolve: (sdb, jobId) =>
                sdb.job_line_item
                    .findMany({ where: { job_id: jobId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "job_note",
            resolve: (sdb, jobId) =>
                sdb.job_note
                    .findMany({ where: { job_id: jobId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "quote",
            resolve: (sdb, jobId) =>
                sdb.job
                    .findUnique({ where: { id: jobId }, select: { quote_id: true } })
                    .then((j) => (j?.quote_id ? [j.quote_id] : [])),
        },
        {
            entity_type: "request",
            resolve: (sdb, jobId) =>
                sdb.job
                    .findUnique({ where: { id: jobId }, select: { request_id: true } })
                    .then((j) => (j?.request_id ? [j.request_id] : [])),
        },
    ],
    quote: [
        { entity_type: "quote" },
        {
            entity_type: "quote_line_item",
            resolve: (sdb, quoteId) =>
                sdb.quote_line_item
                    .findMany({ where: { quote_id: quoteId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "quote_note",
            resolve: (sdb, quoteId) =>
                sdb.quote_note
                    .findMany({ where: { quote_id: quoteId }, select: { id: true } })
                    .then(pluck),
        },
    ],
    request: [
        { entity_type: "request" },
        {
            entity_type: "request_note",
            resolve: (sdb, requestId) =>
                sdb.request_note
                    .findMany({ where: { request_id: requestId }, select: { id: true } })
                    .then(pluck),
        },
    ],
    invoice: [
        { entity_type: "invoice" },
        {
            entity_type: "invoice_note",
            resolve: (sdb, invoiceId) =>
                sdb.invoice_note
                    .findMany({ where: { invoice_id: invoiceId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "invoice_payment",
            resolve: (sdb, invoiceId) =>
                sdb.invoice_payment
                    .findMany({ where: { invoice_id: invoiceId }, select: { id: true } })
                    .then(pluck),
        },
    ],
    client: [
        { entity_type: "client" },
        {
            entity_type: "client_note",
            resolve: (sdb, clientId) =>
                sdb.client_note
                    .findMany({ where: { client_id: clientId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "contact",
            resolve: (sdb, clientId) =>
                sdb.client_contact
                    .findMany({ where: { client_id: clientId }, select: { contact_id: true } })
                    .then((rows) => rows.map((r) => r.contact_id)),
        },
    ],
    project: [
        { entity_type: "project" },
        {
            entity_type: "job",
            resolve: (sdb, projectId) =>
                sdb.job
                    .findMany({ where: { project_id: projectId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "project_note",
            resolve: (sdb, projectId) =>
                sdb.project_note
                    .findMany({ where: { project_id: projectId }, select: { id: true } })
                    .then(pluck),
        },
    ],
    recurring_plan: [
        { entity_type: "recurring_plan" },
        {
            entity_type: "recurring_plan_note",
            resolve: (sdb, planId) =>
                sdb.recurring_plan_note
                    .findMany({ where: { recurring_plan_id: planId }, select: { id: true } })
                    .then(pluck),
        },
        {
            entity_type: "recurring_occurrence",
            resolve: (sdb, planId) =>
                sdb.recurring_occurrence
                    .findMany({ where: { recurring_plan_id: planId }, select: { id: true } })
                    .then(pluck),
        },
    ],
    vehicle: [
        { entity_type: "vehicle" },
        {
            entity_type: "vehicle_stock_item",
            resolve: (sdb, vehicleId) =>
                sdb.vehicle_stock_item
                    .findMany({ where: { vehicle_id: vehicleId }, select: { id: true }})
                    .then(pluck),
        },
        {
            entity_type: "vehicle_stock_adjustment",
            resolve: (sdb, vehicleId) =>
                sdb.vehicle_stock_adjustment
                    .findMany({ where: { vehicle_id: vehicleId }, select: { id: true }})
                    .then(pluck),
        },
        {
            entity_type: "vehicle_restock_request",
            resolve: (sdb, vehicleId) =>
                sdb.vehicle_restock_request
                    .findMany({ where: { stock_item: { vehicle_id: vehicleId } }, select: { id: true }})
                    .then(pluck),
        },
        {
            entity_type: "vehicle_restock_record",
            resolve: (sdb, vehicleId) =>
                sdb.vehicle_restock_record
                    .findMany({ where: { vehicle_id: vehicleId }, select: { id: true }})
                    .then(pluck),
        },
        {
            entity_type: "vehicle_maintenance_record",
            resolve: (sdb, vehicleId) =>
                sdb.vehicle_maintenance_record
                    .findMany({ where: { vehicle_id: vehicleId }, select: { id: true }})
                    .then(pluck),
        },
        {
            entity_type: "vehicle_maintenance_reminder",
            resolve: (sdb, vehicleId) =>
                sdb.vehicle_maintenance_reminder
                    .findMany({ where: { vehicle_id: vehicleId }, select: { id: true }})
                    .then(pluck),
        },
    ],
    // Matches on entity_id = the target user's own id, so any update logged
    // against their record (name/status edits, role assignment, etc.) surfaces
    // here regardless of who the actor was.
    technician: [{ entity_type: "technician" }, { entity_type: "organization_role_assignment" }],
    dispatcher: [{ entity_type: "dispatcher" }, { entity_type: "organization_role_assignment" }],
    // Id is timesheetWeekId(); the timesheet_week row is deleted on unapprove, so its rows carry the breadcrumb.
    timesheet: [
        {
            entity_type: "timesheet",
            resolve: async (sdb, id) => {
                const [techId, date] = id.split(":");
                const week = await sdb.timesheet_week.findFirst({
                    where: { technician_id: techId, week_start: weekStartOf(date) },
                    select: { id: true },
                });
                return week ? [week.id] : [];
            },
        },
        {
            entity_type: "technician_shift",
            resolve: (sdb, id) => weekShiftIds(sdb, id),
        },
        {
            entity_type: "shift_correction",
            resolve: async (sdb, id) =>
                sdb.shift_correction
                    .findMany({ where: { shift_id: { in: await weekShiftIds(sdb, id) } }, select: { id: true } })
                    .then(pluck),
        },
    ],
};

export const getActorHistory = async (orgId: string, type: actor, id: string, limit = DEFAULT_HISTORY_LIMIT) => {
    try {
        const actorTypes = ACTOR_TYPES[type];
        if (!actorTypes) return { err: `Unknown actor type: ${type}`, rows: [] as log_row[], hasMore: false, total: 0 };

        const sdb = getScopedDb(orgId);
        const scopedWhere = {
            AND: [{ actor_type: { in: actorTypes }, actor_id: id }, RENDERABLE, NOT_SENSITIVE_EVENT],
        };

        const [rows, total] = await Promise.all([
            sdb.log.findMany({
                where: scopedWhere,
                orderBy: [{ timestamp: "desc" }, { id: "desc"}],
                take: limit + 1,
            }),
            sdb.log.count({ where: scopedWhere }),
        ]);

        const hasMore = rows.length > limit;
        const page = (hasMore ? rows.slice(0, limit) : rows).map(redactSensitiveChanges);

        return { err: "", rows: page, hasMore, total };

    } catch (err) {
        if (err instanceof Error) {
            return { err: err.message, rows: [] as log_row[], hasMore: false, total: 0 };
        }
        log.error({ err }, "Get actor history error");
        return { err: "Internal server error", rows: [] as log_row[], hasMore: false, total: 0 };
    }
};

// Builds the OR-clause matching every log row for an entity group (the entity's
// own rows plus its children, including children resolved via parent breadcrumb
// for rows whose child no longer exists). Shared by getEntityHistory and
// getUserHistory so the latter can fold entity rows into a single query
// alongside the actor filter rather than merging two separate paginated sets.
const buildEntityOr = async (
    sdb: ScopedDb,
    type: entity,
    id: string,
): Promise<Prisma.logWhereInput[] | null> => {
    const group = ENTITY_GROUPS[type];
    if (!group) return null;

    const groups = await Promise.all(
        group.map(async (member) => ({
            entity_type: member.entity_type,
            ids: member.resolve ? await member.resolve(sdb, id) : [id],
        })),
    );

    const scopedOr: Prisma.logWhereInput[] = groups
        .filter((g) => g.ids.length > 0)
        .map((g) => ({ entity_type: g.entity_type, entity_id: { in: g.ids } }));

    // Children that no longer exist (deleted rows) can't be resolved from
    // the child tables — match them through the parent breadcrumb instead.
    const breadcrumbOr: Prisma.logWhereInput[] = group
        .filter((member) => member.resolve)
        .map((member) => ({
            entity_type: member.entity_type,
            changes: { path: [...PARENT_ID_PATH], equals: id },
        }));
    scopedOr.push(...breadcrumbOr);

    // Only the delete row carries the breadcrumb; pull in the deleted child's earlier rows by id.
    if (breadcrumbOr.length > 0) {
        const deletedChildren = await sdb.log.findMany({
            where: { OR: breadcrumbOr },
            select: { entity_type: true, entity_id: true },
            distinct: ["entity_type", "entity_id"],
        });
        for (const child of deletedChildren) {
            scopedOr.push({ entity_type: child.entity_type, entity_id: child.entity_id });
        }
    }

    return scopedOr;
};

export const getEntityHistory = async (orgId: string, type: entity, id: string, limit = DEFAULT_HISTORY_LIMIT) => {
    try {
        const sdb = getScopedDb(orgId);
        const scopedOr = await buildEntityOr(sdb, type, id);
        if (!scopedOr) return { err: `Unknown entity type: ${type}`, rows: [] as log_row[], hasMore: false, total: 0 };

        const scopedWhere = { AND: [{ OR: scopedOr }, RENDERABLE, NOT_SENSITIVE_EVENT] };

        const [rows, total] = await Promise.all([
            sdb.log.findMany({
                where: scopedWhere,
                orderBy: [{ timestamp: "desc" }, { id: "desc"}],
                take: limit + 1,
            }),
            sdb.log.count({ where: scopedWhere }),
        ]);

        const hasMore = rows.length > limit;
        const page = (hasMore ? rows.slice(0, limit) : rows).map(redactSensitiveChanges);

        return { err: "", rows: page, hasMore, total };
    } catch (err) {
        if (err instanceof Error) {
            return { err: err.message, rows: [] as log_row[], hasMore: false, total: 0 };
        }
        log.error({ err }, "Get entity history error");
        return { err: "Internal server error", rows: [] as log_row[], hasMore: false, total: 0 };
    }
};

/**
 * Change history for a technician/dispatcher: everything they DID (actor rows)
 * unioned with everything that happened TO their own user record (entity rows —
 * profile edits, role assignment, etc.), so an edit made by someone else still
 * shows up here. A single query rather than merging two separately-paginated
 * result sets, so hasMore/total stay exact.
 */
export const getUserHistory = async (orgId: string, type: actor, id: string, limit = DEFAULT_HISTORY_LIMIT) => {
    try {
        const actorTypes = ACTOR_TYPES[type];
        if (!actorTypes) return { err: `Unknown actor type: ${type}`, rows: [] as log_row[], hasMore: false, total: 0 };

        const sdb = getScopedDb(orgId);
        const entityOr = (await buildEntityOr(sdb, type, id)) ?? [];

        const scopedWhere = {
            AND: [
                { OR: [{ actor_type: { in: actorTypes }, actor_id: id }, ...entityOr] },
                RENDERABLE,
                NOT_SENSITIVE_EVENT,
            ],
        };

        const [rows, total] = await Promise.all([
            sdb.log.findMany({
                where: scopedWhere,
                orderBy: [{ timestamp: "desc" }, { id: "desc"}],
                take: limit + 1,
            }),
            sdb.log.count({ where: scopedWhere }),
        ]);

        const hasMore = rows.length > limit;
        const page = (hasMore ? rows.slice(0, limit) : rows).map(redactSensitiveChanges);

        return { err: "", rows: page, hasMore, total };
    } catch (err) {
        if (err instanceof Error) {
            return { err: err.message, rows: [] as log_row[], hasMore: false, total: 0 };
        }
        log.error({ err }, "Get user history error");
        return { err: "Internal server error", rows: [] as log_row[], hasMore: false, total: 0 };
    }
};

// ============================================================
// ACTIVITY FEED (GET /logs/recent)
// ============================================================

// technician.updated carries contact details and GPS coords — keep the event in
// the feed (status changes are useful) but never ship the PII diffs.
const FEED_PII_KEYS: Record<string, ReadonlySet<string>> = {
    "technician.updated": new Set(["email", "phone", "coords", "hire_date", "last_login"]),
};

// Dispute reasons and resolution notes are free text written from a client's
// complaint, and the org socket room also reaches technician sockets
// (OPEN-QUESTIONS B1). The detail page still shows them behind view_*.
const FEED_REASON_REDACTED: ReadonlySet<string> = new Set([
    "quote.dispute_opened",
    "quote.dispute_resolved",
    "invoice.dispute_opened",
    "invoice.dispute_resolved",
    // A failed send carries the email provider's own rejection text, which names
    // the sending domain, the recipient's domain and the account's approval
    // state. Same rule as a dispute reason: useful on the detail page behind
    // view_*, not something to broadcast to every socket in the org.
    "quote.send_failed",
    "invoice.send_failed",
]);

export const redactFeedRow = <T extends { event_type: string; changes: unknown; reason?: string | null }>(
    row: T,
): T => {
    const base = FEED_REASON_REDACTED.has(row.event_type) && row.reason != null ? { ...row, reason: null } : row;
    const denied = FEED_PII_KEYS[base.event_type];
    const changes = base.changes;
    if (!denied || !changes || typeof changes !== "object" || Array.isArray(changes)) return base;
    const entries = Object.entries(changes as Record<string, unknown>);
    if (!entries.some(([key]) => denied.has(key))) return base;
    return { ...base, changes: Object.fromEntries(entries.filter(([key]) => !denied.has(key))) };
};

const FEED_DEFAULT_LIMIT = 25;
const FEED_MAX_LIMIT = 50;
const FEED_VIEWER_PERMISSIONS = ["view_dispatchers", "view_technicians"];

const forbidden = (res: Response) =>
    res.status(403).json(createErrorResponse(ErrorCodes.INVALID_CREDENTIALS, "Insufficient permissions"));

/**
 * Access rule for the activity feed:
 *  - `?userId=<own id>`: anyone may read their own activity;
 *  - `?userId=<someone else>`: needs view_dispatchers or view_technicians (admin passes);
 *  - unfiltered org-wide feed: dispatchers/admins only — technicians are denied.
 */
export const requireFeedAccess = (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return forbidden(res);
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    if (userId && userId === user.uid) return next();
    if (user.role === "admin") return next();
    if (userId) {
        const perms = Array.isArray(user.permissions) ? user.permissions : [];
        return FEED_VIEWER_PERMISSIONS.some((p) => perms.includes(p)) ? next() : forbidden(res);
    }
    return user.role === "technician" ? forbidden(res) : next();
};

export const getRecentActivity = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const limit = Math.min(Number(req.query.limit) || FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);
        const cursor = req.query.cursor as string | undefined;
        const userId = req.query.userId as string | undefined;
        const orgId = req.user!.organization_id as string;
        const sdb = getScopedDb(orgId);
        const logs = await sdb.log.findMany({
            where: {
                event_type: { in: [...FEED_EVENT_TYPES] },
                ...(cursor ? { timestamp: { lt: new Date(cursor) } } : {}),
                ...(userId ? { OR: [{ actor_id: userId }, { entity_id: userId }] } : {}),
            },
            orderBy: { timestamp: "desc" },
            take: limit,
        });
        const hasMore = logs.length === limit;
        res.json(createSuccessResponse(logs.map(redactFeedRow), { count: logs.length, hasMore }));
    } catch (err) {
        next(err);
    }
};

export const recentActivityRoute = [requireFeedAccess, getRecentActivity];
