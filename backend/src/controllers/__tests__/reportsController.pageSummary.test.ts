import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPageSummary, PAGES, BREAKDOWNS } from "../reportsController.js";
import { db } from "../../db.js";
import type { HttpError } from "../../types/responses.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: { count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
		invoice_payment: { aggregate: vi.fn() },
		client: { count: vi.fn(), groupBy: vi.fn() },
		inventory_item: { findMany: vi.fn(), count: vi.fn() },
		recurring_plan: { count: vi.fn(), groupBy: vi.fn() },
		quote: { count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
		job: { count: vi.fn(), groupBy: vi.fn() },
		job_visit: { aggregate: vi.fn() },
		request: { count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
		project: { count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
		$queryRaw: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

type Fn = ReturnType<typeof vi.fn>;
const mockDb = vi.mocked(db) as unknown as {
	invoice: { count: Fn; aggregate: Fn; groupBy: Fn };
	invoice_payment: { aggregate: Fn };
	client: { count: Fn; groupBy: Fn };
	inventory_item: { findMany: Fn; count: Fn };
	recurring_plan: { count: Fn; groupBy: Fn };
	quote: { count: Fn; aggregate: Fn; groupBy: Fn };
	job: { count: Fn; groupBy: Fn };
	job_visit: { aggregate: Fn };
	request: { count: Fn; aggregate: Fn; groupBy: Fn };
	project: { count: Fn; aggregate: Fn; groupBy: Fn };
	$queryRaw: Fn;
};

const ORG = "org-1";
const ISSUED = { notIn: ["Draft", "Void"] };

const stat = (res: Awaited<ReturnType<typeof getPageSummary>>, label: string) =>
	res.stats.find((s) => s.label === label)?.value;

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.$queryRaw.mockResolvedValue([{ avg_seconds: null }]);
});

describe("getPageSummary — page validation", () => {
	it("rejects an unknown page with a typed 400 rather than a generic Error", async () => {
		let caught: HttpError | undefined;
		try {
			await getPageSummary(ORG, "nope");
		} catch (e) {
			caught = e as HttpError;
		}
		expect(caught?.statusCode).toBe(400);
		expect(caught?.code).toBe("VALIDATION_ERROR");
	});

	it("exposes the page list and a breakdown set for every page (route schema reads these)", () => {
		expect([...PAGES]).toEqual(["jobs", "quotes", "requests", "invoices", "clients", "inventory", "projects", "recurring_plans"]);
		for (const p of PAGES) expect(BREAKDOWNS[p].length).toBeGreaterThan(0);
	});
});

// Total and Issued exclude Draft and Void invoices; Collected comes off
// invoice_payment.amount (partial payments included), not
// invoice.paid_at/amount_paid, which is only set on full payment.
describe("getPageSummary — invoices", () => {
	beforeEach(() => {
		mockDb.invoice.count.mockResolvedValue(4);
		mockDb.invoice.aggregate.mockResolvedValue({ _sum: { total: 1000 } });
		mockDb.invoice_payment.aggregate.mockResolvedValue({ _sum: { amount: 321.5 } });
		mockDb.invoice.groupBy.mockResolvedValue([
			{ status: "Draft", _count: { _all: 1 } },
			{ status: "Paid", _count: { _all: 3 } },
		]);
	});

	it("excludes Draft and Void from Total and Issued", async () => {
		await getPageSummary(ORG, "invoices");

		expect(mockDb.invoice.count).toHaveBeenCalledTimes(1);
		expect(mockDb.invoice.count.mock.calls[0][0].where.status).toEqual(ISSUED);

		// Issued is the only invoice.aggregate on this page now (Collected moved
		// to invoice_payment).
		expect(mockDb.invoice.aggregate).toHaveBeenCalledTimes(1);
		const issuedArgs = mockDb.invoice.aggregate.mock.calls[0][0];
		expect(issuedArgs.where.status).toEqual(ISSUED);
		expect(issuedArgs._sum).toEqual({ total: true });
	});

	it("sums Collected from invoice_payment rows (partials included), scoped to issued invoices", async () => {
		const start = "2026-08-01T06:00:00.000Z";
		const end = "2026-09-01T05:59:59.999Z";
		const res = await getPageSummary(ORG, "invoices", start, end);

		expect(mockDb.invoice_payment.aggregate).toHaveBeenCalledTimes(1);
		const args = mockDb.invoice_payment.aggregate.mock.calls[0][0];
		expect(args.where.invoice).toEqual({ organization_id: ORG, status: ISSUED });
		// Dated by when the payment was recorded, using the instants as sent.
		expect(args.where.paid_at).toEqual({ gte: new Date(start), lte: new Date(end) });
		expect(args._sum).toEqual({ amount: true });
		expect(stat(res, "Collected")).toBe(321.5);
	});

	it("with no range, Collected is all-time payments (no paid_at filter at all)", async () => {
		await getPageSummary(ORG, "invoices");
		const args = mockDb.invoice_payment.aggregate.mock.calls[0][0];
		expect(args.where.paid_at).toBeUndefined();
	});

	it("keeps every status in the By Status breakdown (it drills into the Invoices list, which shows Draft/Void)", async () => {
		const res = await getPageSummary(ORG, "invoices", undefined, undefined, "status");
		const g = mockDb.invoice.groupBy.mock.calls[0][0];
		expect(g.by).toEqual(["status"]);
		expect(g.where.status).toBeUndefined();
		expect(res.breakdown).toEqual([
			{ label: "Draft", value: 1 },
			{ label: "Paid", value: 3 },
		]);
	});
});

// Open Balance, Active and Avg. Income are unranged; they live in getPageSnapshot.
describe("getPageSummary — clients", () => {
	it("reports only New, ranged by created date", async () => {
		mockDb.client.count.mockResolvedValue(3);
		mockDb.client.groupBy.mockResolvedValue([]);
		const start = "2026-08-01T06:00:00.000Z";
		const res = await getPageSummary(ORG, "clients", start);
		expect(res.stats.map((s) => [s.label, s.value])).toEqual([["New", 3]]);
		expect(mockDb.client.count.mock.calls[0][0].where.created_at).toEqual({ gte: new Date(start) });
		expect(mockDb.invoice.aggregate).not.toHaveBeenCalled();
	});
});

// Review 02-F7: Total Items came from the length of a row-capped list.
describe("getPageSummary — inventory", () => {
	it("reports Total Items from count(), not the capped row list", async () => {
		mockDb.inventory_item.findMany.mockResolvedValue([
			{ id: "a", quantity: 5, low_stock_threshold: 10, cost: 2 },
			{ id: "b", quantity: 0, low_stock_threshold: null, cost: 1 },
		]);
		mockDb.inventory_item.count.mockResolvedValue(12345);
		mockDb.$queryRaw.mockResolvedValue([{ value: 55, missingCost: 0 }]);

		const res = await getPageSummary(ORG, "inventory");

		expect(stat(res, "Total Items")).toBe(12345);
		expect(mockDb.inventory_item.count.mock.calls[0][0].where).toEqual(
			mockDb.inventory_item.findMany.mock.calls[0][0].where,
		);
		expect(mockDb.inventory_item.findMany.mock.calls[0][0].take).toBe(10000);
		expect(stat(res, "Asset Value")).toBe(55);
		expect(res.stats.find((s) => s.label === "Asset Value")?.note).toBeUndefined();
	});

	// Asset value sums warehouse + fleet in SQL, uncapped, discontinued included.
	it("sums asset value in SQL and notes items without cost", async () => {
		mockDb.inventory_item.findMany.mockResolvedValue([]);
		mockDb.inventory_item.count.mockResolvedValue(0);
		mockDb.$queryRaw.mockResolvedValue([{ value: 55, missingCost: 3 }]);

		const res = await getPageSummary(ORG, "inventory");

		const sql = (mockDb.$queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join("");
		expect(sql).toContain("vehicle_stock_item");
		expect(sql).not.toContain("is_active");
		expect(res.stats.find((s) => s.label === "Asset Value")?.note).toBe("3 items without cost");
	});
});

describe("getPageSummary — recurring_plans", () => {
	beforeEach(() => {
		mockDb.recurring_plan.count
			.mockResolvedValueOnce(9)
			.mockResolvedValueOnce(6)
			.mockResolvedValueOnce(2)
			.mockResolvedValueOnce(1);
		mockDb.recurring_plan.groupBy.mockResolvedValue([
			{ status: "Active", _count: { _all: 6 } },
			{ status: "Paused", _count: { _all: 2 } },
		]);
	});

	// The Plans list's Date filter keeps plans IN EFFECT during the range (started
	// by its end, not ended before its start), so the report ranges the same way.
	it("ranges counts and breakdown by plans in effect during the range", async () => {
		const start = "2026-08-01T06:00:00.000Z";
		const end = "2026-09-01T05:59:59.999Z";
		const res = await getPageSummary(ORG, "recurring_plans", start, end);

		const inEffect = {
			starts_at: { lte: new Date(end) },
			OR: [{ ends_at: null }, { ends_at: { gte: new Date(start) } }],
		};
		const wheres = mockDb.recurring_plan.count.mock.calls.map((c) => c[0].where);
		expect(wheres).toEqual([{ organization_id: ORG, ...inEffect }]);
		expect(mockDb.recurring_plan.groupBy.mock.calls[0][0].where).toEqual({ organization_id: ORG, ...inEffect });

		// Active / Paused / Ending Soon are current state — getPageSnapshot.
		expect(res.stats.map((s) => [s.label, s.value])).toEqual([["Total", 9]]);
	});

	it("with no range, counts every plan (no visit filter)", async () => {
		await getPageSummary(ORG, "recurring_plans");
		const wheres = mockDb.recurring_plan.count.mock.calls.map((c) => c[0].where);
		expect(wheres[0]).toEqual({ organization_id: ORG });
		expect(mockDb.recurring_plan.groupBy.mock.calls[0][0].where).toEqual({ organization_id: ORG });
	});

	it("groups by status by default and by priority on request", async () => {
		const byStatus = await getPageSummary(ORG, "recurring_plans");
		expect(mockDb.recurring_plan.groupBy.mock.calls[0][0].by).toEqual(["status"]);
		expect(byStatus.breakdownLabel).toBe("By Status");
		expect(byStatus.breakdown).toEqual([
			{ label: "Active", value: 6 },
			{ label: "Paused", value: 2 },
		]);

		mockDb.recurring_plan.groupBy.mockResolvedValue([{ priority: "High", _count: { _all: 3 } }]);
		const byPriority = await getPageSummary(ORG, "recurring_plans", undefined, undefined, "priority");
		expect(mockDb.recurring_plan.groupBy.mock.calls[1][0].by).toEqual(["priority"]);
		expect(byPriority.breakdownLabel).toBe("By Priority");
		expect(byPriority.breakdown).toEqual([{ label: "High", value: 3 }]);
	});
});

describe("getPageSummary — quotes", () => {
	// Shown in a ~76px card beside four others; "Avg. Approve Time" wrapped to three lines.
	it("labels the approval-time stat short enough for one line", async () => {
		mockDb.quote.count.mockResolvedValue(0);
		mockDb.quote.aggregate.mockResolvedValue({ _sum: { total: 0 } });
		mockDb.quote.groupBy.mockResolvedValue([]);
		const res = await getPageSummary(ORG, "quotes");
		expect(res.stats.map((s) => s.label)).toContain("Approve Time");
	});
});

// Current-state stats moved to getPageSnapshot; the popover keeps only these.
describe("getPageSummary — period stats per page", () => {
	const PERIOD: Record<(typeof PAGES)[number], string[]> = {
		jobs: ["Total", "Revenue"],
		quotes: ["Total", "Approved", "Approve Time"],
		requests: ["Total", "Converted", "Est. Value"],
		invoices: ["Total", "Created", "Collected", "Avg. Days to Pay"],
		clients: ["New"],
		inventory: ["Total Items", "Low", "Out of Stock", "Asset Value"],
		projects: ["Total", "Budget", "Committed"],
		recurring_plans: ["Total"],
	};
	beforeEach(() => {
		const models = [mockDb.invoice, mockDb.client, mockDb.recurring_plan, mockDb.quote, mockDb.job, mockDb.request, mockDb.project];
		for (const m of models) {
			m.count.mockResolvedValue(0);
			m.groupBy.mockResolvedValue([]);
			if ("aggregate" in m) m.aggregate.mockResolvedValue({ _sum: {} });
		}
		mockDb.job_visit.aggregate.mockResolvedValue({ _sum: {} });
		mockDb.invoice_payment.aggregate.mockResolvedValue({ _sum: {} });
		mockDb.inventory_item.findMany.mockResolvedValue([]);
		mockDb.inventory_item.count.mockResolvedValue(0);
		mockDb.$queryRaw.mockResolvedValue([{}]);
	});
	for (const page of PAGES) {
		it(`period stats match the spec — ${page}`, async () => {
			const res = await getPageSummary(ORG, page);
			expect(res.stats.map((s) => s.label)).toEqual(PERIOD[page]);
		});
	}
});
