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
		expect([...PAGES]).toEqual(["jobs", "quotes", "requests", "invoices", "clients", "inventory", "projects"]);
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

// Open Balance and Avg Income exclude Draft and Void invoices — only issued,
// unpaid invoices with a positive balance count as open receivables. Disputed
// invoices are still owed, so Open Balance is the sum of a non-disputed aging
// aggregate and a disputed aggregate — mirroring the aged-receivables reports,
// where Disputed is carved out of the ageing population but stays in the total.
describe("getPageSummary — clients", () => {
	beforeEach(() => {
		mockDb.client.count.mockResolvedValue(10);
		mockDb.client.groupBy.mockResolvedValue([]);
		mockDb.invoice.aggregate
			.mockResolvedValueOnce({ _sum: { balance_due: 200 } })
			.mockResolvedValueOnce({ _sum: { balance_due: 50 } })
			.mockResolvedValueOnce({ _sum: { total: 5000 } });
	});

	// `not: 0` rather than `gt: 0`: an unapplied credit adjustment carries a
	// negative balance_due, and a positive-only filter left it out entirely, so
	// Open Balance overstated what the client owed by the whole credit.
	it("Open Balance mirrors aged receivables: issued, with a non-zero balance, plus any disputed balance", async () => {
		const res = await getPageSummary(ORG, "clients");
		const agingArgs = mockDb.invoice.aggregate.mock.calls[0][0];
		expect(agingArgs.where.status).toEqual({ notIn: ["Draft", "Paid", "Void", "Disputed"] });
		expect(agingArgs.where.balance_due).toEqual({ not: 0 });
		expect(agingArgs._sum).toEqual({ balance_due: true });

		const disputedArgs = mockDb.invoice.aggregate.mock.calls[1][0];
		expect(disputedArgs.where.status).toEqual({ equals: "Disputed" });
		expect(disputedArgs.where.balance_due).toEqual({ not: 0 });
		expect(disputedArgs._sum).toEqual({ balance_due: true });

		expect(stat(res, "Open Balance")).toBe(250);
	});

	it("lets a credit reduce Open Balance instead of vanishing from it", async () => {
		mockDb.invoice.aggregate.mockReset();
		mockDb.invoice.aggregate
			// $2,000 owed less a $500 credit, both inside the filter: the DB
			// sums both only because the where clause reads `not: 0`, not
			// `gt: 0` — asserted below, or this mocked total proves nothing.
			.mockResolvedValueOnce({ _sum: { balance_due: 1500 } })
			.mockResolvedValueOnce({ _sum: { balance_due: 0 } })
			.mockResolvedValueOnce({ _sum: { total: 5000 } });

		const res = await getPageSummary(ORG, "clients");

		const agingArgs = mockDb.invoice.aggregate.mock.calls[0][0];
		expect(agingArgs.where.balance_due).toEqual({ not: 0 });
		expect(stat(res, "Open Balance")).toBe(1500);
	});

	it("Avg Income spreads issued (non-Draft, non-Void) billing over the whole client book", async () => {
		const res = await getPageSummary(ORG, "clients");
		const incomeArgs = mockDb.invoice.aggregate.mock.calls[2][0];
		expect(incomeArgs.where.status).toEqual(ISSUED);
		expect(incomeArgs._sum).toEqual({ total: true });
		expect(stat(res, "Avg. Income")).toBe(500);
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

		const res = await getPageSummary(ORG, "inventory");

		expect(stat(res, "Total Items")).toBe(12345);
		expect(mockDb.inventory_item.count.mock.calls[0][0].where).toEqual(
			mockDb.inventory_item.findMany.mock.calls[0][0].where,
		);
		expect(mockDb.inventory_item.findMany.mock.calls[0][0].take).toBe(10000);
		expect(stat(res, "Asset Value")).toBe(10);
	});
});
