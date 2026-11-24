import { describe, expect, it } from "vitest";
import { ruleChanged } from "../ruleChanged";
import type { RecurringRule } from "../../../types/recurringPlans";

const stored = {
	id: "r1",
	recurring_plan_id: "p1",
	frequency: "weekly",
	interval: 1,
	by_weekday: [
		{ id: "w2", recurring_rule_id: "r1", weekday: "WE" },
		{ id: "w1", recurring_rule_id: "r1", weekday: "MO" },
	],
	by_month_day: null,
	by_month: null,
	arrival_constraint: "at",
	finish_constraint: "when_done",
	arrival_time: "09:00",
	arrival_window_start: null,
	arrival_window_end: null,
	finish_time: null,
	created_at: "2026-11-01T00:00:00Z",
} as RecurringRule;

const unchanged = {
	frequency: "weekly" as const,
	interval: 1,
	by_weekday: ["MO" as const, "WE" as const],
	by_month_day: undefined,
	by_month: undefined,
	arrival_constraint: "at" as const,
	finish_constraint: "when_done" as const,
	arrival_time: "09:00",
	arrival_window_start: null,
	arrival_window_end: null,
	finish_time: null,
};

describe("ruleChanged", () => {
	it("an untouched rule is not resent", () => {
		expect(ruleChanged(unchanged, stored)).toBe(false);
	});

	it("a new arrival time is a change", () => {
		expect(ruleChanged({ ...unchanged, arrival_time: "10:00" }, stored)).toBe(true);
	});

	it("a different weekday set is a change", () => {
		expect(ruleChanged({ ...unchanged, by_weekday: ["MO"] }, stored)).toBe(true);
	});

	it("a time left over from another arrival constraint is ignored", () => {
		expect(
			ruleChanged(unchanged, { ...stored, arrival_window_end: "12:00" } as RecurringRule),
		).toBe(false);
	});

	it("a plan with no stored rule always sends one", () => {
		expect(ruleChanged(unchanged, undefined)).toBe(true);
	});
});
