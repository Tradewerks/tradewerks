/**
 * Occurrence slots for a recurring rule. Each frequency jumps straight to the
 * first period that can reach the window, so the anchor's phase (every 2nd
 * week, every 3rd month) is fixed by the plan start, never by where the window
 * happens to begin.
 */
import {
	addLocalDays,
	daysInMonth,
	diffLocalDays,
	isoWeekStart,
	toLocalDate,
	zonedWallTimeToUtc,
	type LocalDate,
} from "./zonedTime.js";

type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export type SlotRule = {
	frequency: "daily" | "weekly" | "monthly" | "yearly";
	interval: number;
	by_weekday: Weekday[];
	by_month_day: number | null;
	by_month: number | null;
	arrival_constraint: "anytime" | "at" | "between" | "by";
	finish_constraint: "when_done" | "at" | "by";
	arrival_time: string | null;
	arrival_window_start: string | null;
	arrival_window_end: string | null;
	finish_time: string | null;
};

export type Slot = { date: LocalDate; start: Date; end: Date };

/** A recurring_rule row loaded with `include: { by_weekday: true }`. */
export type RecurringRuleWithWeekdays = Omit<SlotRule, "by_weekday"> & {
	by_weekday: readonly { weekday: Weekday }[];
};

const ISO_WEEKDAY: Record<Weekday, number> = {
	MO: 1,
	TU: 2,
	WE: 3,
	TH: 4,
	FR: 5,
	SA: 6,
	SU: 7,
};

const MINUTE_MS = 60_000;

function parseHHMM(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return h * 60 + m;
}

function formatHHMM(totalMinutes: number): string {
	const clamped = Math.max(0, Math.min(totalMinutes, 23 * 60 + 59));
	const h = String(Math.floor(clamped / 60)).padStart(2, "0");
	const m = String(clamped % 60).padStart(2, "0");
	return `${h}:${m}`;
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

function ymd(year: number, month1: number, day: number): LocalDate {
	return `${pad(year, 4)}-${pad(month1)}-${pad(day)}`;
}

function splitDate(d: LocalDate): [number, number, number] {
	const [y, m, day] = d.split("-").map(Number);
	return [y, m, day];
}

function clampedDate(year: number, month1: number, day: number): LocalDate {
	return ymd(year, month1, Math.min(day, daysInMonth(year, month1)));
}

export function visitTimesForRule(rule: SlotRule): {
	startHHMM: string;
	durationMinutes: number;
} {
	let startHHMM = "09:00";
	if (rule.arrival_constraint === "at" && rule.arrival_time) {
		startHHMM = rule.arrival_time;
	} else if (
		rule.arrival_constraint === "between" &&
		rule.arrival_window_start
	) {
		startHHMM = rule.arrival_window_start;
	} else if (rule.arrival_constraint === "by" && rule.arrival_window_end) {
		// 4 hours before the deadline, floored at 09:00.
		const startM = Math.max(
			9 * 60,
			parseHHMM(rule.arrival_window_end) - 240,
		);
		startHHMM = formatHHMM(startM);
	}

	let durationMinutes = 120;
	if (
		(rule.finish_constraint === "at" || rule.finish_constraint === "by") &&
		rule.finish_time
	) {
		durationMinutes =
			Math.max(0, parseHHMM(rule.finish_time) - parseHHMM(startHHMM)) ||
			120;
	}

	return { startHHMM, durationMinutes };
}

function dailyDates(
	anchor: LocalDate,
	interval: number,
	lo: LocalDate,
	hi: LocalDate,
): LocalDate[] {
	const out: LocalDate[] = [];
	const k0 = Math.max(0, Math.ceil(diffLocalDays(lo, anchor) / interval));
	for (
		let d = addLocalDays(anchor, k0 * interval);
		d <= hi;
		d = addLocalDays(d, interval)
	) {
		out.push(d);
	}
	return out;
}

function weeklyDates(
	anchor: LocalDate,
	interval: number,
	weekdays: Weekday[],
	lo: LocalDate,
	hi: LocalDate,
): LocalDate[] {
	const offsets = [...new Set(weekdays.map((w) => ISO_WEEKDAY[w] - 1))].sort(
		(a, b) => a - b,
	);
	if (offsets.length === 0) return [];
	const w0 = isoWeekStart(anchor);
	// One interval of slack below the window's week keeps the bound safe
	// whatever lo's weekday; the date filter discards the extra period.
	const lowerWeek = Math.floor(diffLocalDays(lo, w0) / 7) - interval;
	const p0 = Math.max(0, Math.ceil(lowerWeek / interval) * interval);

	const out: LocalDate[] = [];
	for (let p = p0; ; p += interval) {
		const weekStart = addLocalDays(w0, 7 * p);
		if (weekStart > hi) break;
		for (const off of offsets) out.push(addLocalDays(weekStart, off));
	}
	return out;
}

function monthlyDates(
	anchor: LocalDate,
	interval: number,
	monthDay: number,
	lo: LocalDate,
	hi: LocalDate,
): LocalDate[] {
	const [ay, am] = splitDate(anchor);
	const [ly, lm] = splitDate(lo);
	const anchorIdx = ay * 12 + (am - 1);
	const monthsToLo = ly * 12 + (lm - 1) - anchorIdx;
	const k0 = Math.max(0, Math.floor(monthsToLo / interval) * interval);

	const out: LocalDate[] = [];
	for (let k = k0; ; k += interval) {
		const idx = anchorIdx + k;
		const year = Math.floor(idx / 12);
		const month1 = (idx % 12) + 1;
		if (ymd(year, month1, 1) > hi) break;
		out.push(clampedDate(year, month1, monthDay));
	}
	return out;
}

function yearlyDates(
	anchor: LocalDate,
	interval: number,
	month1: number,
	monthDay: number,
	lo: LocalDate,
	hi: LocalDate,
): LocalDate[] {
	const [ay] = splitDate(anchor);
	const [ly] = splitDate(lo);
	const k0 = Math.max(0, Math.floor((ly - ay) / interval) * interval);

	const out: LocalDate[] = [];
	for (let k = k0; ; k += interval) {
		const year = ay + k;
		if (ymd(year, 1, 1) > hi) break;
		out.push(clampedDate(year, month1, monthDay));
	}
	return out;
}

export function computeSlots(
	rule: SlotRule,
	plan: { startsAt: Date; endsAt: Date | null; timezone: string },
	window: { from: LocalDate; to: LocalDate },
): Slot[] {
	const tz = plan.timezone;
	const anchor = toLocalDate(plan.startsAt, tz);
	const endsLocal = plan.endsAt ? toLocalDate(plan.endsAt, tz) : null;
	const lo = window.from > anchor ? window.from : anchor;
	const hi =
		endsLocal !== null && endsLocal < window.to ? endsLocal : window.to;
	if (lo > hi) return [];

	// A bad interval would otherwise loop forever.
	const interval = Math.max(1, Math.floor(rule.interval) || 1);

	let candidates: LocalDate[];
	switch (rule.frequency) {
		case "daily":
			candidates = dailyDates(anchor, interval, lo, hi);
			break;
		case "weekly":
			candidates = weeklyDates(anchor, interval, rule.by_weekday, lo, hi);
			break;
		case "monthly":
			candidates =
				rule.by_month_day === null
					? []
					: monthlyDates(anchor, interval, rule.by_month_day, lo, hi);
			break;
		case "yearly":
			candidates =
				rule.by_month === null || rule.by_month_day === null
					? []
					: yearlyDates(
							anchor,
							interval,
							rule.by_month,
							rule.by_month_day,
							lo,
							hi,
						);
			break;
	}

	const dates = [...new Set(candidates)]
		.filter((d) => d >= lo && d <= hi)
		.sort();
	const { startHHMM, durationMinutes } = visitTimesForRule(rule);
	return dates.map((date) => {
		const start = zonedWallTimeToUtc(date, startHHMM, tz);
		return {
			date,
			start,
			end: new Date(start.getTime() + durationMinutes * MINUTE_MS),
		};
	});
}

export function toSlotRule(rule: RecurringRuleWithWeekdays): SlotRule {
	return {
		frequency: rule.frequency,
		interval: rule.interval,
		by_weekday: rule.by_weekday.map((w) => w.weekday),
		by_month_day: rule.by_month_day,
		by_month: rule.by_month,
		arrival_constraint: rule.arrival_constraint,
		finish_constraint: rule.finish_constraint,
		arrival_time: rule.arrival_time,
		arrival_window_start: rule.arrival_window_start,
		arrival_window_end: rule.arrival_window_end,
		finish_time: rule.finish_time,
	};
}
