import z, { ZodError } from "zod";
import type { technician_shift } from "../../generated/prisma/client.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { localDateString, weekRangeIn, weekStartOf } from "../lib/dayRange.js";
import { approveTimesheetSchema, editShiftSchema, reviewCorrectionSchema } from "../lib/validate/timesheets.js";
import { logActivity } from "../services/logger.js";
import { deleteTimeActivity } from "../services/qb/qbTimeActivity.js";
import { createNotification, notifyDispatchers } from "./notificationsController.js";
import { parentBreadcrumb, timesheetWeekId } from "./logsController.js";

export const TIMESHEET_LOCKED = "TIMESHEET_LOCKED: This week's timesheet is approved. Ask a dispatcher to unapprove it.";

export async function isWeekLocked(orgId: string, techId: string, at = new Date()) {
    const sdb = getScopedDb(orgId);
    const org = await sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true } });
    const week = await sdb.timesheet_week.findFirst({
        where: {
            technician_id: techId,
            week_start: weekStartOf(localDateString(at, org?.timezone ?? "UTC")),
            approved_at: { not: null },
        },
        select: { id: true },
    });
    return !!week;
}

const logCrumbs = (day: string, note?: string) => ({
    _day: { old: null, new: day },
    ...(note && { _note: { old: null, new: note } }),
});

type ShiftEdit = Exclude<Awaited<ReturnType<typeof checkShiftEdit>>, { err: string }>;

function diffShiftEdit(shift: technician_shift, edit: ShiftEdit) {
    const changes: Record<string, { old: Date | null; new: Date }> = {};
    const track = (key: string, oldV: Date | null, newV: Date) => {
        if (oldV?.getTime() !== newV.getTime()) changes[key] = { old: oldV, new: newV };
    };
    track("started_at", shift.started_at, edit.start);
    track("ended_at", shift.ended_at, edit.end);
    for (const b of edit.breakEdits) {
        const old = edit.existingBreaks.find((x) => x.id === b.id)!;
        track(`break.${b.id}.started_at`, old.started_at, b.started_at);
        track(`break.${b.id}.ended_at`, old.ended_at, b.ended_at);
    }
    for (const e of edit.entryEdits) {
        const old = edit.existingEntries.find((x) => x.id === e.id)!;
        track(`entry.${e.id}.clocked_in_at`, old.clocked_in_at, e.clocked_in_at);
        track(`entry.${e.id}.clocked_out_at`, old.clocked_out_at, e.clocked_out_at);
    }
    return changes;
}

async function shiftDayAndWeek(orgId: string, startedAt: Date) {
    const org = await getScopedDb(orgId).organization.findFirst({ where: { id: orgId }, select: { timezone: true } });
    const tz = org?.timezone ?? "UTC";
    return {
        day: startedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz }),
        week: weekStartOf(localDateString(startedAt, tz)).toISOString().slice(0, 10),
    };
}

/** Message-shaped errors reach the route as 400/404; anything else rethrows. */
function toErr(err: unknown): { err: string } {
    if (err instanceof ZodError) {
        return { err: `Validation failed: ${err.issues.map((i) => i.message).join(", ")}` };
    }
    if (err instanceof Error) return { err: err.message };
    throw err;
}

// No date = the current week, by the org's wall clock.
export async function getTimesheets(orgId: string, date?: string) {
    const sdb = getScopedDb(orgId);

    if (!date) {
        const org = await sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true } });
        date = localDateString(new Date(), org?.timezone ?? "UTC");
    }

    return sdb.timesheet_week.findMany({
        where: { week_start: weekStartOf(date) },
    });
}

export async function getTimesheetsByTechnician(orgId: string, technicianId: string) {
    const sdb = getScopedDb(orgId);

    return sdb.timesheet_week.findMany({
        where: { technician_id: technicianId },
        orderBy: { week_start: "desc" },
    });
}

export async function insertTimesheet (orgId: string, data: unknown, context?: UserContext) {
    try {
        if (!context?.dispatcherId) return { err: "Only dispatchers can approve timesheets" };
        const { technician_id, date } = approveTimesheetSchema.parse(data);
        const sdb = getScopedDb(orgId);

        const tech = await sdb.technician.findFirst({
            where: { id: technician_id },
            select: { id: true },
        });
        if (!tech) return { err: "Technician not found"};

        const weekStart = weekStartOf(date);
        const existing = await sdb.timesheet_week.findFirst({ where: { technician_id, week_start: weekStart}});
        if (existing?.approved_at) return { err: "Week already approved" };

        const org = await sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true } });
        const { start, end } = weekRangeIn(weekStart, org?.timezone ?? "UTC");
        const shifts = await sdb.technician_shift.findMany({
            where: { tech_id: technician_id, started_at: { gte: start, lt: end } },
            select: { ended_at: true },
        });
        if (shifts.length === 0) return { err: "No completed shifts this week" };
        if (shifts.some((s) => !s.ended_at)) return { err: "A shift this week is still open" };
        const openEntry = await sdb.visit_tech_time_entry.findFirst({
            where: { tech_id: technician_id, clocked_out_at: null, clocked_in_at: { gte: start, lt: end } },
            select: { id: true },
        });
        if (openEntry) return { err: "A visit clock-in this week is still open" };

        const approval = { approved_at: new Date(), approved_by_dispatcher_id: context.dispatcherId };
        const timesheet = await sdb.timesheet_week.upsert({
            where: { technician_id_week_start: { technician_id, week_start: weekStart}},
            create: { organization_id: orgId, week_start: weekStart, technician_id, ...approval},
            update: { ...approval, qb_sync_status: "not_synced", qb_synced_at: null, qb_error: null },
        });

        await logActivity({
            event_type: "timesheet.created",
            action: "approved",
            entity_type: "timesheet",
            entity_id: timesheet.id,
            organization_id: orgId,
            actor_type: "dispatcher",
            actor_id: context.dispatcherId,
            changes: parentBreadcrumb("timesheet", timesheetWeekId(technician_id, weekStart)),
        });

        return { timesheet };
    } catch (err) {
        return toErr(err);
    }
}

export async function deleteTimesheet (orgId: string, data: unknown, context?: UserContext) {
    try {
        if (!context?.dispatcherId) return { err: "Only dispatchers can unapprove timesheets" };
        const { technician_id, date } = approveTimesheetSchema.parse(data);

        const sdb = getScopedDb(orgId);
        const weekStart = weekStartOf(date);

        const existing = await sdb.timesheet_week.findFirst({
            where: { technician_id, week_start: weekStart }
        });
        if (!existing) return { err: "Timesheet not found" };
        if (existing.qb_sync_status !== "not_synced") await deleteTimeActivity(orgId, technician_id, date);

        const timesheet = await sdb.timesheet_week.delete({ where: { id: existing.id } });

        await logActivity({
            event_type: "timesheet.deleted",
            action: "unapproved",
            entity_type: "timesheet",
            entity_id: timesheet.id,
            organization_id: orgId,
            actor_type: "dispatcher",
            actor_id: context.dispatcherId,
            changes: parentBreadcrumb("timesheet", timesheetWeekId(technician_id, weekStart)),
        })

        return { timesheet };
    } catch (err) {
        return toErr(err);
    }
}

type Span = { start: Date; end: Date; label: string; sub: string };
type SegType = "job" | "drive" | "break" | "unassigned";
type Segment = Span & { type: SegType; paid?: boolean };

export function buildShiftSegments (
    shift: { start: Date; end: Date },
    jobs: Span[],
    drives: Span[],
    breaks: (Span & { paid: boolean })[],
): Segment[] {
    const segments: Segment[] = [];
    const tagged: Segment[] = []
    for (const job of jobs){
        tagged.push({ ...job, type: "job",});
    }
    for (const drive of drives){
        tagged.push({ ...drive, type: "drive",});
    }
    for (const b of breaks){
        tagged.push({ ...b, type: "break", paid: b.paid } )
    }

    const clip = (s: Segment) => ({
        ...s,
        start: s.start > shift.start ? s.start : shift.start,
        end: s.end < shift.end ? s.end : shift.end,
    });
    const items = tagged.map(clip).filter((s) => s.end > s.start);
   
    const times = [...new Set([shift.start, shift.end, ...items.flatMap((s) => [s.start, s.end])].map((d) => d.getTime()))].sort((a, b) => a - b);

    const PRIORITY = { break: 3, job: 2, drive: 1, unassigned: 0 };
    for (let i = 0; i < times.length - 1; i++){
        const t0 = times[i];
        const t1 = times[i+1];

        const winner = items
            .filter((s)=> s.start.getTime() <= t0 && s.end.getTime() >= t1)
            .sort((a,b) => PRIORITY[b.type] - PRIORITY[a.type])[0];
        
        const seg: Segment = winner 
            ? { ...winner, start: new Date(t0), end: new Date(t1) } 
            : { type: "unassigned", start: new Date(t0), end: new Date(t1), label: "No job or status recorded", sub: ""};
        const prev = segments[segments.length - 1];
        if (prev && prev.type === seg.type && prev.label === seg.label && prev.sub === seg.sub) {
            prev.end = seg.end;
        } else {
            segments.push(seg);
        }
    }

    return segments;
}

export async function getTechnicianWeek (orgId: string, technicianId: string, date?: string) {
    const sdb = getScopedDb(orgId);

    const [org, tech] = await Promise.all([
        sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true } }),
        sdb.technician.findFirst({ where: { id: technicianId }, select: { name: true } }),
    ]);
    if (!tech) return { err: "Technician not found" };
    const technicianName = tech.name;
    const tz = org?.timezone ?? "UTC";
    const weekStart = weekStartOf(date ?? localDateString(new Date(), tz));
    const { start, end } = weekRangeIn(weekStart, tz);

    const [shifts, week] = await Promise.all([
        sdb.technician_shift.findMany({
            where: { tech_id: technicianId, started_at: { gte: start, lt: end }},
            orderBy: { started_at: "asc" },
        }),
        sdb.timesheet_week.findFirst({
            where: { technician_id: technicianId, week_start: weekStart },
            select: { approved_at: true },
        }),
    ]);
    const approvedAt = week?.approved_at ?? null;
    if (shifts.length === 0) return { weekStart, technicianName, approvedAt, days: [] };

    const [entries, breaks, driveRows, corrections] = await Promise.all([
        sdb.visit_tech_time_entry.findMany({
            where: { tech_id: technicianId, clocked_in_at: { gte: start, lt: end }},
            include: { visit: { select: { name: true, job: { select: { job_number: true, name: true, client: { select: { name: true } } } } } } },
            orderBy: { clocked_in_at: "asc"}
        }),
        sdb.technician_shift_break.findMany({
            where: { shift_id: { in: shifts.map((s) => s.id) } },
        }),
        sdb.visit_tech_drive.findMany({
            where: { tech_id: technicianId, started_at: { gte: start, lt: end } },
            include: { visit: { select: { job: { select: { job_number: true } } } } },
            orderBy: { started_at: "asc" },
        }),
        sdb.shift_correction.findMany({
            where: { shift_id: { in: shifts.map((s) => s.id) }, status: { not: "superseded" } },
            select: { id: true, shift_id: true, message: true, proposed: true, status: true, review_note: true, reviewed_at: true, created_at: true },
            orderBy: { created_at: "desc" },
        }),
    ]);

    const now = new Date();
    const overlaps = (s: { start: Date; end: Date }, from: Date, to: Date) => s.start < to && s.end > from;

    const jobs: Span[] = entries.map((e) => ({
        start: e.clocked_in_at,
        end: e.clocked_out_at ?? now,
        label: `${e.visit.job.job_number} · ${e.visit.job.client.name}`,
        sub: e.visit.name ?? e.visit.job.name,
    }));
    const drives: Span[] = driveRows.map((d) => ({
        start: d.started_at,
        end: d.ended_at ?? now,
        label: d.visit ? `Drive to ${d.visit.job.job_number}` : "Drive back",
        sub: "",
    }));

    const days = shifts.map((shift) => {
        const span = { start: shift.started_at, end: shift.ended_at ?? now };
        const shiftBreaks = breaks
            .filter((b) => b.shift_id === shift.id)
            .map((b) => ({
                start: b.started_at,
                end: b.ended_at ?? now,
                label: b.reason,
                sub: b.is_paid ? "Paid" : "Unpaid",
                paid: b.is_paid,
            }));
        return {
            shiftId: shift.id,
            start: span.start,
            end: shift.ended_at,
            payableHours: Number(shift.payable_hours ?? 0),
            segments: buildShiftSegments(
                span,
                jobs.filter((j) => overlaps(j, span.start, span.end)),
                drives.filter((d) => overlaps(d, span.start, span.end)),
                shiftBreaks,
            ),
            breaks: breaks.filter((b) => b.shift_id === shift.id),
            entries: entries.filter((e) => overlaps({ start: e.clocked_in_at, end: e.clocked_out_at ?? now }, span.start, span.end)),
            pendingCorrection: corrections.find((c) => c.shift_id === shift.id && c.status === "pending") ?? null,
            lastCorrection: corrections.find((c) => c.shift_id === shift.id && c.status !== "pending") ?? null,
        };
    });

    return { weekStart, technicianName, approvedAt, days };
}

async function checkShiftEdit(
    orgId: string,
    shift: technician_shift,
    parsed: z.infer<typeof editShiftSchema>,
    checkLock: boolean,
) {
    const sdb = getScopedDb(orgId);
    if (!shift.ended_at) return { err: "Shift is still open" };

    const start = parsed.started_at ?? shift.started_at;
    const end = parsed.ended_at ?? shift.ended_at;
    if (end <= start) return { err: "Shift end must be after start" };

    if (checkLock && ((await isWeekLocked(orgId, shift.tech_id, shift.started_at)) || (await isWeekLocked(orgId, shift.tech_id, start)))) {
        return { err: TIMESHEET_LOCKED };
    }

    const breakEdits = parsed.breaks ?? [];
    const existingBreaks = await sdb.technician_shift_break.findMany({ where: { shift_id: shift.id } });
    if (breakEdits.some((b) => !existingBreaks.find((x) => x.id === b.id))) {
        return { err: "Break not found on this shift" };
    }
    const mergedBreaks = existingBreaks.map((x) => {
        const edit = breakEdits.find((b) => b.id === x.id);
        return { ...x, started_at: edit?.started_at ?? x.started_at, ended_at: edit?.ended_at ?? x.ended_at };
    });
    if (mergedBreaks.some((b) => b.started_at < start || !b.ended_at || b.ended_at > end)) {
        return { err: "Breaks must fall within the shift" };
    }

    const entryEdits = parsed.entries ?? [];
    const existingEntries = await sdb.visit_tech_time_entry.findMany({
        where: { id: { in: entryEdits.map((e) => e.id) }, tech_id: shift.tech_id, clocked_out_at: { not: null } },
    });
    if (existingEntries.length !== entryEdits.length) return { err: "Visit time entry not found" };

    return { start, end, breakEdits, existingBreaks, mergedBreaks, entryEdits, existingEntries };
}

export async function editShift(
    orgId: string,
    shiftId: string,
    data: unknown,
    context?: UserContext,
): Promise<{ err: string; shift?: undefined } | { shift: technician_shift; err?: undefined }> {
    try {
        const parsed = editShiftSchema.parse(data);
        const sdb = getScopedDb(orgId);

        const existingShift = await sdb.technician_shift.findFirst({
            where: { id: shiftId, ended_at: { not: null } },
        });
        if (!existingShift) return { err: "Shift not found"};

        if (!context?.dispatcherId && existingShift.tech_id !== context?.techId) return { err: "Shift not found" };

        const checked = await checkShiftEdit(orgId, existingShift, parsed, true);
        if (checked.err !== undefined) return { err: checked.err };
        const { start, end, breakEdits, mergedBreaks, entryEdits } = checked;

        const hrs = (a: Date, b: Date) => parseFloat(((b.getTime() - a.getTime()) / 3_600_000).toFixed(4));
        const changes = diffShiftEdit(existingShift, checked);
        const changedEntries = entryEdits.filter(
            (e) => `entry.${e.id}.clocked_in_at` in changes || `entry.${e.id}.clocked_out_at` in changes,
        );

        const updatedShift = await sdb.$transaction(async (tx) => {
            for (const b of breakEdits) {
                await tx.technician_shift_break.update({
                    where: { id: b.id },
                    data: { started_at: b.started_at, ended_at: b.ended_at, duration_hrs: hrs(b.started_at, b.ended_at) },
                });
            }

            const visitIds = new Set<string>();
            for (const e of changedEntries) {
                const hours = hrs(e.clocked_in_at, e.clocked_out_at);
                const entry = await tx.visit_tech_time_entry.update({
                    where: { id: e.id },
                    data: { clocked_in_at: e.clocked_in_at, clocked_out_at: e.clocked_out_at, hours_worked: hours },
                });
                if (!entry.line_item_id) continue;
                const line = await tx.job_visit_line_item.findUnique({
                    where: { id: entry.line_item_id },
                    select: { unit_price: true },
                });
                if (!line) continue;
                const rate = Number(line.unit_price);
                await tx.job_visit_line_item.update({
                    where: { id: entry.line_item_id },
                    data: {
                        quantity: hours,
                        total: parseFloat((hours * rate).toFixed(2)),
                        description: `${hours.toFixed(2)} hrs @ $${rate.toFixed(2)}/hr`,
                    },
                });
                visitIds.add(entry.visit_id);
            }

            for (const visitId of visitIds) {
                const visit = await tx.job_visit.findUnique({
                    where: { id: visitId },
                    include: { line_items: true },
                });
                if (!visit) continue;
                const subtotal = visit.line_items.reduce((s, li) => s + Number(li.total), 0);
                const tax = parseFloat((subtotal * Number(visit.tax_rate)).toFixed(2));
                await tx.job_visit.update({
                    where: { id: visitId },
                    data: { subtotal, tax_amount: tax, total: parseFloat((subtotal + tax).toFixed(2)) },
                });
            }

            const grossHours = hrs(start, end);
            const breakHours = parseFloat(
                mergedBreaks
                    .filter((b) => !b.is_paid)
                    .reduce((s, b) => s + hrs(b.started_at, b.ended_at!), 0)
                    .toFixed(4),
            );
            return tx.technician_shift.update({
                where: { id: shiftId },
                data: {
                    started_at: start,
                    ended_at: end,
                    gross_hours: grossHours,
                    break_hours: breakHours,
                    payable_hours: parseFloat(Math.max(0, grossHours - breakHours).toFixed(4)),
                },
            });
        });

        if (Object.keys(changes).length > 0) {
            const { day } = await shiftDayAndWeek(orgId, updatedShift.started_at);
            await logActivity({
                event_type: "timesheet.time_edited",
                action: "updated",
                entity_type: "technician_shift",
                entity_id: shiftId,
                organization_id: orgId,
                actor_type: context.dispatcherId ? "dispatcher" : "technician",
                actor_id: context.dispatcherId ?? context.techId,
                changes: { ...changes, ...logCrumbs(day) },
            });
        }

        return { shift: updatedShift };
    } catch (err) {
        return toErr(err);
    }
}

export async function reportShiftIssue (
    orgId: string,
    shiftId: string,
    message: string,
    context?: UserContext,
    proposed?: z.infer<typeof editShiftSchema>,
) {
    try {
        if (!context?.techId) return { err: "Only technicians can report time issues"};
        const techId = context.techId;

        const sdb = getScopedDb(orgId);
        const shift = await sdb.technician_shift.findFirst({
            where: { id: shiftId, tech_id: techId },
            include: { tech: { select: { name: true } } },
        });
        if (!shift) return {err: "Shift not found"};

        let diff = {};
        if (proposed) {
            const checked = await checkShiftEdit(orgId, shift, proposed, false);
            if (checked.err !== undefined) return { err: checked.err };
            diff = diffShiftEdit(shift, checked);

            await sdb.$transaction(async (tx) => {
                await tx.shift_correction.updateMany({
                    where: { shift_id: shiftId, status: "pending" },
                    data: { status: "superseded" },
                });
                await tx.shift_correction.create({
                    data: {
                        organization_id: orgId,
                        shift_id: shiftId,
                        tech_id: techId,
                        message,
                        proposed: JSON.parse(JSON.stringify(proposed)),
                    },
                });
            });
        }

        const { day, week } = await shiftDayAndWeek(orgId, shift.started_at);

        await logActivity({
            event_type: "timesheet.issue_reported",
            action: "reported",
            entity_type: "technician_shift",
            entity_id: shiftId,
            organization_id: orgId,
            actor_type: "technician",
            actor_id: techId,
            reason: message,
            changes: { ...diff, ...logCrumbs(day, message) },
        });

        await notifyDispatchers(
            {
                type: "timesheet_issue_reported",
                title: `${shift.tech.name} ${proposed ? "suggested a time correction" : "reported a time issue"} · ${day}`,
                body: message,
                actionUrl: `/dispatch/timesheet?week=${week}&tech=${techId}`,
            },
            orgId,
        );

        return { ok: true };
    } catch (err) {
        return toErr(err);
    }
}

export async function acceptCorrection(orgId: string, correctionId: string, data: unknown, context?: UserContext) {
    try {
        if (!context?.dispatcherId) return { err: "Only dispatchers can review corrections" };
        const dispatcherId = context.dispatcherId;
        const parsed = reviewCorrectionSchema.parse(data);
        const sdb = getScopedDb(orgId);

        const correction = await sdb.shift_correction.findFirst({
            where: { id: correctionId }
        });
        if (!correction) return { err: "Shift correction not found" };

        const claimed = await sdb.shift_correction.updateMany({
            where: { id: correction.id, status: "pending" },
            data: {
                status: "accepted",
                reviewed_by_id: dispatcherId,
                reviewed_at: new Date(),
                review_note: parsed.note ?? null,
            }
        });
        if (claimed.count === 0) return { err: "Correction already reviewed" };

        const result = await editShift(orgId, correction.shift_id, parsed.proposed ?? correction.proposed, context);
        if (result.err !== undefined) {
            await sdb.shift_correction.update({
                where: { id: correction.id },
                data: { status: "pending", reviewed_by_id: null, reviewed_at: null, review_note: null }
            });
            return { err: result.err };
        }

        const { day, week } = await shiftDayAndWeek(orgId, result.shift.started_at);
        await logActivity({
            event_type: "timesheet.correction_accepted",
            action: "accepted",
            entity_type: "shift_correction",
            entity_id: correction.id,
            organization_id: orgId,
            actor_type: "dispatcher",
            actor_id: dispatcherId,
            reason: parsed.note,
            changes: logCrumbs(day, parsed.note),
        });

        await createNotification({
            technicianId: correction.tech_id,
            type: "time_correction_accepted",
            title: `Time correction accepted · ${day}`,
            body: parsed.note ?? "Your suggested times were applied.",
            actionUrl: `/technician/timesheet?week=${week}`,
        }, orgId);

        return { ok: true };
    } catch (err) {
        return toErr(err);
    }
}

export async function rejectCorrection(orgId: string, correctionId: string, data: unknown, context?: UserContext) {
    try {
        if (!context?.dispatcherId) return { err: "Only dispatchers can review corrections" };
        const dispatcherId = context.dispatcherId;
        const parsed = reviewCorrectionSchema.parse(data);
        const sdb = getScopedDb(orgId);

        const correction = await sdb.shift_correction.findFirst({
            where: { id: correctionId },
            include: { shift: { select: { started_at: true } }},
        });
        if (!correction) return { err: "Shift correction not found" };
        if (correction.status !== "pending") return { err: "Correction already reviewed" };

        const updates = await sdb.shift_correction.updateMany({
            where: { id: correction.id, status: "pending" },
            data: {
                status: "rejected",
                reviewed_by_id: dispatcherId,
                reviewed_at: new Date(),
                review_note: parsed.note ?? null,
            }
        });
        if (updates.count === 0) return { err: "Correction already reviewed" };

        const { day, week } = await shiftDayAndWeek(orgId, correction.shift.started_at);
        await logActivity({
            event_type: "timesheet.correction_rejected",
            action: "rejected",
            entity_type: "shift_correction",
            entity_id: correction.id,
            organization_id: orgId,
            actor_type: "dispatcher",
            actor_id: dispatcherId,
            reason: parsed.note,
            changes: logCrumbs(day, parsed.note),
        });

        await createNotification({
            technicianId: correction.tech_id,
            type: "time_correction_rejected",
            title: `Time correction rejected · ${day}`,
            body: parsed.note ?? "Dispatch kept the original times.",
            actionUrl: `/technician/timesheet?week=${week}`,
        }, orgId);

        return { ok: true };
    } catch (err) {
        return toErr(err);
    }
}

