import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
	getJobBacklog,
	getFieldAddedRevenueReport,
	getRecurringRevenueReport,
	getRevenueLineItemsReport,
} from "../reportsController.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		job_visit_line_item: { findMany: vi.fn(), aggregate: vi.fn() },
		technician: { findMany: vi.fn() },
		recurring_plan: { findMany: vi.fn() },
		recurring_occurrence: { groupBy: vi.fn() },
		invoice: { groupBy: vi.fn() },
		invoice_line_item: { findMany: vi.fn() },
		$queryRaw: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

type Fn = ReturnType<typeof vi.fn>;
const mockDb = vi.mocked(db) as unknown as {
	job_visit_line_item: { findMany: Fn; aggregate: Fn };
	technician: { findMany: Fn };
	recurring_plan: { findMany: Fn };
	recurring_occurrence: { groupBy: Fn };
	invoice: { groupBy: Fn };
	invoice_line_item: { findMany: Fn };
	$queryRaw: Fn;
};

const ORG = "org-1";

// Tagged-template SQL arrives as the literal fragments in the first argument;
// joining them (interpolations dropped) is enough to assert on the SQL's shape.
const rawSql = (call: number) => (mockDb.$queryRaw.mock.calls[call][0] as string[]).join("");

beforeEach(() => {
	vi.clearAllMocks();
});

// Recurring-plan container jobs sit InProgress for the life of the plan; the
// backlog query must exclude them, or every recurring plan reports as
// stalled backlog.
describe("getJobBacklog", () => {
	it("excludes recurring-plan container jobs from the backlog", async () => {
		mockDb.$queryRaw.mockResolvedValue([]);
		await getJobBacklog(ORG);
		const sql = rawSql(0);
		expect(sql).toContain("recurring_plan_id IS NULL");
		expect(sql).toContain("status IN ('Unscheduled', 'Scheduled', 'InProgress')");
	});
});

// Field-added revenue counts only items on Completed visits, and the
// summary's item count is distinct items — an item split across two techs'
// shares counts once, not twice.
describe("getFieldAddedRevenueReport", () => {
	const item = (id: string, total: number, techIds: string[]) => ({
		id,
		total,
		reconciled_by_tech_id: null,
		visit: {
			job_id: "j1",
			scheduled_start_at: new Date("2026-08-05T10:00:00Z"),
			visit_techs: techIds.map((tid) => ({ tech: { id: tid, name: tid } })),
		},
	});

	beforeEach(() => {
		mockDb.job_visit_line_item.findMany.mockResolvedValue([
			item("a", 100, ["t1", "t2"]),
			item("b", 50, ["t1"]),
		]);
		mockDb.job_visit_line_item.aggregate.mockResolvedValue({ _sum: { total: 900 } });
		mockDb.technician.findMany.mockResolvedValue([
			{ id: "t1", name: "Alice" },
			{ id: "t2", name: "Bob" },
		]);
	});

	it("only looks at Completed visits, for both the items and the org revenue denominator", async () => {
		await getFieldAddedRevenueReport("2026-08-01T06:00:00.000Z", "2026-09-01T05:59:59.999Z", ORG);

		const itemsWhere = mockDb.job_visit_line_item.findMany.mock.calls[0][0].where;
		expect(itemsWhere.source).toBe("field_addition");
		expect(itemsWhere.visit.status).toBe("Completed");
		expect(itemsWhere.visit.scheduled_start_at).toEqual({
			gte: new Date("2026-08-01T06:00:00.000Z"),
			lte: new Date("2026-09-01T05:59:59.999Z"),
		});

		const aggWhere = mockDb.job_visit_line_item.aggregate.mock.calls[0][0].where;
		expect(aggWhere.visit.status).toBe("Completed");
	});

	it("reports the distinct item count separately from per-tech touches", async () => {
		const res = await getFieldAddedRevenueReport(undefined, undefined, ORG);
		// Item "a" is split across t1 and t2, so per-tech itemCounts sum to 3…
		expect(res.rows.reduce((s, r) => s + r.itemCount, 0)).toBe(3);
		// …but there are only 2 items.
		expect(res.fieldAddedItemCount).toBe(2);
		expect(res.orgVisitRevenue).toBe(900);
		expect(res.truncated).toBe(false);
	});

	it("caps the item load newest-first and flags truncation", async () => {
		await getFieldAddedRevenueReport(undefined, undefined, ORG);
		const args = mockDb.job_visit_line_item.findMany.mock.calls[0][0];
		expect(args.take).toBe(10000);
		expect(args.orderBy).toEqual({ visit: { scheduled_start_at: "desc" } });
	});
});

// Review 02-F7: the drilldown's fallback/export load was unbounded.
describe("getRevenueLineItemsReport", () => {
	it("caps the load and reports whether it hit the cap", async () => {
		mockDb.invoice_line_item.findMany.mockResolvedValue([]);
		const res = await getRevenueLineItemsReport(undefined, undefined, ORG);
		expect(mockDb.invoice_line_item.findMany.mock.calls[0][0].take).toBe(10000);
		expect(res).toEqual({ rows: [], truncated: false });
	});
});

// Review 02-F9: an Active plan past its ends_at counted as active; a
// fixed_amount plan with no amount read $0; churned MRR for variable-basis
// plans read $0 once the plan was >90 days gone.
describe("getRecurringRevenueReport", () => {
	const now = new Date("2026-08-19T12:00:00Z");
	const plan = (overrides: Record<string, unknown>) => ({
		id: "p",
		name: "Plan",
		status: "Active",
		starts_at: new Date("2025-01-01T00:00:00Z"),
		ends_at: null,
		updated_at: new Date("2025-06-01T00:00:00Z"),
		client: { name: "Acme" },
		invoice_schedule: {
			billing_basis: "fixed_amount",
			fixed_amount: 100,
			frequency: "monthly",
			next_invoice_at: null,
			last_invoiced_at: null,
		},
		line_items: [],
		...overrides,
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(now);
		mockDb.invoice.groupBy.mockResolvedValue([]);
		mockDb.recurring_occurrence.groupBy.mockResolvedValue([]);
		// First $queryRaw is the churned-trailing query, second is the 12-month trend.
		mockDb.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not count an Active plan whose ends_at has passed as active, nor in MRR", async () => {
		mockDb.recurring_plan.findMany.mockResolvedValue([
			plan({ id: "live" }),
			plan({ id: "expired", ends_at: new Date("2026-01-01T00:00:00Z") }),
		]);
		const res = await getRecurringRevenueReport(undefined, undefined, ORG);
		expect(res.activePlans).toBe(1);
		expect(res.mrr).toBe(100);
	});

	it("falls back to trailing actuals for a fixed_amount plan with no amount configured", async () => {
		mockDb.recurring_plan.findMany.mockResolvedValue([
			plan({ id: "noamt", invoice_schedule: { billing_basis: "fixed_amount", fixed_amount: null, frequency: "monthly" } }),
		]);
		mockDb.invoice.groupBy.mockResolvedValue([{ recurring_plan_id: "noamt", _sum: { total: 300 } }]);
		const res = await getRecurringRevenueReport(undefined, undefined, ORG);
		// $300 over the trailing 90 days → $100/month, not $0.
		expect(res.mrr).toBe(100);
		expect(res.plans[0].monthlyValue).toBe(100);
		expect(res.plans[0].perPeriodAmount).toBeNull();
	});

	it("values churned variable-basis plans from the trailing window ending at their end date", async () => {
		mockDb.recurring_plan.findMany.mockResolvedValue([
			plan({
				id: "gone",
				status: "Cancelled",
				ends_at: new Date("2026-03-01T00:00:00Z"),
				invoice_schedule: { billing_basis: "visit_actuals", fixed_amount: null, frequency: "monthly" },
			}),
		]);
		// Nothing in the live (now − 90d) window…
		mockDb.invoice.groupBy.mockResolvedValue([]);
		// …but $600 in the 90 days before the plan ended.
		mockDb.$queryRaw.mockReset();
		mockDb.$queryRaw
			.mockResolvedValueOnce([{ planId: "gone", revenue: 600 }])
			.mockResolvedValueOnce([]);

		const res = await getRecurringRevenueReport("2026-01-01", "2026-12-31", ORG);
		expect(res.churnedPlans).toBe(1);
		expect(res.churnedMrr).toBe(200);
		expect(res.mrr).toBe(0);

		const sql = rawSql(0);
		expect(sql).toContain("p.status IN ('Cancelled', 'Completed')");
		expect(sql).toContain("COALESCE(p.ends_at, p.updated_at)");
	});
});
