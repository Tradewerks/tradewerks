import { localTimeOnDay } from "./dayRange.js";

// Arrival forecasting is pure: given where a tech is, what's queued for them and the
// leg times Mapbox returned, say when they'll get to each stop and whether that's on
// time. arrivalTracker does the I/O around it.

export type ArrivalStatus = "on_time" | "at_risk" | "late" | "arrived" | "unknown";
export type ArrivalBasis = "traffic" | "elapsed" | "no_location" | "actual";

// Within this past the due time still counts as on time
export const GRACE_MS = 5 * 60_000;
// Less spare time than this is at risk
export const AT_RISK_MS = 10 * 60_000;
// Further late alerts only when the delay has grown by this much since the last one
export const ESCALATE_MS = 15 * 60_000;
// Stops behind the next one rest on planned durations, so only alert when clearly late
export const DOWNSTREAM_ALERT_MS = 15 * 60_000;
// A GPS fix older than this can't anchor a route
export const STALE_PING_MS = 20 * 60_000;

export interface VisitConstraint {
	arrival_constraint: "anytime" | "at" | "between" | "by";
	arrival_time: string | null;
	arrival_window_end: string | null;
	scheduled_start_at: Date;
}

/** The moment arrival is judged against: the promised time, or the scheduled start. */
export function arrivalDueAt(v: VisitConstraint, timezone: string): Date {
	const hhmm =
		v.arrival_constraint === "at"
			? v.arrival_time
			: v.arrival_constraint === "between" || v.arrival_constraint === "by"
				? v.arrival_window_end
				: null;
	return hhmm ? localTimeOnDay(v.scheduled_start_at, hhmm, timezone) : v.scheduled_start_at;
}

export function classifyDelay(delayMs: number): "on_time" | "at_risk" | "late" {
	if (delayMs > GRACE_MS) return "late";
	if (delayMs > -AT_RISK_MS) return "at_risk";
	return "on_time";
}

export interface ForecastStop {
	visitId: string;
	dueAt: Date;
	enRoute: boolean;
	scheduledStartAt: Date;
	plannedMs: number; // scheduled_end_at - scheduled_start_at
	hasCoords: boolean;
}

export interface ForecastLeg {
	durationSeconds: number;
	typicalSeconds: number | null;
	distanceMeters: number;
}

export interface Forecast {
	visitId: string;
	stopIndex: number;
	status: Exclude<ArrivalStatus, "arrived">;
	basis: Exclude<ArrivalBasis, "actual">;
	dueAt: Date;
	etaAt: Date | null;
	leaveByAt: Date | null;
	delaySeconds: number | null;
	driveSeconds: number | null;
	trafficDelaySeconds: number | null;
	distanceMeters: number | null;
}

export interface ForecastInput {
	now: Date;
	// When the tech is free to drive to the first stop: now, or the scheduled end of
	// the visit they're working
	availableAt: Date;
	// legs[i] arrives at stops[i]; null where there's no route (no origin, no coords)
	legs: Array<ForecastLeg | null>;
	stops: ForecastStop[];
	// When an en-route first stop's leg was measured from the moving tech
	enRouteMeasuredAt: Date | null;
}

/**
 * Walk the tech's queue in order. Each stop's ETA is when they can leave plus the
 * leg; they then start no earlier than the scheduled start and stay the planned
 * duration before leaving for the next. A missing leg breaks the chain: everything
 * after it is unknown unless its due time has already passed.
 */
export function forecastRoute(input: ForecastInput): Forecast[] {
	const { now, stops, legs } = input;
	const out: Forecast[] = [];
	let freeAt: number | null = Math.max(now.getTime(), input.availableAt.getTime());

	stops.forEach((stop, i) => {
		const leg = legs[i] ?? null;
		const due = stop.dueAt.getTime();
		const base = {
			visitId: stop.visitId,
			stopIndex: i,
			dueAt: stop.dueAt,
			driveSeconds: null,
			trafficDelaySeconds: null,
			distanceMeters: null,
			leaveByAt: null,
		};

		if (!leg || freeAt === null) {
			freeAt = null;
			if (now.getTime() > due) {
				out.push({
					...base,
					status: classifyDelay(now.getTime() - due),
					basis: "elapsed",
					etaAt: null,
					delaySeconds: Math.round((now.getTime() - due) / 1000),
				});
			} else {
				out.push({ ...base, status: "unknown", basis: "no_location", etaAt: null, delaySeconds: null });
			}
			return;
		}

		const driveMs = leg.durationSeconds * 1000;
		// An en-route tech's leg was measured from where they were; they're already driving
		const departAt =
			i === 0 && stop.enRoute && input.enRouteMeasuredAt
				? input.enRouteMeasuredAt.getTime()
				: freeAt;
		const eta = Math.max(departAt + driveMs, now.getTime());
		const delayMs = eta - due;

		out.push({
			...base,
			status: classifyDelay(delayMs),
			basis: "traffic",
			etaAt: new Date(eta),
			leaveByAt: stop.enRoute && i === 0 ? null : new Date(due - driveMs),
			delaySeconds: Math.round(delayMs / 1000),
			driveSeconds: Math.round(leg.durationSeconds),
			trafficDelaySeconds:
				leg.typicalSeconds === null
					? null
					: Math.max(0, Math.round(leg.durationSeconds - leg.typicalSeconds)),
			distanceMeters: Math.round(leg.distanceMeters),
		});

		freeAt = Math.max(eta, stop.scheduledStartAt.getTime()) + stop.plannedMs;
	});

	return out;
}

export type AlertAction = "late" | "worse" | "recovered" | null;

/**
 * Escalation: first alert when a stop goes late, another each time it slips a further
 * ESCALATE_MS, and an all-clear when it's projected on time again (delay ≤ 0, so a
 * forecast hovering at the grace edge doesn't flap).
 */
export function decideAlert(
	f: Pick<Forecast, "status" | "delaySeconds" | "stopIndex">,
	alertedLateMinutes: number | null,
): AlertAction {
	const delayMs = (f.delaySeconds ?? 0) * 1000;
	if (f.status === "late") {
		if (f.stopIndex > 0 && delayMs < DOWNSTREAM_ALERT_MS) return null;
		if (alertedLateMinutes === null) return "late";
		return delayMs >= alertedLateMinutes * 60_000 + ESCALATE_MS ? "worse" : null;
	}
	if (alertedLateMinutes !== null && f.delaySeconds !== null && delayMs <= 0) return "recovered";
	return null;
}
