import { describe, it, expect } from "vitest";
import {
	computeSlots,
	toSlotRule,
	visitTimesForRule,
	type SlotRule,
} from "../occurrenceSlots.js";
import { diffLocalDays } from "../zonedTime.js";
import type { Prisma } from "../../../../generated/prisma/client.js";

const CHI = "America/Chicago";
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

function rule(overrides: Partial<SlotRule>): SlotRule {
	return {
		frequency: "monthly",
		interval: 1,
		by_weekday: [],
		by_month_day: null,
		by_month: null,
		arrival_constraint: "at",
		finish_constraint: "when_done",
		arrival_time: "08:00",
		arrival_window_start: null,
		arrival_window_end: null,
		finish_time: null,
		...overrides,
	};
}

/** Plan whose anchor is 08:00 Chicago on `date`. */
function plan(date: string, endsAt: Date | null = null) {
	return {
		startsAt: new Date(`${date}T14:00:00Z`),
		endsAt,
		timezone: CHI,
	};
}

const dates = (slots: { date: string }[]) => slots.map((s) => s.date);

describe("computeSlots", () => {
	it("monthly on the 1st created on the 16th starts next month", () => {
		const slots = computeSlots(
			rule({ frequency: "monthly", by_month_day: 1 }),
			plan("2026-11-16"),
			{ from: "2026-11-16", to: "2027-02-28" },
		);
		expect(dates(slots)).toEqual([
			"2026-12-01",
			"2027-01-01",
			"2027-02-01",
		]);
	});

	it("monthly on the 31st clamps to short months", () => {
		const slots = computeSlots(
			rule({ frequency: "monthly", by_month_day: 31 }),
			plan("2027-01-01"),
			{ from: "2027-01-01", to: "2027-05-31" },
		);
		expect(dates(slots)).toEqual([
			"2027-01-31",
			"2027-02-28",
			"2027-03-31",
			"2027-04-30",
			"2027-05-31",
		]);
	});

	it("monthly on the 29th in a leap February", () => {
		const slots = computeSlots(
			rule({ frequency: "monthly", by_month_day: 29 }),
			plan("2028-02-01"),
			{ from: "2028-02-01", to: "2028-02-29" },
		);
		expect(dates(slots)).toEqual(["2028-02-29"]);
	});

	it("every 3 months keeps the anchor phase when the window starts later", () => {
		const slots = computeSlots(
			rule({ frequency: "monthly", interval: 3, by_month_day: 15 }),
			plan("2026-01-15"),
			{ from: "2026-05-01", to: "2026-12-31" },
		);
		expect(dates(slots)).toEqual(["2026-07-15", "2026-10-15"]);
	});

	it("biweekly Tue/Thu skips alternate weeks", () => {
		const slots = computeSlots(
			rule({
				frequency: "weekly",
				interval: 2,
				by_weekday: ["TH", "TU"],
			}),
			plan("2026-11-16"),
			{ from: "2026-11-16", to: "2026-12-13" },
		);
		expect(dates(slots)).toEqual([
			"2026-11-17",
			"2026-11-19",
			"2026-12-01",
			"2026-12-03",
		]);
	});

	it("weekly drops weekdays before the start date in week 0", () => {
		const slots = computeSlots(
			rule({ frequency: "weekly", by_weekday: ["MO", "FR"] }),
			plan("2026-11-18"),
			{ from: "2026-11-01", to: "2026-11-30" },
		);
		expect(dates(slots)[0]).toBe("2026-11-20");
		expect(dates(slots)).toEqual([
			"2026-11-20",
			"2026-11-23",
			"2026-11-27",
			"2026-11-30",
		]);
	});

	it("daily every 3 days phase does not depend on window.from", () => {
		const r = rule({ frequency: "daily", interval: 3 });
		const a = computeSlots(r, plan("2026-11-01"), {
			from: "2026-11-02",
			to: "2026-11-30",
		});
		const b = computeSlots(r, plan("2026-11-01"), {
			from: "2026-11-05",
			to: "2026-11-30",
		});
		expect(a.length).toBeGreaterThan(0);
		expect(b.length).toBeGreaterThan(0);
		for (const s of [...a, ...b]) {
			expect(diffLocalDays(s.date, "2026-11-01") % 3).toBe(0);
		}
		expect(dates(a)[0]).toBe("2026-11-04");
		expect(dates(b)[0]).toBe("2026-11-07");
	});

	it("yearly Feb 29 lands on Feb 28 in non-leap years", () => {
		const slots = computeSlots(
			rule({ frequency: "yearly", by_month: 2, by_month_day: 29 }),
			plan("2027-01-01"),
			{ from: "2027-01-01", to: "2029-12-31" },
		);
		expect(dates(slots)).toEqual([
			"2027-02-28",
			"2028-02-29",
			"2029-02-28",
		]);
	});

	it("ends_at caps by local date", () => {
		const slots = computeSlots(
			rule({ frequency: "daily" }),
			plan("2026-12-29", new Date("2027-01-01T05:00:00Z")),
			{ from: "2026-12-29", to: "2027-01-05" },
		);
		expect(dates(slots)).toEqual([
			"2026-12-29",
			"2026-12-30",
			"2026-12-31",
		]);
	});

	it("slot start is 08:00 local across the DST change", () => {
		const slots = computeSlots(
			rule({ frequency: "weekly", by_weekday: ["SU"] }),
			plan("2026-10-25"),
			{ from: "2026-10-25", to: "2026-11-01" },
		);
		expect(dates(slots)).toEqual(["2026-10-25", "2026-11-01"]);
		expect(iso(slots[0].start)).toBe("2026-10-25T13:00:00Z");
		expect(iso(slots[1].start)).toBe("2026-11-01T14:00:00Z");
		expect(iso(slots[1].end)).toBe("2026-11-01T16:00:00Z");
	});

	it("returns nothing when the window ends before the anchor", () => {
		const slots = computeSlots(
			rule({ frequency: "daily" }),
			plan("2026-11-16"),
			{ from: "2026-11-01", to: "2026-11-15" },
		);
		expect(slots).toEqual([]);
	});

	it("weekly with a far-future window jumps without missing the phase", () => {
		const slots = computeSlots(
			rule({ frequency: "weekly", interval: 3, by_weekday: ["MO"] }),
			plan("2026-11-16"),
			{ from: "2030-01-01", to: "2030-03-01" },
		);
		expect(slots.length).toBeGreaterThan(0);
		for (const s of slots) {
			expect(diffLocalDays(s.date, "2026-11-16") % 21).toBe(0);
		}
	});
});

describe("visitTimesForRule", () => {
	it("between 08:00-10:00 with finish when_done gives 120 minutes", () => {
		expect(
			visitTimesForRule(
				rule({
					arrival_constraint: "between",
					arrival_time: null,
					arrival_window_start: "08:00",
					arrival_window_end: "10:00",
					finish_constraint: "when_done",
				}),
			),
		).toEqual({ startHHMM: "08:00", durationMinutes: 120 });
	});

	// Mirrors calculateOccurrenceDates in recurringPlansController.ts.
	it.each([
		[{ arrival_constraint: "anytime", arrival_time: null }, "09:00", 120],
		[{ arrival_constraint: "at", arrival_time: "07:30" }, "07:30", 120],
		[{ arrival_constraint: "at", arrival_time: null }, "09:00", 120],
		[
			{ arrival_constraint: "by", arrival_window_end: "15:00" },
			"11:00",
			120,
		],
		[
			{ arrival_constraint: "by", arrival_window_end: "11:00" },
			"09:00",
			120,
		],
		[
			{
				arrival_constraint: "at",
				arrival_time: "08:00",
				finish_constraint: "at",
				finish_time: "11:30",
			},
			"08:00",
			210,
		],
		[
			{
				arrival_constraint: "at",
				arrival_time: "08:00",
				finish_constraint: "by",
				finish_time: "07:00",
			},
			"08:00",
			120,
		],
		[
			{
				arrival_constraint: "at",
				arrival_time: "08:00",
				finish_constraint: "by",
				finish_time: null,
			},
			"08:00",
			120,
		],
	] as [Partial<SlotRule>, string, number][])(
		"matches the controller for %o",
		(overrides, startHHMM, durationMinutes) => {
			expect(visitTimesForRule(rule(overrides))).toEqual({
				startHHMM,
				durationMinutes,
			});
		},
	);
});

describe("toSlotRule", () => {
	it("flattens weekday rows and drops db-only fields", () => {
		const row = {
			id: "r1",
			created_at: new Date("2026-11-01T00:00:00Z"),
			recurring_plan_id: "p1",
			frequency: "weekly",
			interval: 2,
			by_weekday: [
				{ id: "w1", recurring_rule_id: "r1", weekday: "TU" },
				{ id: "w2", recurring_rule_id: "r1", weekday: "MO" },
			],
			by_month_day: null,
			by_month: null,
			arrival_constraint: "at",
			finish_constraint: "when_done",
			arrival_time: "08:00",
			arrival_window_start: null,
			arrival_window_end: null,
			finish_time: null,
		} as const;
		// Compile-time: the controller's Prisma include shape must fit.
		const fromPrisma = (
			r: Prisma.recurring_ruleGetPayload<{
				include: { by_weekday: true };
			}>,
		) => toSlotRule(r);
		expect(fromPrisma).toBeTypeOf("function");
		expect(toSlotRule(row)).toEqual(
			rule({
				frequency: "weekly",
				interval: 2,
				by_weekday: ["TU", "MO"],
			}),
		);
	});
});
