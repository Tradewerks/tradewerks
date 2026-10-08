import type { JobVisit, VisitStatus } from "../types/jobs";
import { localDateKey } from "../components/ui/schedule/scheduleBoardUtils";

const ACTIVE: ReadonlySet<VisitStatus> = new Set(["Driving", "OnSite", "InProgress", "Paused"]);
const CLOSED: ReadonlySet<VisitStatus> = new Set(["Completed", "Cancelled"]);
const UPCOMING: ReadonlySet<VisitStatus> = new Set(["Scheduled", "Delayed"]);

export function isActiveVisit(v: Pick<JobVisit, "status">): boolean {
	return ACTIVE.has(v.status);
}

export function isClosedVisit(v: Pick<JobVisit, "status">): boolean {
	return CLOSED.has(v.status);
}

export function defaultSelectedVisitIds(visits: JobVisit[], now: Date): string[] {
	const today = localDateKey(now);
	const current = visits.filter(
		(v) =>
			isActiveVisit(v) ||
			(!CLOSED.has(v.status) && localDateKey(v.scheduled_start_at) === today),
	);
	if (current.length > 0) return current.map((v) => v.id);

	const next = visits
		.filter(
			(v) =>
				UPCOMING.has(v.status) &&
				new Date(v.scheduled_start_at).getTime() > now.getTime(),
		)
		.sort(
			(a, b) =>
				new Date(a.scheduled_start_at).getTime() -
				new Date(b.scheduled_start_at).getTime(),
		)[0];
	return next ? [next.id] : [];
}
