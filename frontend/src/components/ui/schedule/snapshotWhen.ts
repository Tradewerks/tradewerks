import type { ArrivalConstraint, FinishConstraint } from "../../../types/recurringPlans";

/** Shared timing shape of a visit (scheduled_*) and an occurrence (occurrence_*). */
export interface SnapshotTiming {
	start: string | Date;
	end: string | Date;
	arrival_constraint: ArrivalConstraint | string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_constraint: FinishConstraint | string;
	finish_time?: string | null;
}

interface Clock {
	h: number;
	m: number;
}

function parseHHMM(hhmm: string | null | undefined): Clock | null {
	if (!hhmm) return null;
	const [h, m] = hhmm.split(":").map(Number);
	return Number.isNaN(h) || Number.isNaN(m) ? null : { h, m };
}

function fromInstant(at: string | Date): Clock {
	const d = typeof at === "string" ? new Date(at) : at;
	return { h: d.getHours(), m: d.getMinutes() };
}

const period = (c: Clock) => (c.h >= 12 ? "PM" : "AM");
const bare = (c: Clock) => `${c.h % 12 || 12}:${String(c.m).padStart(2, "0")}`;
const clock = (c: Clock) => `${bare(c)} ${period(c)}`;

/** Finish clock for `at`/`by` finishes; null when the visit runs until done. */
function finishClock(t: SnapshotTiming): Clock | null {
	return t.finish_constraint === "at" || t.finish_constraint === "by"
		? (parseHHMM(t.finish_time) ?? fromInstant(t.end))
		: null;
}

function range(a: Clock, b: Clock): string {
	return period(a) === period(b) ? `${bare(a)} – ${clock(b)}` : `${clock(a)} – ${clock(b)}`;
}

/**
 * Constraint-aware "when" for the schedule popups. Constraint HH:MM fields win over the stored
 * instants because anytime/by rows carry synthetic instants (anytime is stored at 09:00).
 */
export function snapshotWhen(t: SnapshotTiming): { date: string; time: string } {
	const startDate = typeof t.start === "string" ? new Date(t.start) : t.start;
	const date = startDate.toLocaleDateString("en-US", {
		weekday: "short",
		month: "short",
		day: "numeric",
	});

	const finish = finishClock(t);
	const tail =
		t.finish_constraint === "when_done"
			? " · until done"
			: finish
				? ` · ${t.finish_constraint === "by" ? "done by" : "ends"} ${clock(finish)}`
				: "";

	if (t.arrival_constraint === "at") {
		const s = parseHHMM(t.arrival_time) ?? fromInstant(t.start);
		const time =
			finish && t.finish_constraint === "at" ? range(s, finish) : `${clock(s)}${tail}`;
		return { date, time };
	}

	let head: string;
	if (t.arrival_constraint === "between") {
		const a = parseHHMM(t.arrival_window_start) ?? fromInstant(t.start);
		const b = parseHHMM(t.arrival_window_end) ?? fromInstant(t.end);
		head = `Arrive ${range(a, b)}`;
	} else if (t.arrival_constraint === "by") {
		// A "by" row's stored start is derived (deadline − 4h), so it can't stand in for the deadline.
		const deadline = parseHHMM(t.arrival_window_end);
		head = deadline ? `Arrive by ${clock(deadline)}` : "Arrival deadline not set";
	} else {
		head = "Anytime";
	}

	return { date, time: head + tail };
}

export type ChipMode = "column" | "inline" | "sliver";

const compact = (c: Clock) => (c.m === 0 ? `${c.h % 12 || 12}` : bare(c));
const tiny = (c: Clock) => `${compact(c)}${c.h >= 12 ? "p" : "a"}`;

/** Card chip text. Shares the popup's parsing so both read the same constraint the same way. */
export function constraintChip(t: SnapshotTiming, mode: ChipMode): string {
	const finish = finishClock(t);
	const suffix =
		t.finish_constraint === "when_done"
			? " · open end"
			: finish
				? ` · ${t.finish_constraint === "by" ? "done by" : "ends"} ${bare(finish)}`
				: "";

	if (t.arrival_constraint === "at") {
		const s = parseHHMM(t.arrival_time) ?? fromInstant(t.start);
		if (mode === "sliver") return tiny(s);
		if (mode === "inline") return bare(s);
		return finish && t.finish_constraint === "at"
			? `${bare(s)}–${bare(finish)}`
			: `${bare(s)}${suffix}`;
	}
	if (t.arrival_constraint === "between") {
		const a = parseHHMM(t.arrival_window_start) ?? fromInstant(t.start);
		const b = parseHHMM(t.arrival_window_end) ?? fromInstant(t.end);
		if (mode === "sliver") return `${tiny(a)} ◆`;
		if (mode === "inline") return `${compact(a)}–${compact(b)}`;
		return `Arrive ${compact(a)}–${compact(b)}${suffix}`;
	}
	if (t.arrival_constraint === "by") {
		if (mode === "sliver") return "◆";
		const d = parseHHMM(t.arrival_window_end);
		if (!d) return mode === "inline" ? "by —" : `Deadline not set${suffix}`;
		return mode === "inline" ? `by ${compact(d)}` : `by ${bare(d)}${suffix}`;
	}
	return "";
}
