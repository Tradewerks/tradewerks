import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTaxLiabilityReport } from "../reportsController.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = { invoice: { findMany: vi.fn() }, $extends };
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

const mockDb = vi.mocked(db) as unknown as { invoice: { findMany: ReturnType<typeof vi.fn> } };

const invoice = (rounding: string | undefined, taxCents: number) => ({
	id: `inv-${rounding}`,
	tax_amount: taxCents / 100,
	tax_rate: 0,
	subtotal: 9.99,
	discount_amount: 0,
	tax_snapshot: {
		version: 2,
		locked_at: "2026-10-19T00:00:00.000Z",
		...(rounding ? { rounding } : {}),
		groups: [
			{
				id: "g",
				name: "WI",
				rates: [
					{ id: "st", name: "WI", rate: 0.05, jurisdiction: "state" },
					{ id: "co", name: "Dane", rate: 0.005, jurisdiction: "county" },
				],
				taxable_amount_cents: 999,
				tax_amount_cents: taxCents,
			},
		],
	},
});

const byRate = (rows: { rateKey: string; taxCollected: number }[]) =>
	Object.fromEntries(rows.map((r) => [r.rateKey, r.taxCollected]));

beforeEach(() => vi.clearAllMocks());

describe("getTaxLiabilityReport — per-rate split", () => {
	it("splits a half-up group exactly as it was taxed: 49.95 → 50 and 4.995 → 5", async () => {
		mockDb.invoice.findMany.mockResolvedValue([invoice("jurisdiction_half_up", 55)]);
		const rows = await getTaxLiabilityReport(undefined, undefined, "org-1");
		expect(byRate(rows)).toEqual({ "st:0.05": 0.5, "co:0.005": 0.05 });
	});

	it("leaves a line_floor group's split unchanged", async () => {
		mockDb.invoice.findMany.mockResolvedValue([invoice("line_floor", 51)]);
		const rows = await getTaxLiabilityReport(undefined, undefined, "org-1");
		// floor(49.95) = 49 and floor(4.995) = 4; the -2 remainder lands on the last rate.
		expect(byRate(rows)).toEqual({ "st:0.05": 0.49, "co:0.005": 0.02 });
	});

	it("reports a qb_ast invoice as one QuickBooks AST bucket at qb_tax_cents, not its estimate groups", async () => {
		const adopted = invoice("jurisdiction_half_up", 55);
		adopted.id = "inv-qb";
		adopted.tax_amount = 0.81;
		Object.assign(adopted.tax_snapshot, { source: "qb_ast", qb_tax_cents: 81 });
		mockDb.invoice.findMany.mockResolvedValue([adopted, invoice("jurisdiction_half_up", 55)]);
		const rows = await getTaxLiabilityReport(undefined, undefined, "org-1");
		expect(byRate(rows)).toEqual({ __qb_ast__: 0.81, "st:0.05": 0.5, "co:0.005": 0.05 });
		const qb = rows.find((r) => r.rateKey === "__qb_ast__");
		expect(qb).toMatchObject({ jurisdiction: "QuickBooks AST", invoiceCount: 1 });
	});

	const adoptedPair = (creditQbCents: number) => {
		const adopted = invoice("jurisdiction_half_up", 55);
		adopted.id = "inv-qb";
		adopted.tax_amount = 0.81;
		Object.assign(adopted.tax_snapshot, { source: "qb_ast", qb_tax_cents: 81 });
		const credit = invoice("jurisdiction_half_up", -55);
		credit.id = "adj-qb";
		credit.subtotal = -9.99;
		credit.tax_amount = creditQbCents / 100;
		credit.tax_snapshot.groups[0].taxable_amount_cents = -999;
		Object.assign(credit.tax_snapshot, { source: "qb_ast", qb_tax_cents: creditQbCents });
		return [adopted, credit];
	};

	it("nets a credit against an adopted invoice into the QuickBooks AST bucket", async () => {
		mockDb.invoice.findMany.mockResolvedValue(adoptedPair(-40));
		const rows = await getTaxLiabilityReport(undefined, undefined, "org-1");
		expect(byRate(rows)).toEqual({ __qb_ast__: 0.41 });
	});

	it("drops the QuickBooks AST bucket once an adopted invoice is fully credited", async () => {
		mockDb.invoice.findMany.mockResolvedValue([
			...adoptedPair(-81),
			invoice("jurisdiction_half_up", 55),
		]);
		const rows = await getTaxLiabilityReport(undefined, undefined, "org-1");
		expect(byRate(rows)).toEqual({ "st:0.05": 0.5, "co:0.005": 0.05 });
	});
});
