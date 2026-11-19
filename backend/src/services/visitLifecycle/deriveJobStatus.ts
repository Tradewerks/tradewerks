import type {
	job_status,
	visit_status,
} from "../../../generated/prisma/client.js";
import { ACTIVE_VISIT_STATUSES, OPEN_VISIT_STATUSES } from "./transitions.js";

export function deriveJobStatus(
	visits: readonly { status: visit_status }[],
	job: { cancelled_at: Date | null },
): job_status {
	if (visits.length === 0)
		return job.cancelled_at ? "Cancelled" : "Unscheduled";
	if (visits.some((v) => ACTIVE_VISIT_STATUSES.includes(v.status)))
		return "InProgress";
	const anyCompleted = visits.some((v) => v.status === "Completed");
	if (visits.some((v) => OPEN_VISIT_STATUSES.includes(v.status))) {
		return anyCompleted ? "InProgress" : "Scheduled";
	}
	if (job.cancelled_at) return "Cancelled";
	// All visits cancelled with no job-level cancel still reads as Cancelled: nothing left to do.
	return anyCompleted ? "Completed" : "Cancelled";
}
