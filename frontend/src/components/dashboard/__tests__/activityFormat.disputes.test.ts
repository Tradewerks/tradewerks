import { describe, expect, it } from "vitest";
import { formatActivity, resolveRoute } from "../activityFormat";
import type { ActivityLog } from "../../../types/logs";

const log = (over: Partial<ActivityLog>): ActivityLog => ({
	id: "l1",
	event_type: "quote.dispute_opened",
	action: "updated",
	entity_type: "quote",
	entity_id: "q1",
	actor_type: "dispatcher",
	actor_id: "d1",
	actor_name: "Sam",
	changes: null,
	timestamp: "2026-09-11T00:00:00Z",
	ip_address: null,
	user_agent: null,
	reason: null,
	organization_id: "o1",
	...over,
});

describe("dispute feed lines", () => {
	it("names an opened quote dispute by number", () => {
		const entry = formatActivity(
			log({ changes: { _quote_number: { old: null, new: "Q-0031" }, status: { old: "Sent", new: "Disputed" } } }),
			"UTC",
		);
		expect(entry?.message).toBe("Quote Q-0031 disputed");
		expect(entry?.color).toBe("text-warning-text");
	});

	it("still reads without a number", () => {
		expect(formatActivity(log({ event_type: "invoice.dispute_opened", entity_type: "invoice" }), "UTC")?.message).toBe(
			"Invoice disputed",
		);
		expect(formatActivity(log({ event_type: "invoice.dispute_resolved", entity_type: "invoice" }), "UTC")?.message).toBe(
			"Dispute on invoice resolved",
		);
	});

	it("names the outcome on a resolved invoice dispute", () => {
		const entry = formatActivity(
			log({
				event_type: "invoice.dispute_resolved",
				entity_type: "invoice",
				entity_id: "i1",
				changes: {
					_invoice_number: { old: null, new: "INV-0142" },
					dispute_resolution: { old: null, new: "IssueAdjustment" },
				},
			}),
			"UTC",
		);
		expect(entry?.message).toBe("Dispute on INV-0142 resolved — Issue Adjustment");
	});

	it("never shows the reason text", () => {
		const entry = formatActivity(log({ reason: "Billed 2 hours" }), "UTC");
		expect(JSON.stringify(entry)).not.toContain("Billed 2 hours");
	});

	it.each([
		["quote.dispute_opened", "q1", "/dispatch/quotes/q1"],
		["quote.dispute_resolved", "q1", "/dispatch/quotes/q1"],
		["invoice.dispute_opened", "i1", "/dispatch/invoices/i1"],
		["invoice.dispute_resolved", "i1", "/dispatch/invoices/i1"],
	])("%s routes to the document", (event_type, entity_id, path) => {
		expect(resolveRoute(log({ event_type, entity_id }))).toBe(path);
	});
});
