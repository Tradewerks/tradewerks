const { sdb, dbMock } = vi.hoisted(() => ({
	sdb: {
		invoice: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
		tax_group: { findMany: vi.fn(async () => []) },
		client_external_mapping: { upsert: vi.fn(async () => ({})) },
		organization: { update: vi.fn(async () => ({})) },
	},
	dbMock: {
		organization: { findUnique: vi.fn(async () => ({ qb_passthrough_tax_code_id: null })) },
	},
}));

vi.mock("../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../db.js", () => ({ db: dbMock }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm1"),
	isQBConnected: vi.fn(async () => true),
}));
vi.mock("../qb/qbCustomers.js", () => ({ findOrCreateQBCustomer: vi.fn() }));
vi.mock("../qb/qbQuery.js", () => ({ qbQueryAll: vi.fn(async () => []) }));
vi.mock("../qb/qbTax.js", () => ({ getQBTaxPrefs: vi.fn(async () => ({ automatedSalesTax: false })) }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("../qb/qbTaxableItem.js", async (importActual) => ({
	...(await importActual<typeof import("../qb/qbTaxableItem.js")>()),
	ensureTaxableItem: vi.fn(async () => null),
}));

vi.mock("../qb/qbInvoices.js", async (importActual) => {
	const actual = await importActual<typeof import("../qb/qbInvoices.js")>();
	return { ...actual, pushInvoice: vi.fn(actual.pushInvoice) };
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCreditMemoLines, isCreditAdjustment } from "../qb/qbCreditMemos.js";
import { pushInvoice } from "../qb/qbInvoices.js";
import { log } from "../appLogger.js";
import { qbFetch } from "../quickbooksService.js";
import { qbQueryAll } from "../qb/qbQuery.js";
import { getQBTaxPrefs } from "../qb/qbTax.js";
import { ensureTaxableItem, TAXABLE_ITEM_NAME } from "../qb/qbTaxableItem.js";

describe("isCreditAdjustment", () => {
	it("is true for an adjustment with a negative total", () => {
		expect(isCreditAdjustment({ adjusts_invoice_id: "o1", total: -17.93 })).toBe(true);
	});

	it("is false for a zero or positive total", () => {
		expect(isCreditAdjustment({ adjusts_invoice_id: "o1", total: 0 })).toBe(false);
		expect(isCreditAdjustment({ adjusts_invoice_id: "o1", total: 5 })).toBe(false);
	});

	it("is false when the invoice adjusts nothing", () => {
		expect(isCreditAdjustment({ adjusts_invoice_id: null, total: -5 })).toBe(false);
	});
});

describe("buildCreditMemoLines", () => {
	it("turns a negative quantity line into a positive qty x price credit", () => {
		const out = buildCreditMemoLines([
			{
				DetailType: "SalesItemLineDetail",
				Amount: -17,
				SalesItemLineDetail: {
					Qty: -2,
					UnitPrice: 8.5,
					ItemRef: { value: "19" },
					TaxCodeRef: { value: "TAX" },
				},
			},
		]);
		expect(out).toHaveLength(1);
		expect(out[0].Amount).toBe(17);
		expect(out[0].SalesItemLineDetail.Qty).toBe(2);
		expect(out[0].SalesItemLineDetail.UnitPrice).toBe(8.5);
		expect(out[0].SalesItemLineDetail.ItemRef).toEqual({ value: "19" });
		expect(out[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "TAX" });
	});

	it("flips a negative unit price when the quantity is positive", () => {
		const out = buildCreditMemoLines([
			{
				DetailType: "SalesItemLineDetail",
				Amount: -150,
				SalesItemLineDetail: { Qty: 1, UnitPrice: -150, ItemRef: { value: "3" } },
			},
		]);
		expect(out[0].Amount).toBe(150);
		expect(out[0].SalesItemLineDetail.Qty).toBe(1);
		expect(out[0].SalesItemLineDetail.UnitPrice).toBe(150);
	});

	it("drops discount lines", () => {
		const out = buildCreditMemoLines([
			{ DetailType: "DiscountLineDetail", Amount: 5, DiscountLineDetail: {} },
		]);
		expect(out).toEqual([]);
	});
});

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const { pushInvoice: actualPush } = await vi.importActual<typeof import("../qb/qbInvoices.js")>(
	"../qb/qbInvoices.js",
);

function creditFixture(over: Record<string, unknown> = {}) {
	return {
		id: "cm1",
		invoice_number: "INV-1-A1",
		status: "Sent",
		adjusts_invoice_id: "o1",
		adjusts_invoice: { invoice_number: "INV-1" },
		total: "-17.93",
		tax_amount: "-0.93",
		discount_amount: null,
		due_date: null,
		memo: null,
		qb_invoice_id: null,
		qb_credit_memo_id: null,
		account_id: "",
		client_id: "c1",
		tax_snapshot: null,
		line_items: [
			{
				total: "-17.00",
				quantity: "-2",
				unit_price: "8.50",
				name: "Filter",
				description: null,
				taxable: true,
				tax_group_id: "g1",
				tax_group: { qb_tax_code_id: "5" },
				inventory_item: null,
			},
		],
		client: {
			name: "Ada",
			is_tax_exempt: false,
			address: null,
			coords: null,
			contacts: [],
			client_external_mapping: [{ external_id: "qbc1" }],
		},
		jobs: [],
		...over,
	};
}

const postTo = (path: string) =>
	mockFn(qbFetch).mock.calls.find((c) => c[1] === "POST" && c[2] === path)?.[3] as
		| Record<string, any>
		| undefined;

describe("pushInvoice credit adjustments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: false });
		mockFn(qbQueryAll).mockResolvedValue([]);
		mockFn(sdb.tax_group.findMany).mockResolvedValue([{ id: "g1", qb_tax_code_id: "5" }]);
		mockFn(qbFetch).mockResolvedValue({
			CreditMemo: { Id: "cm-1", TxnTaxDetail: { TotalTax: 0.93 } },
		});
	});

	it("pushes a credit adjustment as a CreditMemo, not an Invoice", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(creditFixture());

		await pushInvoice("cm1", "org1");

		expect(postTo("/invoice")).toBeUndefined();
		const body = postTo("/creditmemo");
		expect(body?.Line[0].Amount).toBe(17);
		expect(body?.DocNumber).toBe("INV-1-A1");
		expect(body?.PrivateNote).toBe("Adjusts INV-1");
		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					qb_credit_memo_id: "cm-1",
					qb_sync_status: "synced",
					qb_tax_amount: 0.93,
				}),
			}),
		);
	});

	it("flags a CreditMemo whose QuickBooks tax differs", async () => {
		mockFn(qbFetch).mockResolvedValue({
			CreditMemo: { Id: "cm-1", TxnTaxDetail: { TotalTax: 1.1 } },
		});
		sdb.invoice.findFirst.mockResolvedValueOnce(creditFixture());

		await pushInvoice("cm1", "org1");

		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ qb_sync_status: "tax_mismatch", qb_tax_amount: 1.1 }),
			}),
		);
	});

	it("re-push updates the same CreditMemo", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string) =>
			method === "GET"
				? { CreditMemo: { Id: "cm-1", SyncToken: "3" } }
				: { CreditMemo: { Id: "cm-1", TxnTaxDetail: { TotalTax: 0.93 } } },
		);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			creditFixture({ qb_credit_memo_id: "cm-1", account_id: "realm1" }),
		);

		await pushInvoice("cm1", "org1");

		expect(mockFn(qbFetch).mock.calls[0].slice(1, 3)).toEqual(["GET", "/creditmemo/cm-1"]);
		expect(postTo("/creditmemo")).toMatchObject({ sparse: true, Id: "cm-1", SyncToken: "3" });
		expect(qbQueryAll).not.toHaveBeenCalled();
	});

	it("AST sends our tax as a TotalTax override", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: true });
		sdb.invoice.findFirst.mockResolvedValueOnce(creditFixture());

		await pushInvoice("cm1", "org1");

		expect(postTo("/creditmemo")?.TxnTaxDetail).toEqual({ TotalTax: 0.93 });
	});

	it("AST sends a hand-typed taxable line on the taxable stand-in", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: true });
		mockFn(ensureTaxableItem).mockResolvedValueOnce({ id: "T-1", name: TAXABLE_ITEM_NAME });
		sdb.invoice.findFirst.mockResolvedValueOnce(creditFixture());

		await pushInvoice("cm1", "org1");

		expect(ensureTaxableItem).toHaveBeenCalledWith("org1", "realm1");
		expect(postTo("/creditmemo")?.Line[0].SalesItemLineDetail.ItemRef).toEqual({
			value: "T-1",
			name: TAXABLE_ITEM_NAME,
		});
	});

	it("non-AST never loads the stand-in", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(creditFixture());

		await pushInvoice("cm1", "org1");

		expect(ensureTaxableItem).not.toHaveBeenCalled();
		expect(postTo("/creditmemo")?.Line[0].SalesItemLineDetail.ItemRef.value).toBe("1");
	});

	it("non-AST sends the tax as a positive override", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(creditFixture());

		await pushInvoice("cm1", "org1");

		expect(postTo("/creditmemo")?.TxnTaxDetail).toEqual({
			TxnTaxCodeRef: { value: "5" },
			TotalTax: 0.93,
		});
	});

	it("non-AST keeps the tax code when the snapshot group tax is negative", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(
			creditFixture({
				tax_snapshot: { groups: [{ id: "g1", tax_amount_cents: -93 }] },
			}),
		);

		await pushInvoice("cm1", "org1");

		expect(postTo("/creditmemo")?.TxnTaxDetail).toEqual({
			TxnTaxCodeRef: { value: "5" },
			TotalTax: 0.93,
		});
	});

	describe("applying the credit to the original", () => {
		const original = (over: Record<string, unknown> = {}) => ({
			id: "o1",
			qb_invoice_id: "158",
			account_id: "realm1",
			...over,
		});

		function qbRoutes(balance: number) {
			mockFn(qbFetch).mockImplementation(async (_o: string, method: string, path: string) => {
				if (method === "GET" && path === "/invoice/158") return { Invoice: { Id: "158", Balance: balance } };
				if (path === "/payment") return { Payment: { Id: "p-1" } };
				return { CreditMemo: { Id: "cm-1", TxnTaxDetail: { TotalTax: 0.93 } } };
			});
		}

		it("applies the credit to the original with a $0 payment", async () => {
			qbRoutes(176.19);
			sdb.invoice.findFirst
				.mockResolvedValueOnce(creditFixture())
				.mockResolvedValueOnce(original());

			await pushInvoice("cm1", "org1");

			expect(postTo("/payment")).toEqual({
				CustomerRef: { value: "qbc1" },
				TotalAmt: 0,
				PrivateNote: "Applies credit INV-1-A1",
				Line: [
					{ Amount: 17.93, LinkedTxn: [{ TxnId: "158", TxnType: "Invoice" }] },
					{ Amount: 17.93, LinkedTxn: [{ TxnId: "cm-1", TxnType: "CreditMemo" }] },
				],
			});
			expect(sdb.invoice.update).toHaveBeenCalledWith({
				where: { id: "cm1" },
				data: { qb_credit_applied_payment_id: "p-1" },
			});
		});

		it("applies only up to the original's QuickBooks balance", async () => {
			qbRoutes(10);
			sdb.invoice.findFirst
				.mockResolvedValueOnce(creditFixture())
				.mockResolvedValueOnce(original());

			await pushInvoice("cm1", "org1");

			const lines = postTo("/payment")?.Line;
			expect(lines.map((l: { Amount: number }) => l.Amount)).toEqual([10, 10]);
		});

		it("applies only up to the CreditMemo's remaining credit", async () => {
			mockFn(qbFetch).mockImplementation(async (_o: string, method: string, path: string) => {
				if (method === "GET" && path === "/invoice/158") return { Invoice: { Id: "158", Balance: 176.19 } };
				if (path === "/payment") return { Payment: { Id: "p-1" } };
				return { CreditMemo: { Id: "cm-1", RemainingCredit: 5, TxnTaxDetail: { TotalTax: 0.93 } } };
			});
			sdb.invoice.findFirst
				.mockResolvedValueOnce(creditFixture())
				.mockResolvedValueOnce(original());

			await pushInvoice("cm1", "org1");

			const lines = postTo("/payment")?.Line;
			expect(lines.map((l: { Amount: number }) => l.Amount)).toEqual([5, 5]);
		});

		it("leaves the credit as customer credit when the original is fully paid", async () => {
			qbRoutes(0);
			sdb.invoice.findFirst
				.mockResolvedValueOnce(creditFixture())
				.mockResolvedValueOnce(original());

			await pushInvoice("cm1", "org1");

			expect(postTo("/payment")).toBeUndefined();
		});

		it("pushes the original first when it is not in QuickBooks", async () => {
			qbRoutes(176.19);
			mockFn(pushInvoice).mockImplementationOnce(actualPush);
			mockFn(pushInvoice).mockResolvedValueOnce(undefined);
			sdb.invoice.findFirst
				.mockResolvedValueOnce(creditFixture())
				.mockResolvedValueOnce(original({ qb_invoice_id: null }))
				.mockResolvedValueOnce(original());

			await pushInvoice("cm1", "org1");

			expect(pushInvoice).toHaveBeenCalledWith("o1", "org1");
			const pushOrder = mockFn(pushInvoice).mock.invocationCallOrder[1];
			const payOrder = mockFn(qbFetch).mock.invocationCallOrder[
				mockFn(qbFetch).mock.calls.findIndex((c) => c[2] === "/payment")
			];
			expect(pushOrder).toBeLessThan(payOrder);
			expect(postTo("/payment")).toBeDefined();
		});

		it("leaves the credit unapplied when the original cannot be pushed", async () => {
			qbRoutes(176.19);
			mockFn(pushInvoice).mockImplementationOnce(actualPush);
			mockFn(pushInvoice).mockRejectedValueOnce(new Error("qb down"));
			sdb.invoice.findFirst
				.mockResolvedValueOnce(creditFixture())
				.mockResolvedValueOnce(original({ qb_invoice_id: null }));

			await expect(pushInvoice("cm1", "org1")).resolves.toBeDefined();

			expect(postTo("/payment")).toBeUndefined();
			expect(sdb.invoice.update).toHaveBeenCalledWith(
				expect.objectContaining({ data: expect.objectContaining({ qb_sync_status: "synced" }) }),
			);
			expect(log.warn).toHaveBeenCalled();
		});

		it("does not fail the push when the payment POST fails", async () => {
			mockFn(qbFetch).mockImplementation(async (_o: string, method: string, path: string) => {
				if (method === "GET" && path === "/invoice/158") return { Invoice: { Id: "158", Balance: 50 } };
				if (path === "/payment") throw new Error("boom");
				return { CreditMemo: { Id: "cm-1", TxnTaxDetail: { TotalTax: 0.93 } } };
			});
			sdb.invoice.findFirst
				.mockResolvedValueOnce(creditFixture())
				.mockResolvedValueOnce(original());

			await expect(pushInvoice("cm1", "org1")).resolves.toBeDefined();

			expect(log.error).toHaveBeenCalled();
		});

		it("does not apply twice on re-push", async () => {
			mockFn(qbFetch).mockImplementation(async (_o: string, method: string, path: string) => {
				if (path === "/invoice/158") return { Invoice: { Id: "158", Balance: 176.19 } };
				if (path === "/payment") return { Payment: { Id: "p-2" } };
				return method === "GET"
					? { CreditMemo: { Id: "cm-1", SyncToken: "3" } }
					: { CreditMemo: { Id: "cm-1", TxnTaxDetail: { TotalTax: 0.93 } } };
			});
			// Routed by id, not queued, so an unread original cannot leak into the next test.
			sdb.invoice.findFirst.mockImplementationOnce(async () =>
				creditFixture({
					qb_credit_memo_id: "cm-1",
					account_id: "realm1",
					qb_credit_applied_payment_id: "p-1",
				}),
			);
			sdb.invoice.findFirst.mockImplementation(async (args: any) =>
				args?.where?.id === "o1" ? original() : undefined,
			);

			await pushInvoice("cm1", "org1");
			sdb.invoice.findFirst.mockReset();

			expect(postTo("/creditmemo")).toBeDefined();
			expect(postTo("/payment")).toBeUndefined();
		});
	});

	it("net-positive adjustment still pushes as an Invoice", async () => {
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-9", TxnTaxDetail: { TotalTax: 1 } } });
		sdb.invoice.findFirst.mockResolvedValueOnce(
			creditFixture({
				total: "25.00",
				tax_amount: "1.00",
				line_items: [
					{
						total: "24.00",
						quantity: "1",
						unit_price: "24.00",
						name: "Part",
						description: null,
						taxable: true,
						tax_group_id: "g1",
						tax_group: { qb_tax_code_id: "5" },
						inventory_item: null,
					},
				],
			}),
		);

		await pushInvoice("cm1", "org1");

		expect(postTo("/invoice")).toBeDefined();
		expect(postTo("/creditmemo")).toBeUndefined();
	});
});

describe("stale taxable stand-in recovery", () => {
	const fault610 = () =>
		new Error(
			`QB POST /x → 400: {"Fault":{"Error":[{"Message":"Object Not Found","code":"610"}],"type":"ValidationFault"}}`,
		);
	const itemRefs = (path: string) =>
		mockFn(qbFetch)
			.mock.calls.filter((c) => c[1] === "POST" && c[2] === path)
			.map((c) => (c[3] as any).Line[0].SalesItemLineDetail.ItemRef.value);

	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: true });
		mockFn(ensureTaxableItem).mockResolvedValue({ id: "T-STALE", name: TAXABLE_ITEM_NAME });
		mockFn(qbQueryAll).mockImplementation(async (_o: string, entity: string) =>
			entity === "Item" ? [{ Id: "T-2", SyncToken: "0", Active: false }] : [],
		);
	});

	function rejectFirst(path: string, ok: unknown) {
		let failed = false;
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string, p: string) => {
			if (method === "POST" && p === path && !failed) {
				failed = true;
				throw fault610();
			}
			return ok;
		});
	}

	it("re-resolves the stand-in and retries a rejected CreditMemo once", async () => {
		rejectFirst("/creditmemo", { CreditMemo: { Id: "cm-1", TxnTaxDetail: { TotalTax: 0.93 } } });
		sdb.invoice.findFirst.mockResolvedValueOnce(creditFixture());

		await pushInvoice("cm1", "org1");

		expect(itemRefs("/creditmemo")).toEqual(["T-STALE", "T-2"]);
		expect(sdb.organization.update).toHaveBeenCalledWith({
			where: { id: "org1" },
			data: { qb_taxable_item_id: "T-2", qb_taxable_item_realm_id: "realm1" },
		});
	});

	it("re-resolves the stand-in and retries a rejected Invoice once", async () => {
		rejectFirst("/invoice", { Invoice: { Id: "qb-9", TxnTaxDetail: { TotalTax: 1 } } });
		sdb.invoice.findFirst.mockResolvedValueOnce(
			creditFixture({ adjusts_invoice_id: null, total: "25.00", tax_amount: "1.00" }),
		);

		const result = await pushInvoice("cm1", "org1");

		expect(itemRefs("/invoice")).toEqual(["T-STALE", "T-2"]);
		expect(result?.fingerprint).toBeTruthy();
		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ qb_invoice_id: "qb-9" }) }),
		);
	});
});
