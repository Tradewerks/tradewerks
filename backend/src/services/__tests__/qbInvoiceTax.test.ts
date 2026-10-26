import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, tx } = vi.hoisted(() => ({
	sdb: {
		invoice: { findFirst: vi.fn(), findMany: vi.fn(async () => []), update: vi.fn() },
		client_external_mapping: { upsert: vi.fn(async () => ({})), findMany: vi.fn() },
		item_external_mapping: { findMany: vi.fn(async () => []) },
	},
	tx: {
		invoice: { create: vi.fn(async () => ({ id: "local1" })) },
		invoice_line_item: { createMany: vi.fn() },
	},
}));

vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../db.js", () => ({ db: { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(async () => ({ Invoice: { Id: "qb1", TotalAmt: 12.85 } })),
	getOrgRealmId: vi.fn(async () => "realm1"),
	isQBConnected: vi.fn(async () => true),
}));
vi.mock("../qb/qbCustomers.js", () => ({ findOrCreateQBCustomer: vi.fn() }));
vi.mock("../qb/qbQuery.js", () => ({ qbQueryAll: vi.fn(async () => []) }));
vi.mock("../qb/qbItems.js", () => ({ findOrCreateQBItem: vi.fn(async () => "tax-item-9") }));
vi.mock("../qb/qbTax.js", () => ({ getQBTaxPrefs: vi.fn(async () => ({ automatedSalesTax: false })) }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { qbFetch } from "../quickbooksService.js";
import { qbQueryAll } from "../qb/qbQuery.js";
import { getQBTaxPrefs } from "../qb/qbTax.js";
import { log } from "../appLogger.js";
import { pushInvoice, importQBInvoices } from "../qb/qbInvoices.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const line = (over: Record<string, unknown> = {}) => ({
	total: 6,
	quantity: 1,
	unit_price: 6,
	name: "Labor",
	description: null,
	taxable: true,
	tax_group: { qb_tax_code_id: "2" },
	inventory_item: null,
	...over,
});
const anInvoice = (line_items: unknown[], over: Record<string, unknown> = {}) => ({
	id: "inv1",
	status: "Issued",
	invoice_number: "INV-0007",
	qb_invoice_id: null,
	account_id: "",
	due_date: null,
	memo: null,
	discount_amount: 0.12,
	tax_amount: 0.97,
	total: 12.85,
	client_id: "c1",
	client: { name: "Riverside", contacts: [], client_external_mapping: [{ external_id: "cust1" }] },
	line_items,
	...over,
});
const pushed = () => mockFn(qbFetch).mock.calls.at(-1)![3] as { Line: any[]; TxnTaxDetail?: unknown };

describe("pushInvoice tax", () => {
	beforeEach(() => vi.clearAllMocks());

	it("applies the shared mapped tax code in a non-AST company", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(anInvoice([line(), line({ taxable: false, tax_group: null })]));

		await pushInvoice("inv1", "org1");

		const body = pushed();
		expect(body.TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: "2" } });
		expect(body.Line.map((l) => l.SalesItemLineDetail?.TaxCodeRef?.value)).toEqual(["TAX", "NON", undefined]);
		expect(body.Line.some((l) => l.Description === "Sales Tax")).toBe(false);
	});

	it("sends a Sales Tax line and all-NON lines under AST", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValueOnce({ automatedSalesTax: true });
		sdb.invoice.findFirst.mockResolvedValueOnce(anInvoice([line(), line()]));

		await pushInvoice("inv1", "org1");

		const body = pushed();
		expect(body.TxnTaxDetail).toBeUndefined();
		const tax = body.Line.find((l) => l.Description === "Sales Tax");
		expect(tax).toMatchObject({ Amount: 0.97, SalesItemLineDetail: { ItemRef: { value: "tax-item-9" }, TaxCodeRef: { value: "NON" } } });
		expect(body.Line.filter((l) => l.SalesItemLineDetail).every((l) => l.SalesItemLineDetail.TaxCodeRef.value === "NON")).toBe(true);
	});

	it("falls back to the Sales Tax line when taxable lines mix tax codes", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(anInvoice([line(), line({ tax_group: { qb_tax_code_id: "3" } })]));

		await pushInvoice("inv1", "org1");

		expect(getQBTaxPrefs).not.toHaveBeenCalled();
		expect(pushed().Line.some((l) => l.Description === "Sales Tax")).toBe(true);
	});

	it("adds no tax line when there is no tax", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(
			anInvoice([line({ tax_group: null })], { tax_amount: 0, total: 11.88 }),
		);
		mockFn(qbFetch).mockResolvedValueOnce({ Invoice: { Id: "qb1", TotalAmt: 11.88 } });

		await pushInvoice("inv1", "org1");

		expect(pushed().Line.some((l) => l.Description === "Sales Tax")).toBe(false);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("warns when QuickBooks' total differs from ours", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(anInvoice([line()]));
		mockFn(qbFetch).mockResolvedValueOnce({ Invoice: { Id: "qb1", TotalAmt: 11.88 } });

		await pushInvoice("inv1", "org1");

		expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ qbTotal: 11.88, total: 12.85 }), expect.any(String));
	});
});

describe("importQBInvoices Sales Tax line", () => {
	beforeEach(() => vi.clearAllMocks());

	it("folds the Sales Tax line into tax_amount instead of a line item", async () => {
		mockFn(qbQueryAll).mockResolvedValueOnce([
			{
				Id: "qb1",
				DocNumber: "INV-0007",
				CustomerRef: { value: "cust1" },
				TotalAmt: 12.85,
				Line: [
					{ DetailType: "SalesItemLineDetail", Amount: 12, SalesItemLineDetail: { Qty: 1, UnitPrice: 12, ItemRef: { value: "1", name: "Services" } } },
					{ DetailType: "DiscountLineDetail", Amount: 0.12 },
					{ DetailType: "SalesItemLineDetail", Amount: 0.97, SalesItemLineDetail: { Qty: 1, UnitPrice: 0.97, ItemRef: { value: "9", name: "Sales Tax" } } },
					{ DetailType: "SubTotalLineDetail", Amount: 12.85 },
				],
			},
		]);
		sdb.client_external_mapping.findMany.mockResolvedValueOnce([{ external_id: "cust1", client_id: "c1" }]);

		const res = await importQBInvoices("org1", ["qb1"]);

		expect(res.imported).toBe(1);
		const data = mockFn(tx.invoice.create).mock.calls[0][0].data;
		expect(data).toMatchObject({ subtotal: 12, tax_amount: 0.97, total: 12.85 });
		expect(mockFn(tx.invoice_line_item.createMany).mock.calls[0][0].data).toHaveLength(1);
	});
});
