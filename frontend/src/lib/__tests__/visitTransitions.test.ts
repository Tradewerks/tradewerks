import { describe, it, expect } from "vitest";
import { canApplyVisitVerb, VISIT_TRANSITIONS } from "../visitTransitions";

describe("canApplyVisitVerb", () => {
	it("mirrors the backend from-sets", () => {
		expect(canApplyVisitVerb("drive", "Scheduled")).toBe(true);
		expect(canApplyVisitVerb("drive", "Delayed")).toBe(true);
		expect(canApplyVisitVerb("arrive", "Driving")).toBe(true);
		expect(canApplyVisitVerb("start", "OnSite")).toBe(true);
		expect(canApplyVisitVerb("pause", "InProgress")).toBe(true);
		expect(canApplyVisitVerb("resume", "Paused")).toBe(true);
	});

	it("allows complete from all three working states", () => {
		expect(canApplyVisitVerb("complete", "OnSite")).toBe(true);
		expect(canApplyVisitVerb("complete", "InProgress")).toBe(true);
		expect(canApplyVisitVerb("complete", "Paused")).toBe(true);
		expect(canApplyVisitVerb("complete", "Scheduled")).toBe(false);
	});

	it("refuses every verb from a finished visit", () => {
		const verbs = Object.keys(VISIT_TRANSITIONS) as (keyof typeof VISIT_TRANSITIONS)[];
		for (const verb of verbs) {
			expect(canApplyVisitVerb(verb, "Completed")).toBe(false);
			expect(canApplyVisitVerb(verb, "Cancelled")).toBe(false);
		}
	});
});
