import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	getQuoteFunnelReport,
	getQuoteFunnelSummary,
} from "../reportsController.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findMany: vi.fn() },
		$queryRawUnsafe: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

type Fn = ReturnType<typeof vi.fn>;
const mockDb = vi.mocked(db) as unknown as {
	quote: { findMany: Fn };
	$queryRawUnsafe: Fn;
};

const ORG = "org-1";

beforeEach(() => {
	vi.clearAllMocks();
});

const aQuote = (over: Record<string, unknown>) => ({
	id: "q",
	quote_number: "Q-1",
	title: "t",
	client: { name: "Acme" },
	request: null,
	total: 100,
	created_at: new Date("2026-08-01T00:00:00Z"),
	issued_at: new Date("2026-08-01T00:00:00Z"),
	sent_at: new Date("2026-08-02T00:00:00Z"),
	viewed_at: null,
	approved_at: null,
	status: "Sent",
	...over,
});

/**
 * Approved -> Disputed -> Repeal -> Cancelled is the first path that puts one
 * quote in both the timestamp-driven approved stage and the status-driven lost
 * set. Counting it on both sides of the ratio inflates win rate.
 */
describe("getQuoteFunnelReport win rate", () => {
	it("does not count an approved-then-repealed quote as both won and lost", async () => {
		mockDb.quote.findMany.mockResolvedValue([
			aQuote({
				id: "won",
				status: "Approved",
				approved_at: new Date("2026-08-03T00:00:00Z"),
				total: 100,
			}),
			aQuote({
				id: "repealed",
				status: "Cancelled",
				approved_at: new Date("2026-08-03T00:00:00Z"),
				total: 50,
			}),
			aQuote({ id: "lost", status: "Rejected", total: 25 }),
		]);

		const res = await getQuoteFunnelReport(undefined, undefined, ORG);

		// 1 won / (1 won + 2 lost). The old population was 2/(2+2) = 50%.
		expect(res.winRate).toBe(33);
		expect(res.valueWon).toBe(100);
		expect(res.valueLost).toBe(75);
		// The funnel STAGE stays timestamp-driven: the approval did happen.
		expect(res.funnel.approved).toBe(2);
	});

	// A revised quote is neither won nor lost, so it leaves the population
	// entirely rather than being counted as won on its stale approved_at.
	it("excludes a superseded (Revised) quote from the win-rate population", async () => {
		mockDb.quote.findMany.mockResolvedValue([
			aQuote({
				id: "won",
				status: "Approved",
				approved_at: new Date("2026-08-03T00:00:00Z"),
				total: 100,
			}),
			aQuote({
				id: "revised",
				status: "Revised",
				approved_at: new Date("2026-08-03T00:00:00Z"),
				total: 400,
			}),
		]);

		const res = await getQuoteFunnelReport(undefined, undefined, ORG);

		expect(res.winRate).toBe(100);
		expect(res.funnel.approved).toBe(2);
	});

	it("returns null rather than 0 when nothing has been decided", async () => {
		mockDb.quote.findMany.mockResolvedValue([aQuote({ status: "Sent" })]);

		const res = await getQuoteFunnelReport(undefined, undefined, ORG);

		expect(res.winRate).toBeNull();
	});
});

// The paged summary computes the same numbers in SQL. The FILTER clauses are
// interpolated from WON_QUOTE_STATUS / LOST_QUOTE_STATUSES (DW-24), so the SQL
// and the JS aggregation above cannot describe different won/lost populations.
describe("getQuoteFunnelSummary win rate", () => {
	it("builds the won/lost FILTER clauses from the shared status constants", async () => {
		mockDb.$queryRawUnsafe.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
		await getQuoteFunnelSummary(undefined, undefined, ORG);
		const sql = mockDb.$queryRawUnsafe.mock.calls[0][0] as string;
		expect(sql).toContain("q.status = 'Approved'");
		expect(sql).toContain("q.status IN ('Rejected', 'Expired', 'Cancelled')");
	});

	it("uses the current-status won count, not the approved stage", async () => {
		mockDb.$queryRawUnsafe
			.mockResolvedValueOnce([
				{
					created: 3,
					issued: 3,
					sent: 3,
					viewed: 0,
					approved: 2,
					wonCount: 1,
					valueWon: 100,
					valueLost: 75,
					lostCount: 2,
					avgDays: 2,
				},
			])
			.mockResolvedValueOnce([]);

		const res = await getQuoteFunnelSummary(undefined, undefined, ORG);

		expect(res.winRate).toBe(33);
		expect(res.funnel.approved).toBe(2);
		expect(mockDb.$queryRawUnsafe.mock.calls[0][0]).toContain('"wonCount"');
	});
});
