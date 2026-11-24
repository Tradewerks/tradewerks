import { describe, it, expect } from "vitest";
import {
	PLAN_TRANSITIONS,
	PlanTransitionError,
	assertPlanTransition,
	planBills,
	planEffects,
	type PlanStatus,
} from "../recurringPlanState.js";

const STATUSES: PlanStatus[] = ["Active", "Paused", "Expired", "Cancelled", "Completed"];

describe("recurring plan state machine", () => {
	it("PLAN_TRANSITIONS matches the table", () => {
		expect(PLAN_TRANSITIONS).toMatchInlineSnapshot(`
			{
			  "Active": [
			    "Paused",
			    "Cancelled",
			    "Completed",
			    "Expired",
			  ],
			  "Cancelled": [],
			  "Completed": [],
			  "Expired": [
			    "Active",
			    "Cancelled",
			  ],
			  "Paused": [
			    "Active",
			    "Cancelled",
			    "Completed",
			  ],
			}
		`);
	});

	it("only an active plan generates, creates visits and bills", () => {
		for (const s of STATUSES) {
			const on = s === "Active";
			expect(planEffects(s)).toEqual({ generates: on, createsVisits: on, bills: on });
			expect(planBills(s)).toBe(on);
		}
	});

	it("Cancelled to Active is rejected", () => {
		expect(() => assertPlanTransition("Cancelled", "Active", "user")).toThrow(
			PlanTransitionError,
		);
		expect(() => assertPlanTransition("Cancelled", "Active", "system")).toThrow(
			PlanTransitionError,
		);
	});

	it("Active to Expired is rejected for a user and allowed for the system", () => {
		expect(() => assertPlanTransition("Active", "Expired", "user")).toThrow(
			PlanTransitionError,
		);
		expect(() => assertPlanTransition("Active", "Expired", "system")).not.toThrow();
	});
});
