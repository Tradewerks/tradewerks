import { describe, it, expect } from "vitest";
import { FEED_EVENT_SET, FEED_EVENT_TYPES } from "../activityFeedEvents.js";

describe("activity feed allowlist", () => {
	it("the set and the list hold the same events", () => {
		expect([...FEED_EVENT_SET].sort()).toEqual([...FEED_EVENT_TYPES].sort());
	});

	it("includes all four dispute events", () => {
		for (const e of [
			"quote.dispute_opened",
			"quote.dispute_resolved",
			"invoice.dispute_opened",
			"invoice.dispute_resolved",
		]) {
			expect(FEED_EVENT_SET.has(e)).toBe(true);
		}
	});

	it("keeps every pre-existing feed event", () => {
		for (const e of [
			"job.created",
			"job_visit.created",
			"job_visit.updated",
			"job_visit.technicians_assigned",
			"request.created",
			"request.updated",
			"quote.created",
			"quote.updated",
			"invoice.created",
			"invoice.updated",
			"invoice_payment.created",
			"recurring_plan.created",
			"recurring_occurrence.generated",
			"technician.updated",
		]) {
			expect(FEED_EVENT_SET.has(e)).toBe(true);
		}
	});
});
