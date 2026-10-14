import type { JobVisit } from "../types/jobs";

/**
 * Wall-clock start for a technician's live work timer.
 *
 * The tech's own open time entry wins over the visit's arrival timestamp: after a
 * pause/resume the arrival timestamp no longer reflects the current work session,
 * and seeded/dispatcher-edited arrival timestamps can even sit in the future.
 */
export function resolveWorkTimerStart(
	visit: Pick<JobVisit, "actual_start_at" | "time_entries">,
	techId: string | null | undefined,
): string | null {
	const openEntry = techId
		? visit.time_entries?.find((e) => e.tech_id === techId && e.clocked_out_at === null)
		: undefined;
	const start = openEntry?.clocked_in_at ?? visit.actual_start_at ?? null;
	if (!start) return null;
	return start instanceof Date ? start.toISOString() : String(start);
}

/** h:mm:ss (or m:ss under an hour). Negative input clamps to zero. */
export function formatElapsed(seconds: number): string {
	const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${m}:${String(s).padStart(2, "0")}`;
}
