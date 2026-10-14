import { getOrgRealmId, qbFetch } from "../quickbooksService.js";
import { httpError, ErrorCodes } from "../../types/responses.js";
import { getScopedDb } from "../../lib/context.js";
import type { QBRef, QBMetaData } from "./qbPurchases.js";
import { localDateString, weekRangeIn, weekStartOf } from "../../lib/dayRange.js";
import { db } from "../../db.js";
import { pushClient } from "./qbCustomers.js";
import { qbQueryAll } from "./qbQuery.js";

export interface QBTimeActivity {
    Id: string;
    SyncToken: string;
    domain?: string;
    sparse?: boolean;
    TxnDate: string;
    NameOf: "Employee" | "Vendor";
    EmployeeRef?: QBRef;
    VendorRef?: QBRef;
    CustomerRef?: QBRef;
    ItemRef?: QBRef;
    ClassRef?: QBRef;
    PayrollItemRef?: QBRef;
    BillableStatus?: "Billable" | "NotBillable" | "HasBeenBilled";
    Taxable?: boolean;
    HourlyRate?: number;
    Hours?: number;
    Minutes?: number;
    BreakHours?: number;
    BreakMinutes?: number;
    StartTime?: string;
    EndTime?: string;
    Description?: string;
    MetaData?: QBMetaData;
}

export type QBTimeActivityInput = Omit<QBTimeActivity, "Id" | "SyncToken" | "domain" | "sparse" | "MetaData">;

export interface QBTimeActivityResponse {
    TimeActivity: QBTimeActivity;
    time: string;
}

const inFlightPushes = new Map<string, Promise<void>>();

export async function pushTimesheet (orgId: string, timesheetId: string) {
    const prior = inFlightPushes.get(timesheetId) ?? Promise.resolve();
	const run = prior.then(() => doPushTimesheet(orgId, timesheetId));
	// The caller handles run's rejection; a promise derived from it and parked
	// in the map would reject with nobody listening, and with no
	// unhandledRejection handler that takes the process down on any failed
	// push. So the map holds a tail that cannot reject, cleared by identity.
	const tail: Promise<void> = run
		.catch(() => {})
		.finally(() => {
			if (inFlightPushes.get(timesheetId) === tail) {
				inFlightPushes.delete(timesheetId);
			}
		});
	inFlightPushes.set(timesheetId, tail);
	return run;
}

async function doPushTimesheet (orgId: string, timesheetId: string) {
    const sdb = getScopedDb(orgId);
    const accountId = await getOrgRealmId(orgId);
    const timesheet = await sdb.timesheet_week.findFirst({
        where: { id: timesheetId }
    });

    if (!timesheet) throw httpError(404, ErrorCodes.NOT_FOUND, "Timesheet not found");
    if (timesheet.approved_at === null)
        throw httpError(422, ErrorCodes.VALIDATION_ERROR, "Only approved timesheets can be pushed to QuickBooks");

    try {
        const techMapping = await db.technician_external_mapping.findFirst({
            where: { provider: "quickbooks", technician_id: timesheet.technician_id, account_id: accountId },
            select: { external_id: true },
        });
        if (!techMapping) throw httpError(422, ErrorCodes.VALIDATION_ERROR, "Technician isn't linked to a QuickBooks employee");
        const EmployeeRef = { value: techMapping.external_id };

        const org = await sdb.organization.findFirst({ where: { id: orgId }, select: { timezone: true }});
        const tz = org?.timezone ?? "UTC";
        const { start, end } = weekRangeIn(timesheet.week_start, tz);
        const techVisitTimeEntrys = await sdb.visit_tech_time_entry.findMany({
            where: { tech_id: timesheet.technician_id, clocked_in_at: { gte: start, lt: end }},
            include: { visit: { select: { name: true, job: { select: { client_id: true, job_number: true, name: true } } } } },
        });
        if (techVisitTimeEntrys.some((s) => !s.clocked_out_at))
            throw httpError(409, ErrorCodes.CONFLICT, "A technician visit this week is still open");
        const techShifts = await sdb.technician_shift.findMany({
            where: { tech_id: timesheet.technician_id, started_at: { gte: start, lt: end }}
        });
        if (techShifts.some((s) => !s.ended_at))
            throw httpError(409, ErrorCodes.CONFLICT, "A shift this week is still open");

        const customerIds = new Map<string, string>();
        for (const entry of techVisitTimeEntrys) {
            const clientId = entry.visit.job.client_id;
            if (!customerIds.has(clientId)) customerIds.set(clientId, await pushClient(orgId, clientId));
        }

        for (const visit of techVisitTimeEntrys) {
            // skip if already pushed or hours worked < 1 minute 
            if (visit.qb_time_activity_id || Number(visit.hours_worked ?? 0) <= 1/60) continue;
            const result = (await qbFetch(orgId, "POST", "/timeactivity", {
                TxnDate: localDateString(visit.clocked_in_at, tz),
                NameOf: "Employee",
                EmployeeRef,
                CustomerRef: { value: customerIds.get(visit.visit.job.client_id)! },
                Description: `${visit.visit.job.job_number} – ${visit.visit.name ?? visit.visit.job.name}`,
                ...toHM(Number(visit.hours_worked ?? 0)),
            })) as QBTimeActivityResponse;

            await sdb.visit_tech_time_entry.update({
                where: { id: visit.id },
                data: { qb_time_activity_id: result.TimeActivity.Id, account_id: accountId },
            });
        }

        for (const shift of techShifts) {
            if (shift.qb_time_activity_id) continue;
            const visitHours = techVisitTimeEntrys
                .filter((e) => e.clocked_in_at >= shift.started_at && e.clocked_in_at < shift.ended_at!)
                .reduce((sum, e) => sum + Number(e.hours_worked ?? 0), 0);
            const remainder = Number(shift.payable_hours ?? 0) - visitHours;
            if (remainder <= 0) continue;

            const result = (await qbFetch(orgId, "POST", "/timeactivity", {
                TxnDate: localDateString(shift.started_at, tz),
                NameOf: "Employee",
                EmployeeRef,
                Description: "Shop / drive time",
                ...toHM(remainder),
            })) as QBTimeActivityResponse;

            await sdb.technician_shift.update({
                where: { id: shift.id },
                data: { qb_time_activity_id: result.TimeActivity.Id, account_id: accountId },
            });
        }

        await sdb.timesheet_week.update({
            where: { id: timesheetId },
            data: { qb_sync_status: "synced", qb_synced_at: new Date(), qb_error: null },
        });
    } catch (err) {
        await sdb.timesheet_week.update({
            where: { id: timesheetId },
            data: { qb_sync_status: "failed", qb_error: err instanceof Error ? err.message : String(err) },
        });
        throw err;
    }
}

export async function deleteTimeActivity (orgId: string, technicianId: string, date: string) {
    const sdb = getScopedDb(orgId);
    const accountId = await getOrgRealmId(orgId);
    const org = await sdb.organization.findFirst({
        where: { id: orgId },
        select: { timezone: true}
    });
    const tz = org?.timezone ?? "UTC";
    const weekStart = weekStartOf(date);
    const { start, end } = weekRangeIn(weekStart, tz);
    const shifts = await sdb.technician_shift.findMany({
        where: { 
            tech_id: technicianId, 
            started_at: { gte: start, lt: end }, 
            account_id: accountId, 
            NOT: { qb_time_activity_id: null } 
        },
    });
    const entries = await sdb.visit_tech_time_entry.findMany({
        where: {
            tech_id: technicianId,
            clocked_in_at: { gte: start, lt: end },
            account_id: accountId,
            qb_time_activity_id: { not: null },
        },
    });

    const deleteFetch = async (timeActivityId: string) => {
        try {
            const exist = (await qbFetch(orgId, "GET", `/timeactivity/${timeActivityId}`)) as QBTimeActivityResponse;
            await qbFetch(orgId, "POST", "/timeactivity?operation=delete", {
                SyncToken: exist.TimeActivity.SyncToken,
                Id: timeActivityId
            });
        } catch (err) {
            if (!isQBNotFound(err)) throw err;
        }
    }

    for (const shift of shifts){
        if (!shift.qb_time_activity_id) continue;
        await deleteFetch(shift.qb_time_activity_id);
        await sdb.technician_shift.update({
            where: { id: shift.id },
            data: { qb_time_activity_id: null, account_id: "" },
        });
    }
    for (const entry of entries){
        if (!entry.qb_time_activity_id) continue;
        await deleteFetch(entry.qb_time_activity_id);
        await sdb.visit_tech_time_entry.update({
            where: { id: entry.id },
            data: { qb_time_activity_id: null, account_id: "" },
        });
    }
}

export const isQBNotFound = (err: unknown) =>
    err instanceof Error && /"code"\s*:\s*"610"/.test(err.message);

function toHM(hours: number) {
    const m = Math.round(hours * 60);
    return { Hours: Math.floor(m / 60), Minutes: m % 60 };
}
