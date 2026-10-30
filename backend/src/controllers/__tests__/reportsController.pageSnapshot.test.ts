import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPageSnapshot, PAGES } from "../reportsController.js";
import { db } from "../../db.js";
import type { HttpError } from "../../types/responses.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const model = () => ({ count: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() });
	const mockDb = {
		job: model(),
		quote: model(),
		request: model(),
		invoice: model(),
		client: model(),
		inventory_item: model(),
		project: model(),
		recurring_plan: model(),
		$queryRaw: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

type Fn = ReturnType<typeof vi.fn>;
type Model = { count: Fn; aggregate: Fn; groupBy: Fn; findMany: Fn };
const mockDb = vi.mocked(db) as unknown as Record<
	"job" | "quote" | "request" | "invoice" | "client" | "inventory_item" | "project" | "recurring_plan",
	Model
> & { $queryRaw: Fn };

const ORG = "org-1";
const AGING = { notIn: ["Draft", "Paid", "Void", "Disputed"] };

type Where = Record<string, unknown>;
// Keyed on the where clause so the tests don't depend on query order.
const invoiceAggregate = ({ where }: { where: Where }) => {
	const status = where.status as Record<string, unknown> | undefined;
	if (status && "equals" in status) return { _sum: { balance_due: 120 } };
	if ((where.balance_due as Where | undefined)?.gt === 0) return { _sum: { balance_due: 300 } };
	if (status && "notIn" in status && (status.notIn as string[]).length === 2) return { _sum: { total: 5000 } };
	return { _sum: { balance_due: 500 } };
};

const value = (res: Awaited<ReturnType<typeof getPageSnapshot>>, label: string) =>
	res.stats.find((s) => s.label === label)?.value;

beforeEach(() => {
	vi.clearAllMocks();
	for (const m of ["job", "quote", "request", "client", "inventory_item", "project", "recurring_plan"] as const) {
		mockDb[m].count.mockResolvedValue(0);
		mockDb[m].aggregate.mockResolvedValue({ _sum: { total: 0, estimated_total: 0 } });
		mockDb[m].findMany.mockResolvedValue([]);
	}
	mockDb.invoice.aggregate.mockImplementation(async (args: { where: Where }) => invoiceAggregate(args));
	mockDb.$queryRaw.mockResolvedValue([{ value: 0, missingCost: 0 }]);
});

describe("getPageSnapshot", () => {
	it("rejects an unknown page with a typed 400", async () => {
		let caught: HttpError | undefined;
		try {
			await getPageSnapshot(ORG, "nope");
		} catch (e) {
			caught = e as HttpError;
		}
		expect(caught?.statusCode).toBe(400);
		expect(caught?.code).toBe("VALIDATION_ERROR");
	});

	const LABELS: Record<(typeof PAGES)[number], string[]> = {
		jobs: ["Open", "Unscheduled"],
		quotes: ["Open", "Pipeline"],
		requests: ["Open"],
		invoices: ["Outstanding", "Overdue"],
		clients: ["Active", "Open Balance", "Avg. Income"],
		inventory: ["Low", "Out of Stock", "Asset Value"],
		projects: ["Open", "Overdue"],
		recurring_plans: ["Active", "Paused", "Ending Soon"],
	};
	for (const page of PAGES) {
		it(`returns the spec's snapshot labels in order — ${page}`, async () => {
			const res = await getPageSnapshot(ORG, page);
			expect(res.page).toBe(page);
			expect(res.stats.map((s) => s.label)).toEqual(LABELS[page]);
		});
	}

	// The cohort filter was the bug: "Open" read as the backlog but only
	// counted jobs created inside the popover's range.
	it("never filters by created_at or a plan-in-effect range", async () => {
		for (const page of ["jobs", "quotes", "requests", "projects", "recurring_plans"] as const) {
			await getPageSnapshot(ORG, page);
		}
		for (const m of ["job", "quote", "request", "project", "recurring_plan"] as const) {
			const wheres = [...mockDb[m].count.mock.calls, ...mockDb[m].aggregate.mock.calls].map(
				(c) => c[0].where as Where,
			);
			expect(wheres.length).toBeGreaterThan(0);
			for (const w of wheres) {
				expect(w.created_at).toBeUndefined();
				expect(w.starts_at).toBeUndefined();
				expect(w.OR).toBeUndefined();
			}
		}
	});

	it("counts current plan status, not plans in effect", async () => {
		mockDb.recurring_plan.count
			.mockResolvedValueOnce(6)
			.mockResolvedValueOnce(2)
			.mockResolvedValueOnce(1);
		const res = await getPageSnapshot(ORG, "recurring_plans");
		const wheres = mockDb.recurring_plan.count.mock.calls.map((c) => c[0].where);
		expect(wheres[0]).toEqual({ organization_id: ORG, status: "Active" });
		expect(wheres[1]).toEqual({ organization_id: ORG, status: "Paused" });
		expect(res.stats.map((s) => s.value)).toEqual([6, 2, 1]);
	});

	it("invoices Outstanding equals clients Open Balance (aging + disputed)", async () => {
		const invoices = await getPageSnapshot(ORG, "invoices");
		const clients = await getPageSnapshot(ORG, "clients");
		expect(value(invoices, "Outstanding")).toBe(620);
		expect(value(clients, "Open Balance")).toBe(620);
	});

	// A credit nets into what's owed overall but is never "overdue".
	it("invoices Overdue counts only positive past-due collectable balances", async () => {
		const res = await getPageSnapshot(ORG, "invoices");
		const overdue = mockDb.invoice.aggregate.mock.calls
			.map((c) => c[0].where as Where)
			.find((w) => (w.balance_due as Where).gt === 0)!;
		expect(overdue.status).toEqual(AGING);
		expect(overdue.OR).toEqual([
			{ due_date: { lte: expect.any(Date) } },
			{ due_date: null, created_at: { lte: expect.any(Date) } },
		]);
		expect(value(res, "Overdue")).toBe(300);
	});

	it("jobs Unscheduled sums estimated_total of every unscheduled job", async () => {
		mockDb.job.aggregate.mockResolvedValue({ _sum: { estimated_total: 840 } });
		const res = await getPageSnapshot(ORG, "jobs");
		expect(mockDb.job.aggregate.mock.calls[0][0].where).toEqual({ organization_id: ORG, status: "Unscheduled" });
		expect(value(res, "Unscheduled")).toBe(840);
	});

	it("Avg. Income spreads issued billing over the whole client book", async () => {
		mockDb.client.count.mockResolvedValue(10);
		const res = await getPageSnapshot(ORG, "clients");
		expect(value(res, "Avg. Income")).toBe(500);
	});

	it("Ending Soon counts live plans ending within 30 days, overdue included", async () => {
		await getPageSnapshot(ORG, "recurring_plans");
		const w = mockDb.recurring_plan.count.mock.calls[2][0].where;
		expect(w.status).toEqual({ in: ["Active", "Paused"] });
		const days = (w.ends_at.lte.getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(29.9);
		expect(days).toBeLessThanOrEqual(30);
	});
});

// `not: 0` rather than `gt: 0`: an unapplied credit carries a negative
// balance_due, and a positive-only filter overstated what was owed.
describe("openReceivables (via Outstanding)", () => {
	it("nets credits in and adds the disputed balance back", async () => {
		await getPageSnapshot(ORG, "invoices");
		const wheres = mockDb.invoice.aggregate.mock.calls.map((c) => c[0].where as Where);
		const aging = wheres.find((w) => (w.balance_due as Where).not === 0 && !("equals" in (w.status as Where)))!;
		const disputed = wheres.find((w) => "equals" in (w.status as Where))!;
		expect(aging.status).toEqual(AGING);
		expect(disputed.status).toEqual({ equals: "Disputed" });
		expect(disputed.balance_due).toEqual({ not: 0 });
	});
});
