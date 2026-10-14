import type { Technician, VisitTechnician } from "../../types/technicians";
import type { VisitStatus } from "../../types/jobs";

export const ACTIVE_VISIT_STATUSES: readonly VisitStatus[] = [
	"Driving",
	"OnSite",
	"InProgress",
	"Paused",
	"Delayed",
];

export interface TechnicianActivity {
	current: VisitTechnician | null;
	next: VisitTechnician | null;
	todayCount: number;
	todayDone: number;
}

function toTime(value: Date | string | null | undefined): number {
	if (!value) return NaN;
	return new Date(value).getTime();
}

// Local calendar day, not UTC — an evening visit must not roll into "tomorrow".
function isSameLocalDay(time: number, now: Date): boolean {
	if (isNaN(time)) return false;
	const d = new Date(time);
	return (
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate()
	);
}

export function getTechnicianActivity(
	tech: Pick<Technician, "visit_techs">,
	now: Date = new Date()
): TechnicianActivity {
	const nowMs = now.getTime();

	let current: VisitTechnician | null = null;
	let currentStart = -Infinity;
	let next: VisitTechnician | null = null;
	let nextStart = Infinity;
	let todayCount = 0;
	let todayDone = 0;

	for (const vt of tech.visit_techs ?? []) {
		const { status } = vt.visit;
		const scheduledStart = toTime(vt.visit.scheduled_start_at);

		if (ACTIVE_VISIT_STATUSES.includes(status)) {
			const started = toTime(vt.visit.actual_start_at);
			const rank = isNaN(started) ? scheduledStart : started;
			const safeRank = isNaN(rank) ? -Infinity : rank;
			if (!current || safeRank > currentStart) {
				current = vt;
				currentStart = safeRank;
			}
		}

		if (!isSameLocalDay(scheduledStart, now)) continue;
		if (status !== "Cancelled") todayCount++;
		if (status === "Completed") todayDone++;
		if (status === "Scheduled" && scheduledStart >= nowMs && scheduledStart < nextStart) {
			next = vt;
			nextStart = scheduledStart;
		}
	}

	return { current, next, todayCount, todayDone };
}
