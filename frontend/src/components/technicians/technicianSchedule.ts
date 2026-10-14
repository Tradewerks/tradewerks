import type { JobVisit, VisitStatus } from "../../types/jobs";
import type { VehicleStockItem } from "../../types/vehicles";
import { ACTIVE_VISIT_STATUSES } from "./technicianActivity";

export type ScheduleSegment = "upcoming" | "today" | "past";

const DONE: readonly string[] = ["Completed", "Cancelled"];

function localDayBounds(now: Date): [number, number] {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
	return [start.getTime(), end.getTime()];
}

export function partitionVisits(
	visits: JobVisit[],
	now: Date
): Record<ScheduleSegment, JobVisit[]> {
	const [dayStart, dayEnd] = localDayBounds(now);
	const out: Record<ScheduleSegment, JobVisit[]> = { upcoming: [], today: [], past: [] };

	for (const visit of visits) {
		// Cancelled never counts toward Today or Upcoming, regardless of its date
		// (review finding: a same-day cancellation must not inflate Today's total).
		if (visit.status === "Cancelled") {
			out.past.push(visit);
			continue;
		}
		const t = new Date(visit.scheduled_start_at).getTime();
		// An active visit that started yesterday is still today's work.
		const active = ACTIVE_VISIT_STATUSES.includes(visit.status as VisitStatus);
		if (active || (t >= dayStart && t < dayEnd)) out.today.push(visit);
		else if (t >= dayEnd && !DONE.includes(visit.status)) out.upcoming.push(visit);
		else out.past.push(visit);
	}

	const at = (x: JobVisit) => new Date(x.scheduled_start_at).getTime();
	out.today.sort((a, b) => at(a) - at(b));
	out.upcoming.sort((a, b) => at(a) - at(b));
	out.past.sort((a, b) => at(b) - at(a));
	return out;
}

// The timesheets report API (backend/src/controllers/reportsController.ts,
// parseReportDate) uses a bare YYYY-MM-DD as a UTC day and otherwise takes the
// instant exactly as sent, per its own comment: "the frontend sends full ISO
// instants for the user's local range". So these bounds are local midnights
// serialized with toISOString(), not date-only strings.
export function weekRange(now: Date): { start: string; end: string } {
	// getDay(): Sunday is 0, so Sunday belongs to the week that began six days earlier.
	const offset = (now.getDay() + 6) % 7;
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
	const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
	return { start: start.toISOString(), end: end.toISOString() };
}

export const LOW_STOCK_SHOWN = 8;

export function lowStockRows(
	stock: VehicleStockItem[],
	limit = LOW_STOCK_SHOWN
): VehicleStockItem[] {
	return stock
		.filter((s) => s.qty_on_hand < s.qty_min)
		.sort((a, b) => a.qty_on_hand - a.qty_min - (b.qty_on_hand - b.qty_min))
		.slice(0, limit);
}

// The delete guard: anything not yet finished still needs this technician.
export function countActiveVisits(visitTechs: { visit: { status: string } }[]): number {
	return visitTechs.filter(
		(vt) =>
			vt.visit.status === "Scheduled" ||
			ACTIVE_VISIT_STATUSES.includes(vt.visit.status as VisitStatus)
	).length;
}
