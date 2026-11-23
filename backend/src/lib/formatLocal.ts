import { localTimeOnDay } from "./dayRange.js";
import type { VisitConstraint } from "./arrivalForecast.js";

// Newer ICU puts a narrow no-break space before AM/PM; plain-text mail wants a
// normal space.
const clean = (s: string) => s.replace(/[\u202f\u00a0]/g, " ");

export function formatLocalDate(at: Date, tz: string): string {
	return clean(
		new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			weekday: "long",
			month: "long",
			day: "numeric",
		}).format(at),
	);
}

export function formatLocalTime(at: Date, tz: string): string {
	return clean(
		new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hour: "numeric",
			minute: "2-digit",
		}).format(at),
	);
}

export function formatArrivalWindow(
	v: VisitConstraint & { arrival_window_start: string | null },
	tz: string,
): string {
	const on = (hhmm: string | null) =>
		formatLocalTime(
			hhmm
				? localTimeOnDay(v.scheduled_start_at, hhmm, tz)
				: v.scheduled_start_at,
			tz,
		);
	switch (v.arrival_constraint) {
		case "at":
			return `at ${on(v.arrival_time)}`;
		case "between":
			return `between ${on(v.arrival_window_start)} and ${on(v.arrival_window_end)}`;
		case "by":
			return `by ${on(v.arrival_window_end)}`;
		default:
			return "during the day";
	}
}
