import { describe, it, expect, vi } from "vitest";
import { getOverviewMetrics } from "../reportsController.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	// Approved in window: 5, mostly older quotes. Created in window: 2, one approved.
	const quoteCount = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
		if (where.approved_at) return 5;
		return where.status === "Approved" ? 1 : 2;
	});
	const mockDb = {
		quote: { count: quoteCount },
		job: {
			count: vi.fn(async () => 0),
			aggregate: vi.fn(async () => ({ _avg: { estimated_total: null }, _sum: { estimated_total: null } })),
		},
		job_visit: { aggregate: vi.fn(async () => ({ _sum: { total: null } })) },
		$queryRaw: vi.fn(async () => [{ avg_days: 0 }]),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

// Rate is approved-of-created (one cohort), so approvals of older quotes can't push it past 100%.
describe("getOverviewMetrics conversionRate", () => {
	it("uses the created-in-window cohort", async () => {
		const m = await getOverviewMetrics("2026-10-01", "2026-10-31", "org-1");
		expect(m.convertedQuotes.value).toBe(5);
		expect(m.conversionRate.value).toBe(50);
	});
});
