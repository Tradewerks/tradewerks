import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { localDateString, weekRangeIn, weekStartOf } from "../lib/dayRange.js";
import { approveTimesheetSchema } from "../lib/validate/timesheets.js";
import { logActivity } from "../services/logger.js";
import { deleteTimeActivity } from "../services/qb/qbTimeActivity.js";

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
            action: "created",
            entity_type: "timesheet",
            entity_id: timesheet.id,
            organization_id: orgId,
            actor_type: "dispatcher",
            actor_id: context.dispatcherId,
            changes: {timesheet: {old: null, new: timesheet.id}, approval: {old: null, new: timesheet.approved_at? "approved" : null}},
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
            action: "deleted",
            entity_type: "timesheet",
            entity_id: timesheet.id,
            organization_id: orgId,
            actor_type: "dispatcher",
            actor_id: context.dispatcherId,
            changes: {timesheet: {old: timesheet.id, new: null}, approval: {old: "approved", new: null}},
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

    const shifts = await sdb.technician_shift.findMany({
        where: { tech_id: technicianId, started_at: { gte: start, lt: end }},
        orderBy: { started_at: "asc" },
    });
    if (shifts.length === 0) return { weekStart, technicianName, days: [] };

    const [entries, breaks, driveRows] = await Promise.all([
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
        };
    });

    return { weekStart, technicianName, days };
}
