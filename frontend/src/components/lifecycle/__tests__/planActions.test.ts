import { describe, it, expect } from "vitest";
import { planActions } from "../planActions";
import { splitActions } from "../overflow";
import { RecurringPlanStatusValues } from "../../../types/recurringPlans";
import type { RecurringPlanStatus } from "../../../types/recurringPlans";

const noop = () => {};
const handlers = { pause: noop, resume: noop, generate: noop, complete: noop, cancel: noop };

const ctx = (over: Record<string, unknown> = {}) => ({
	status: "Active" as RecurringPlanStatus,
	canManage: true,
	hasJobContainer: true,
	handlers,
	...over,
});

describe("planActions", () => {
	it("offers the same actions in the same order in every status", () => {
		const ids = planActions(ctx()).map((a) => a.id);
		expect(ids).toEqual(["pause", "resume", "generate", "complete", "cancel"]);

		for (const status of RecurringPlanStatusValues) {
			expect(planActions(ctx({ status })).map((a) => a.id)).toEqual(ids);
		}
	});

	it("gives every disabled action a reason, in every status", () => {
		for (const status of RecurringPlanStatusValues) {
			for (const a of planActions(ctx({ status }))) {
				if (a.disabled) {
					expect(a.disabledReason, `${status}/${a.id}`).toBeTruthy();
				}
			}
		}
	});

	it("never puts the destructive action in the visible row", () => {
		for (const status of RecurringPlanStatusValues) {
			const { inline } = splitActions("normal", planActions(ctx({ status })));
			expect(inline.some((a) => a.intent === "destructive")).toBe(false);
		}
	});

	it("pauses only an active plan and resumes only a paused one", () => {
		const active = planActions(ctx({ status: "Active" }));
		expect(active[0].disabled).toBe(false); // pause
		expect(active[1].disabled).toBe(true); // resume

		const paused = planActions(ctx({ status: "Paused" }));
		expect(paused[0].disabled).toBe(true);
		expect(paused[1].disabled).toBe(false);
	});

	it("generates occurrences only while active", () => {
		expect(planActions(ctx({ status: "Active" }))[2].disabled).toBe(false);
		expect(planActions(ctx({ status: "Paused" }))[2].disabled).toBe(true);
		expect(planActions(ctx({ status: "Completed" }))[2].disabled).toBe(true);
	});

	it("shuts everything on a finished plan", () => {
		for (const status of ["Completed", "Cancelled"] as RecurringPlanStatus[]) {
			for (const a of planActions(ctx({ status }))) {
				expect(a.disabled, `${status}/${a.id}`).toBe(true);
			}
		}
	});

	it("refuses everything without manage_recurring_plans", () => {
		for (const a of planActions(ctx({ canManage: false }))) {
			expect(a.disabled).toBe(true);
			expect(a.disabledReason).toMatch(/permission/i);
		}
	});

	it("refuses everything before the plan has a job container", () => {
		for (const a of planActions(ctx({ hasJobContainer: false }))) {
			expect(a.disabled).toBe(true);
			expect(a.disabledReason).toMatch(/first occurrence/i);
		}
	});

	it("checks permission before the job-container gate", () => {
		for (const a of planActions(ctx({ canManage: false, hasJobContainer: false }))) {
			expect(a.disabled).toBe(true);
			expect(a.disabledReason).toMatch(/permission/i);
		}
	});
});
