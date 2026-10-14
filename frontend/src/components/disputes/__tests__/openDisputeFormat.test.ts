import { describe, expect, it } from "vitest";
import { disputeAgeDays, openDisputePath, STALE_AFTER_DAYS } from "../openDisputeFormat";

describe("openDisputeFormat", () => {
	it("stale threshold is 7 days", () => {
		expect(STALE_AFTER_DAYS).toBe(7);
	});
	it("counts whole days since opened, never negative", () => {
		const now = Date.parse("2026-09-11T12:00:00Z");
		expect(disputeAgeDays("2026-09-11T08:00:00Z", now)).toBe(0);
		expect(disputeAgeDays("2026-08-30T12:00:00Z", now)).toBe(12);
		expect(disputeAgeDays("2026-09-12T00:00:00Z", now)).toBe(0);
	});
	it("routes to the right detail page", () => {
		expect(openDisputePath({ kind: "quote", document_id: "q1" })).toBe("/dispatch/quotes/q1");
		expect(openDisputePath({ kind: "invoice", document_id: "i1" })).toBe("/dispatch/invoices/i1");
	});
});
