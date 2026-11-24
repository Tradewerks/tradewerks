/**
 * Invoice schedule dates. `next_invoice_at` is the instant an invoice should be
 * *generated*: 00:00 in the plan's timezone on (billing date − generateDaysBefore).
 *
 * Day anchoring:
 *   - weekly / biweekly   → dayOfWeek ("MO"–"SU")
 *   - monthly / quarterly → dayOfMonth (1–31; clamps to the month's length)
 */

import {
	addLocalDays,
	daysInMonth,
	isoWeekday,
	toLocalDate,
	zonedWallTimeToUtc,
	type LocalDate,
} from "./recurrence/zonedTime.js";

export type ScheduleFrequency = "weekly" | "biweekly" | "monthly" | "quarterly";

export type ScheduleAnchor = {
	frequency: ScheduleFrequency;
	dayOfMonth: number | null;
	dayOfWeek: string | null;
	generateDaysBefore: number;
	timezone: string;
};

const WEEKDAY_NAMES: Record<string, number> = {
	MO: 1,
	TU: 2,
	WE: 3,
	TH: 4,
	FR: 5,
	SA: 6,
	SU: 7,
};

/** Builds an anchor from an invoice_schedule row or its request body. */
export function scheduleAnchor(
	s: {
		frequency: string;
		day_of_month?: number | null;
		day_of_week?: string | null;
		generate_days_before?: number | null;
	},
	timezone: string,
): ScheduleAnchor {
	return {
		frequency: s.frequency as ScheduleFrequency,
		dayOfMonth: s.day_of_month ?? null,
		dayOfWeek: s.day_of_week ?? null,
		generateDaysBefore: s.generate_days_before ?? 0,
		timezone,
	};
}

/**
 * First generation instant whose billing date is on or after the later of
 * `from` and `notBefore` (plan `starts_at`), as local dates in the plan's zone.
 */
export function calculateNextInvoiceAt(
	a: ScheduleAnchor,
	opts: { from: Date; notBefore?: Date },
): Date {
	let floor = toLocalDate(opts.from, a.timezone);
	if (opts.notBefore) {
		const nb = toLocalDate(opts.notBefore, a.timezone);
		if (nb > floor) floor = nb;
	}
	return generationInstant(a, firstBillingOnOrAfter(a, floor));
}

/** Next generation instant one period after the one at `currentNextAt`. */
export function advanceNextInvoiceAt(
	a: ScheduleAnchor,
	currentNextAt: Date,
): Date {
	const generated = storedGenerationDate(currentNextAt, a.timezone);
	const billed = addLocalDays(generated, a.generateDaysBefore ?? 0);
	return generationInstant(a, billingAfter(a, billed));
}

/**
 * Billing-date floor for recomputing a schedule that may already have billed,
 * so a recompute never lands on a billed period (or `startsAt` if later).
 *
 * A stored next_invoice_at is the first unbilled period, so its billing date is
 * the floor; last_invoiced_at can't be trusted then, since generate_days_before
 * may have been edited since that run, and a late run would push it past an
 * unbilled period. Only without one does the floor fall back to the day after
 * the period the last run billed.
 */
export function notBeforeAfterBilled(
	timezone: string,
	startsAt: Date,
	prior:
		| {
				next_invoice_at?: Date | null;
				last_invoiced_at?: Date | null;
				generate_days_before?: number | null;
		  }
		| null
		| undefined,
): Date {
	const gdb = prior?.generate_days_before ?? 0;
	let billing: LocalDate | null = null;
	if (prior?.next_invoice_at) {
		billing = billingDateOf(prior.next_invoice_at, gdb, timezone);
	} else if (prior?.last_invoiced_at) {
		billing = addLocalDays(
			toLocalDate(prior.last_invoiced_at, timezone),
			gdb + 1,
		);
	}
	if (!billing) return startsAt;
	const floor = zonedWallTimeToUtc(billing, "00:00", timezone);
	return floor > startsAt ? floor : startsAt;
}

/** Local billing date of the period a stored next_invoice_at generates. */
export function billingDateOf(
	nextInvoiceAt: Date,
	generateDaysBefore: number,
	timezone: string,
): LocalDate {
	return addLocalDays(
		storedGenerationDate(nextInvoiceAt, timezone),
		generateDaysBefore,
	);
}

type ScheduleInput = {
	frequency: string;
	day_of_month?: number | null;
	day_of_week?: string | null;
	generate_days_before?: number | null;
};

type StoredSchedule = {
	frequency: string;
	day_of_month: number | null;
	day_of_week: string | null;
	generate_days_before: number;
	next_invoice_at: Date | null;
	last_invoiced_at: Date | null;
	is_active: boolean;
};

/**
 * next_invoice_at to store when a schedule is written over `existing`.
 * on_visit_completion never bills by date, but keeps next_invoice_at as the
 * first-unbilled watermark in case the schedule switches back to a cadence.
 */
export function nextInvoiceAtForEdit(
	sched: ScheduleInput,
	existing: StoredSchedule | null,
	plan: { timezone: string; starts_at: Date },
	opts: { now: Date; startsMoved?: boolean },
): Date | null {
	if (sched.frequency === "on_visit_completion") {
		return existing?.next_invoice_at ?? null;
	}
	const anchorChanged =
		!existing ||
		existing.frequency !== sched.frequency ||
		existing.day_of_month !== (sched.day_of_month ?? null) ||
		existing.day_of_week !== (sched.day_of_week ?? null) ||
		existing.generate_days_before !== (sched.generate_days_before ?? 0);
	// Switching back on must not replay every period missed while off.
	const staleOnReEnable =
		!!existing &&
		!existing.is_active &&
		!!existing.next_invoice_at &&
		existing.next_invoice_at < opts.now;
	if (
		existing?.next_invoice_at &&
		!anchorChanged &&
		!opts.startsMoved &&
		!staleOnReEnable
	) {
		return existing.next_invoice_at;
	}
	return calculateNextInvoiceAt(scheduleAnchor(sched, plan.timezone), {
		from: opts.now,
		notBefore: notBeforeAfterBilled(
			plan.timezone,
			plan.starts_at,
			existing,
		),
	});
}

/**
 * generate_days_before to store. on_visit_completion keeps the prior value so
 * the watermark's billing date (next_invoice_at + gdb) stays derivable.
 */
export function generateDaysBeforeForEdit(
	sched: ScheduleInput,
	existing: StoredSchedule | null,
): number {
	if (sched.frequency === "on_visit_completion" && existing) {
		return existing.generate_days_before;
	}
	return sched.generate_days_before ?? 0;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Local generation date of a stored next_invoice_at. Rows written before
 * timezone-aware scheduling hold 00:00 UTC (prod runs UTC); any instant that is
 * not 00:00 local in `tz` is read as one of those.
 */
function storedGenerationDate(at: Date, tz: string): LocalDate {
	const local = toLocalDate(at, tz);
	if (zonedWallTimeToUtc(local, "00:00", tz).getTime() === at.getTime()) {
		return local;
	}
	return at.toISOString().slice(0, 10);
}

/** Moves `d` to the nearest target weekday (within ±3 days). */
function snapToWeekday(a: ScheduleAnchor, d: LocalDate): LocalDate {
	const delta = ((((targetWeekday(a) - isoWeekday(d)) % 7) + 10) % 7) - 3;
	return addLocalDays(d, delta);
}

function generationInstant(a: ScheduleAnchor, billing: LocalDate): Date {
	return zonedWallTimeToUtc(
		addLocalDays(billing, -(a.generateDaysBefore ?? 0)),
		"00:00",
		a.timezone,
	);
}

function targetWeekday(a: ScheduleAnchor): number {
	return WEEKDAY_NAMES[a.dayOfWeek ?? "MO"] ?? 1;
}

function monthDay(a: ScheduleAnchor, year: number, month1: number): LocalDate {
	const day = Math.min(
		Math.max(1, a.dayOfMonth ?? 1),
		daysInMonth(year, month1),
	);
	return `${String(year).padStart(4, "0")}-${String(month1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonths(year: number, month1: number, n: number): [number, number] {
	const idx = year * 12 + (month1 - 1) + n;
	return [Math.floor(idx / 12), (idx % 12) + 1];
}

function ym(d: LocalDate): [number, number] {
	return [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
}

function firstBillingOnOrAfter(a: ScheduleAnchor, floor: LocalDate): LocalDate {
	switch (a.frequency) {
		case "weekly":
		case "biweekly": {
			const ahead = (targetWeekday(a) - isoWeekday(floor) + 7) % 7;
			return addLocalDays(floor, ahead);
		}
		case "monthly":
		case "quarterly": {
			const [y, m] = ym(floor);
			const here = monthDay(a, y, m);
			if (here >= floor) return here;
			const [ny, nm] = addMonths(y, m, 1);
			return monthDay(a, ny, nm);
		}
		default:
			throw new Error(
				`Unsupported invoice schedule frequency: ${String(a.frequency)}`,
			);
	}
}

function billingAfter(a: ScheduleAnchor, billed: LocalDate): LocalDate {
	switch (a.frequency) {
		case "weekly":
			return snapToWeekday(a, addLocalDays(billed, 7));
		case "biweekly":
			return snapToWeekday(a, addLocalDays(billed, 14));
		case "monthly":
		case "quarterly": {
			const [y, m] = ym(billed);
			const [ny, nm] = addMonths(y, m, a.frequency === "monthly" ? 1 : 3);
			return monthDay(a, ny, nm);
		}
		default:
			throw new Error(
				`Unsupported invoice schedule frequency: ${String(a.frequency)}`,
			);
	}
}
