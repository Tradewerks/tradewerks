import { describe, it, expect } from "vitest";
import {
	createRecurringPlanSchema,
	updateRecurringPlanSchema,
} from "../recurringPlans.js";

const yearlyRule = {
	frequency: "yearly",
	interval: 1,
	by_month: 3,
	arrival_constraint: "anytime",
	finish_constraint: "when_done",
};

const createBody = {
	client_id: "11111111-1111-4111-8111-111111111111",
	name: "Annual tune-up",
	description: "Spring AC check",
	address: "1 Main St",
	coords: { lat: 41.88, lon: -87.63 },
	starts_at: "2026-11-16T14:00:00.000Z",
	line_items: [{ name: "Tune-up", quantity: 1, unit_price: 100 }],
};

function issuePaths(res: { success: boolean; error?: unknown }): string[] {
	const err = res.error as { issues: { path: PropertyKey[] }[] } | undefined;
	return (err?.issues ?? []).map((i) => i.path.join("."));
}

describe("recurring plan rule validation", () => {
	it("yearly rule without by_month_day is rejected", () => {
		const create = createRecurringPlanSchema.safeParse({
			...createBody,
			rule: yearlyRule,
		});
		expect(create.success).toBe(false);
		expect(issuePaths(create)).toContain("rule.by_month_day");

		const update = updateRecurringPlanSchema.safeParse({
			rule: yearlyRule,
		});
		expect(update.success).toBe(false);
		expect(issuePaths(update)).toContain("rule.by_month_day");
	});

	it("yearly rule with by_month and by_month_day is accepted", () => {
		const rule = { ...yearlyRule, by_month_day: 15 };
		expect(
			createRecurringPlanSchema.safeParse({ ...createBody, rule })
				.success,
		).toBe(true);
		expect(updateRecurringPlanSchema.safeParse({ rule }).success).toBe(
			true,
		);
	});
});
