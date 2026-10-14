import { CircleCheck, CircleDashed, MapPinCheck, Timer, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Arrival, ArrivalStatus } from "../../types/arrivals";
import { formatTime } from "../../util/util";

// Status always travels as icon + word, never color alone: techs and dispatchers
// include color-blind users, and the board gets read across a room.
export const ARRIVAL_STATUS_META: Record<
	ArrivalStatus,
	{ label: string; icon: LucideIcon; badge: string; text: string; fill: string }
> = {
	late: {
		label: "Late",
		icon: TriangleAlert,
		badge: "bg-error-bg text-error-text border-error-border",
		text: "text-error-text",
		fill: "bg-error",
	},
	at_risk: {
		label: "At risk",
		icon: Timer,
		badge: "bg-warning-bg text-warning-text border-warning-border",
		text: "text-warning-text",
		fill: "bg-warning",
	},
	on_time: {
		label: "On time",
		icon: CircleCheck,
		badge: "bg-success-bg text-success-text border-success-border",
		text: "text-success-text",
		fill: "bg-success",
	},
	arrived: {
		label: "Arrived",
		icon: MapPinCheck,
		badge: "bg-surface-raised text-text-secondary border-border-subtle",
		text: "text-text-secondary",
		fill: "bg-text-muted",
	},
	unknown: {
		label: "No forecast",
		icon: CircleDashed,
		badge: "bg-surface-raised text-text-tertiary border-border-subtle",
		text: "text-text-tertiary",
		fill: "bg-text-faint",
	},
};

export function formatMinutes(mins: number): string {
	const m = Math.abs(Math.round(mins));
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	const rem = m % 60;
	return rem ? `${h} h ${rem} min` : `${h} h`;
}

/** "12 min late", "8 min early", "On the dot" — from the arrival's delay. */
export function formatDelay(a: Pick<Arrival, "delay_minutes" | "status">): string | null {
	if (a.delay_minutes === null) return null;
	if (a.delay_minutes === 0) return "On the dot";
	if (a.delay_minutes > 0) return `${formatMinutes(a.delay_minutes)} late`;
	return a.status === "arrived" ? `${formatMinutes(a.delay_minutes)} early` : `${formatMinutes(a.delay_minutes)} to spare`;
}

/** The one line that says what the tech is doing about this stop right now. */
export function describeSituation(a: Arrival, tz: string, now: number): string {
	if (a.status === "arrived") return a.arrived_at ? `Arrived ${formatTime(a.arrived_at, tz)}` : "Arrived";
	if (a.basis === "no_location") return "No recent GPS fix — forecast paused";
	if (a.basis === "elapsed") return a.en_route ? "Past due · en route, no live position" : "Past due · hasn't left";

	const parts: string[] = [];
	if (a.en_route) {
		parts.push("En route");
	} else if (a.stop_index > 0) {
		parts.push("After current work");
	} else if (a.leave_by_at) {
		const leaveBy = new Date(a.leave_by_at).getTime();
		parts.push(
			leaveBy < now
				? `Should have left by ${formatTime(a.leave_by_at, tz)}`
				: `Not left · leave by ${formatTime(a.leave_by_at, tz)}`,
		);
	}
	// A same-site hop (0 mi) isn't worth a line
	if (a.distance_miles) parts.push(`${a.distance_miles} mi`);
	if (a.drive_minutes) parts.push(`${formatMinutes(a.drive_minutes)} drive`);
	if (a.traffic_delay_minutes !== null && a.traffic_delay_minutes >= 3) {
		parts.push(`traffic +${formatMinutes(a.traffic_delay_minutes)}`);
	}
	return parts.join(" · ");
}

export function arrivalVisitPath(a: Pick<Arrival, "job_id" | "visit_id">): string {
	return `/dispatch/jobs/${a.job_id}/visits/${a.visit_id}`;
}
