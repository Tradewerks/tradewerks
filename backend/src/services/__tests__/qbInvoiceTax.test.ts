const { sdb, dbMock } = vi.hoisted(() => ({
	sdb: {
		invoice: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
		tax_group: { findMany: vi.fn(async () => []) },
		client_external_mapping: { upsert: vi.fn(async () => ({})) },
		organization: {
			findUnique: vi.fn(async () => ({
				qb_taxable_item_id: "T-1",
				qb_taxable_item_realm_id: "realm1",
			})),
			update: vi.fn(async () => ({})),
		},
	},
	dbMock: {
		organization: { findUnique: vi.fn(async () => ({ qb_passthrough_tax_code_id: null })) },
		invoice: { findFirst: vi.fn() },
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
const { taxModeMock } = vi.hoisted(() => ({ taxModeMock: vi.fn(async () => "manual") }));
vi.mock("../tax/taxMode.js", () => ({ getEffectiveTaxMode: taxModeMock }));

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	toQBShipAddr,
	qbLineTaxCode,
	pickTxnTaxCode,
	classifyTaxReadback,
	qbPushFingerprint,
	qbTaxDeltaReason,
	buildInvoicePayload,
} from "../qb/qbInvoiceTax.js";

describe("buildInvoicePayload item refs", () => {
	const line = (over: Record<string, unknown>) => ({
		total: "10.00",
		quantity: "1",
		unit_price: "10.00",
		name: "x",
		taxable: true,
		tax_group_id: null,
		tax_amount: "1.00",
		inventory_item: null,
		...over,
	});

	it("routes mapped, taxable and non-taxable lines", () => {
		const inv = {
			tax_snapshot: null,
			discount_amount: null,
			client: { is_tax_exempt: false, address: null, coords: null },
			jobs: [],
			line_items: [
				line({ inventory_item: { name: "Filter", external_mappings: [{ external_id: "55" }] } }),
				line({}),
				line({ taxable: false, tax_amount: "0" }),
			],
		};
		const taxableItem = { id: "88", name: "Taxable service (TradeWerks)" };

		const refs = buildInvoicePayload(inv, taxableItem).lines.map(
			(l) => l.SalesItemLineDetail.ItemRef,
		);

		expect(refs).toEqual([
			{ value: "55", name: "Filter" },
			{ value: "88", name: "Taxable service (TradeWerks)" },
			{ value: "1", name: "Services" },
		]);
		const bare = buildInvoicePayload(inv, null).lines.map(
			(l) => l.SalesItemLineDetail.ItemRef.value,
		);
		expect(bare).toEqual(["55", "1", "1"]);
	});
});

describe("toQBShipAddr", () => {
	it("omits Lat/Long when coords are null", () => {
		const addr = toQBShipAddr("2842 Main St, La Crosse, WI 54601", { lat: null, lon: null });
		expect(addr).not.toHaveProperty("Lat");
		expect(addr).not.toHaveProperty("Long");
	});

	it("splits a seed-style address", () => {
		expect(toQBShipAddr("2842 Main St, La Crosse, WI 54601", { lat: 43.8, lon: -91.2 })).toEqual({
			Line1: "2842 Main St",
			City: "La Crosse",
			CountrySubDivisionCode: "WI",
			PostalCode: "54601",
			Country: "USA",
			Lat: "43.8",
			Long: "-91.2",
		});
	});

	// Mapbox place_name format
	it("handles a full state name and a country suffix", () => {
		expect(
			toQBShipAddr("2842 Main St, La Crosse, Wisconsin 54601, United States", null),
		).toEqual({
			Line1: "2842 Main St",
			City: "La Crosse",
			CountrySubDivisionCode: "WI",
			PostalCode: "54601",
			Country: "USA",
		});
	});

	it("keeps a multi-part street and a ZIP+4", () => {
		expect(toQBShipAddr("Suite 4, 10 Elm Rd, Madison, WI 53703-1234", null)).toMatchObject({
			Line1: "Suite 4, 10 Elm Rd",
			City: "Madison",
			PostalCode: "53703-1234",
		});
	});

	it("falls back to Line1 plus coords when the address does not parse", () => {
		expect(toQBShipAddr("Lot 4 behind the feed mill", { lat: 44, lon: -90 })).toEqual({
			Line1: "Lot 4 behind the feed mill",
			Lat: "44",
			Long: "-90",
		});
	});

	it("omits out-of-range coords rather than sending them", () => {
		expect(toQBShipAddr("Lot 4 behind the feed mill", { lat: 95, lng: -90 })).toEqual({
			Line1: "Lot 4 behind the feed mill",
		});
	});

	it("omits ShipAddr for an empty address", () => {
		expect(toQBShipAddr("", null)).toBeUndefined();
		expect(toQBShipAddr(null, null)).toBeUndefined();
	});

	it("ignores an unknown state token", () => {
		expect(toQBShipAddr("1 A St, Townsville, Narnia 12345", null)).toEqual({
			Line1: "1 A St, Townsville, Narnia 12345",
		});
	});
});

describe("qbLineTaxCode", () => {
	it("maps taxable lines to TAX and non-taxable to NON", () => {
		expect(qbLineTaxCode(true, true, false)).toBe("TAX");
		expect(qbLineTaxCode(null, true, false)).toBe("TAX");
		expect(qbLineTaxCode(false, true, false)).toBe("NON");
	});

	it("sends NON for a taxable line that has no tax group", () => {
		expect(qbLineTaxCode(true, false, false)).toBe("NON");
		expect(qbLineTaxCode(null, false, false)).toBe("NON");
	});

	it("sends NON for every line of a tax-exempt client", () => {
		expect(qbLineTaxCode(true, true, true)).toBe("NON");
	});
});

describe("pickTxnTaxCode", () => {
	it("uses the one code all taxed groups share", () => {
		expect(pickTxnTaxCode(["7", "7"], "99")).toBe("7");
	});

	it("uses the pass-through code when groups disagree", () => {
		expect(pickTxnTaxCode(["7", "8"], "99")).toBe("99");
	});

	it("uses the pass-through code when any taxed group is unlinked", () => {
		expect(pickTxnTaxCode(["7", null], "99")).toBe("99");
	});

	it("treats an empty-string code as unlinked", () => {
		expect(pickTxnTaxCode(["", ""], "99")).toBe("99");
	});

	it("returns null when nothing is linked and no pass-through is set", () => {
		expect(pickTxnTaxCode([null], null)).toBeNull();
		expect(pickTxnTaxCode([], null)).toBeNull();
	});

	it("uses the pass-through code when no group carried tax", () => {
		expect(pickTxnTaxCode([], "99")).toBe("99");
	});
});

describe("classifyTaxReadback", () => {
	it("treats a difference of one cent as a match", () => {
		expect(classifyTaxReadback(5.5, 5.51)).toEqual({ qbTaxAmount: 5.51, mismatch: false });
	});

	it("flags a difference above one cent", () => {
		expect(classifyTaxReadback(5.5, "6.10")).toEqual({ qbTaxAmount: 6.1, mismatch: true });
	});

	it("reads a missing TotalTax as zero", () => {
		expect(classifyTaxReadback(0, undefined)).toEqual({ qbTaxAmount: 0, mismatch: false });
		expect(classifyTaxReadback(2, undefined)).toEqual({ qbTaxAmount: 0, mismatch: true });
	});

	it("flags an unreadable TotalTax as a mismatch", () => {
		expect(classifyTaxReadback(0, "abc")).toEqual({ qbTaxAmount: 0, mismatch: true });
	});
});

import { qbFetch } from "../quickbooksService.js";
import { getQBTaxPrefs } from "../qb/qbTax.js";
import { log } from "../appLogger.js";
import { pushInvoice, sendInvoiceEmail } from "../qb/qbInvoices.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

function invoiceFixture(over: Record<string, unknown> = {}) {
	return {
		id: "inv1",
		invoice_number: "INV-1",
		status: "Sent",
		tax_amount: "5.50",
		discount_amount: null,
		due_date: null,
		memo: null,
		qb_invoice_id: null,
		account_id: "",
		client_id: "c1",
		tax_snapshot: { client_exempt: false, groups: [{ id: "g1", tax_amount_cents: 550 }] },
		line_items: [
			{
				total: "100.00",
				quantity: "1",
				unit_price: "100.00",
				name: "Furnace repair",
				description: null,
				taxable: true,
				tax_group_id: "g1",
				tax_group: { qb_tax_code_id: "7" },
				inventory_item: null,
			},
		],
		client: {
			name: "Ada",
			is_tax_exempt: false,
			address: "1 Client Way, Onalaska, WI 54650",
			coords: null,
			contacts: [],
			client_external_mapping: [{ external_id: "qbc1" }],
		},
		jobs: [
			{ job: { address: "2842 Main St, La Crosse, WI 54601", coords: { lat: 43.8, lon: -91.2 } } },
		],
		...over,
	};
}

function lastInvoicePostBody() {
	const call = mockFn(qbFetch).mock.calls.find((c) => c[1] === "POST" && c[2] === "/invoice");
	return call?.[3] as Record<string, any>;
}

describe("pushInvoice tax handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 5.5 } } });
		mockFn(sdb.tax_group.findMany).mockResolvedValue([{ id: "g1", qb_tax_code_id: "7" }]);
	});

	it("non-AST: sends TAX lines, a TxnTaxDetail override and the job ShipAddr", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		await pushInvoice("inv1", "org1");

		const body = lastInvoicePostBody();
		expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "TAX" });
		expect(body.TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: "7" }, TotalTax: 5.5 });
		expect(body.ShipAddr).toMatchObject({ Line1: "2842 Main St", CountrySubDivisionCode: "WI" });
		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ qb_sync_status: "synced", qb_tax_amount: 5.5 }),
			}),
		);
	});

	it("AST: sends no TxnTaxDetail but still sends ShipAddr", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValueOnce({ automatedSalesTax: true });
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		await pushInvoice("inv1", "org1");

		const body = lastInvoicePostBody();
		expect(body.TxnTaxDetail).toBeUndefined();
		expect(body.ShipAddr).toBeDefined();
	});

	// Sandbox, 2026-10-20: $480 with a $120 discount taxed $26.40 by default, $19.80 with the flag.
	it("asks QuickBooks to tax the discounted amount, as our engine does", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValueOnce({ automatedSalesTax: true });
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().ApplyTaxAfterDiscount).toBe(true);
	});

	it("marks tax_mismatch when QuickBooks computes a different tax", async () => {
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 6.1 } } });
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		await pushInvoice("inv1", "org1");

		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ qb_sync_status: "tax_mismatch", qb_tax_amount: 6.1 }),
			}),
		);
	});

	it("sends NON on every line for a tax-exempt client", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_amount: "0",
				tax_snapshot: { client_exempt: true, groups: [] },
				client: { ...invoiceFixture().client, is_tax_exempt: true },
			}),
		);
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 0 } } });

		await pushInvoice("inv1", "org1");

		const body = lastInvoicePostBody();
		expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
		expect(body.TxnTaxDetail).toBeUndefined();
	});

	it("sends NON lines and no warning for a zero-tax invoice with no code", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_amount: "0",
				tax_snapshot: { client_exempt: false, groups: [{ id: "g1", tax_amount_cents: 0 }] },
			}),
		);
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 0 } } });

		await pushInvoice("inv1", "org1");

		const body = lastInvoicePostBody();
		expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
		expect(body.TxnTaxDetail).toBeUndefined();
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("returns the read-back, fingerprinted before the zero-tax NON rewrite", async () => {
		const inv = invoiceFixture({
			tax_amount: "0",
			tax_snapshot: { client_exempt: false, groups: [{ id: "g1", tax_amount_cents: 0 }] },
		});
		sdb.invoice.findFirst.mockResolvedValueOnce(inv);
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 0 } } });
		const { lines, shipAddr, clientExempt } = buildInvoicePayload(inv, null);

		const r = await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
		expect(r).toEqual({
			qbTaxCents: 0,
			fingerprint: qbPushFingerprint(lines, shipAddr, clientExempt),
			automatedSalesTax: false,
			mismatch: false,
		});
	});

	it("AST: returns QuickBooks' tax in cents and the mismatch flag", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValueOnce({ automatedSalesTax: true });
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 6.1 } } });
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		const r = await pushInvoice("inv1", "org1");

		expect(r).toMatchObject({ qbTaxCents: 610, automatedSalesTax: true, mismatch: true });
	});

	it("reports a missing TotalTax as null cents, leaving the DB write as before", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValueOnce({ automatedSalesTax: true });
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1" } });
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		const r = await pushInvoice("inv1", "org1");

		expect(r?.qbTaxCents).toBeNull();
		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ qb_sync_status: "tax_mismatch", qb_tax_amount: 0 }),
			}),
		);
	});

	it("reports an unreadable TotalTax as null cents", async () => {
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: "abc" } } });
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		expect((await pushInvoice("inv1", "org1"))?.qbTaxCents).toBeNull();
	});

	it("sends NON for a taxable line with no tax group", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				line_items: [{ ...invoiceFixture().line_items[0], tax_group_id: null, tax_group: null }],
			}),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
	});

	it("trusts the locked snapshot over a client flag set after the invoice was taxed", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({ client: { ...invoiceFixture().client, is_tax_exempt: true } }),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "TAX" });
	});

	it("falls back to the live client flag when there is no snapshot", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_snapshot: null,
				tax_amount: "0",
				client: { ...invoiceFixture().client, is_tax_exempt: true },
			}),
		);
		mockFn(qbFetch).mockResolvedValue({ Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 0 } } });

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
	});

	it("update branch: sparse POST carries Id, SyncToken and the tax fields", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string) =>
			method === "GET"
				? { Invoice: { SyncToken: "3" } }
				: { Invoice: { Id: "qb-9", TxnTaxDetail: { TotalTax: 5.5 } } },
		);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({ qb_invoice_id: "qb-9", account_id: "realm1" }),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody()).toMatchObject({
			sparse: true,
			Id: "qb-9",
			SyncToken: "3",
			TxnTaxDetail: { TxnTaxCodeRef: { value: "7" }, TotalTax: 5.5 },
			ShipAddr: { Line1: "2842 Main St" },
		});
		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ qb_invoice_id: "qb-9", qb_sync_status: "synced" }),
			}),
		);
	});

	// QuickBooks rejects (400, code 6000) a sparse update that turns every
	// line NON while the invoice still carries an earlier TxnTaxCodeRef + TotalTax override.
	it("update branch: zeroes the override QuickBooks still holds when tax drops to zero", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string) =>
			method === "GET"
				? { Invoice: { SyncToken: "4", TxnTaxDetail: { TxnTaxCodeRef: { value: "2" }, TotalTax: 39.6 } } }
				: { Invoice: { Id: "qb-9", TxnTaxDetail: { TotalTax: 0 } } },
		);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				qb_invoice_id: "qb-9",
				account_id: "realm1",
				tax_amount: "0",
				tax_snapshot: { client_exempt: false, groups: [{ id: "g1", tax_amount_cents: 0 }] },
			}),
		);

		await pushInvoice("inv1", "org1");

		const body = lastInvoicePostBody();
		expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
		expect(body.TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: "2" }, TotalTax: 0 });
		expect(sdb.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ qb_sync_status: "synced" }) }),
		);
	});

	it("update branch: restates the held code without TotalTax when tax remains but no code is linked", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string) =>
			method === "GET"
				? { Invoice: { SyncToken: "4", TxnTaxDetail: { TxnTaxCodeRef: { value: "2" }, TotalTax: 39.6 } } }
				: { Invoice: { Id: "qb-9", TxnTaxDetail: { TotalTax: 5.5 } } },
		);
		mockFn(sdb.tax_group.findMany).mockResolvedValueOnce([{ id: "g1", qb_tax_code_id: null }]);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({ qb_invoice_id: "qb-9", account_id: "realm1" }),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail).toEqual({ TxnTaxCodeRef: { value: "2" } });
	});

	it("update branch: sends no override when QuickBooks holds none and tax is zero", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string) =>
			method === "GET"
				? { Invoice: { SyncToken: "4", TxnTaxDetail: { TotalTax: 0 } } }
				: { Invoice: { Id: "qb-9", TxnTaxDetail: { TotalTax: 0 } } },
		);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				qb_invoice_id: "qb-9",
				account_id: "realm1",
				tax_amount: "0",
				tax_snapshot: { client_exempt: false, groups: [] },
			}),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail).toBeUndefined();
	});

	it("update branch (AST): never sends a zeroing override", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValueOnce({ automatedSalesTax: true });
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string) =>
			method === "GET"
				? { Invoice: { SyncToken: "4", TxnTaxDetail: { TxnTaxCodeRef: { value: "2" }, TotalTax: 3 } } }
				: { Invoice: { Id: "qb-9", TxnTaxDetail: { TotalTax: 0 } } },
		);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				qb_invoice_id: "qb-9",
				account_id: "realm1",
				tax_amount: "0",
				tax_snapshot: { client_exempt: false, groups: [] },
			}),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail).toBeUndefined();
	});

	it("uses the org pass-through code when taxed groups disagree", async () => {
		dbMock.organization.findUnique.mockResolvedValueOnce({ qb_passthrough_tax_code_id: "99" });
		mockFn(sdb.tax_group.findMany).mockResolvedValueOnce([
			{ id: "g1", qb_tax_code_id: "7" },
			{ id: "g2", qb_tax_code_id: "8" },
		]);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_snapshot: {
					client_exempt: false,
					groups: [
						{ id: "g1", tax_amount_cents: 300 },
						{ id: "g2", tax_amount_cents: 250 },
					],
				},
			}),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail.TxnTaxCodeRef).toEqual({ value: "99" });
	});

	it("omits TxnTaxDetail and warns when no code is available, without failing", async () => {
		mockFn(sdb.tax_group.findMany).mockResolvedValueOnce([{ id: "g1", qb_tax_code_id: null }]);
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		await expect(pushInvoice("inv1", "org1")).resolves.toBeDefined();

		expect(lastInvoicePostBody().TxnTaxDetail).toBeUndefined();
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ invoiceId: "inv1" }),
			expect.stringContaining("no QuickBooks tax code"),
		);
	});

	it("falls back to the lines' tax groups when the invoice has no snapshot", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture({ tax_snapshot: null }));

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail.TxnTaxCodeRef).toEqual({ value: "7" });
	});

	it("falls back to the client address when no job is linked", async () => {
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture({ jobs: [] }));

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().ShipAddr).toMatchObject({ City: "Onalaska" });
	});

	// Push decides from the invoice's own snapshot, never from the org's current mode.
	it("a resolved-rate snapshot group gets the pass-through code", async () => {
		dbMock.organization.findUnique.mockResolvedValueOnce({ qb_passthrough_tax_code_id: "99" });
		mockFn(sdb.tax_group.findMany).mockResolvedValueOnce([]);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_snapshot: { client_exempt: false, groups: [{ id: "set-1", tax_amount_cents: 550 }] },
			}),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail).toEqual({
			TxnTaxCodeRef: { value: "99" },
			TotalTax: 5.5,
		});
	});

	it("a resolved-rate line with no tax group still goes as TAX", async () => {
		dbMock.organization.findUnique.mockResolvedValueOnce({ qb_passthrough_tax_code_id: "99" });
		mockFn(sdb.tax_group.findMany).mockResolvedValueOnce([]);
		const base = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_snapshot: { client_exempt: false, groups: [{ id: "set-1", tax_amount_cents: 550 }] },
				line_items: [
					{ ...base.line_items[0], tax_group_id: null, tax_group: null, tax_amount: "5.50" },
				],
			}),
		);

		await pushInvoice("inv1", "org1");

		const body = lastInvoicePostBody();
		expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "TAX" });
		expect(body.TxnTaxDetail.TxnTaxCodeRef).toEqual({ value: "99" });
	});

	// The mode mock stays so a regression back to a push-time mode branch fails here.
	it("an invoice taxed under a linked group keeps its code after the org switches to auto", async () => {
		taxModeMock.mockResolvedValue("auto");
		dbMock.organization.findUnique.mockResolvedValueOnce({ qb_passthrough_tax_code_id: "99" });
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture());

		try {
			await pushInvoice("inv1", "org1");
		} finally {
			taxModeMock.mockResolvedValue("manual");
		}

		expect(lastInvoicePostBody().TxnTaxDetail).toEqual({
			TxnTaxCodeRef: { value: "7" },
			TotalTax: 5.5,
		});
	});

	it("a mixed snapshot (linked group + resolved rate) gets the pass-through code", async () => {
		dbMock.organization.findUnique.mockResolvedValueOnce({ qb_passthrough_tax_code_id: "99" });
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_snapshot: {
					client_exempt: false,
					groups: [
						{ id: "g1", tax_amount_cents: 300 },
						{ id: "set-1", tax_amount_cents: 250 },
					],
				},
			}),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail.TxnTaxCodeRef).toEqual({ value: "99" });
	});

	it("a legacy-rate snapshot group gets the pass-through code", async () => {
		dbMock.organization.findUnique.mockResolvedValueOnce({ qb_passthrough_tax_code_id: "99" });
		mockFn(sdb.tax_group.findMany).mockResolvedValueOnce([]);
		sdb.invoice.findFirst.mockResolvedValueOnce(
			invoiceFixture({
				tax_snapshot: { client_exempt: false, groups: [{ id: "legacy", tax_amount_cents: 550 }] },
			}),
		);

		await pushInvoice("inv1", "org1");

		expect(lastInvoicePostBody().TxnTaxDetail.TxnTaxCodeRef).toEqual({ value: "99" });
	});

	it("a non-taxable line goes as NON beside a taxable one", async () => {
		const furnace = {
			...invoiceFixture().line_items[0],
			tax_group_id: null,
			tax_group: null,
			tax_amount: "5.50",
		};
		const duct = {
			...invoiceFixture().line_items[0],
			name: "Duct repair",
			tax_group_id: null,
			tax_group: null,
			taxable: false,
			tax_amount: "0.00",
		};
		sdb.invoice.findFirst.mockResolvedValueOnce(invoiceFixture({ line_items: [furnace, duct] }));

		await pushInvoice("inv1", "org1");

		const body = lastInvoicePostBody();
		expect(body.Line[0].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "TAX" });
		expect(body.Line[1].SalesItemLineDetail.TaxCodeRef).toEqual({ value: "NON" });
	});
});

describe("sendInvoiceEmail", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses an invoice whose QuickBooks tax differs from ours", async () => {
		mockFn(dbMock.invoice.findFirst).mockResolvedValueOnce({
			qb_invoice_id: "qb-1",
			qb_sync_status: "tax_mismatch",
		});

		await expect(sendInvoiceEmail("inv1", "org1", "a@b.co")).rejects.toMatchObject({
			statusCode: 422,
			message: expect.stringContaining("different tax"),
		});
		expect(qbFetch).not.toHaveBeenCalled();
	});

	// Emailing from QuickBooks is not a finalize: a draft would reach the customer without the
	// tax-block and QuickBooks tax gates, and without being locked.
	it("refuses a Draft invoice", async () => {
		mockFn(dbMock.invoice.findFirst).mockResolvedValueOnce({
			status: "Draft",
			qb_invoice_id: "qb-1",
			qb_sync_status: "synced",
		});

		await expect(sendInvoiceEmail("inv1", "org1", "a@b.co")).rejects.toMatchObject({
			statusCode: 422,
			message: "Create or send this invoice before sending it from QuickBooks.",
		});
		expect(qbFetch).not.toHaveBeenCalled();
	});
});

describe("qbPushFingerprint", () => {
	const sales = (over: Record<string, unknown> = {}, code = "TAX") => ({
		Amount: 100,
		DetailType: "SalesItemLineDetail",
		Description: "Labor",
		SalesItemLineDetail: {
			Qty: 2,
			UnitPrice: 50,
			ItemRef: { value: "1", name: "Services" },
			TaxCodeRef: { value: code },
			...over,
		},
	});
	const addr = {
		Line1: "1 Main St",
		City: "Austin",
		CountrySubDivisionCode: "TX",
		PostalCode: "78701",
		Country: "USA",
		Lat: "30.1",
		Long: "-97.7",
	};
	const base = () => qbPushFingerprint([sales()], addr, false);

	it("is a sha256 hex digest", () => {
		expect(base()).toMatch(/^[0-9a-f]{64}$/);
	});

	it("is stable under object key order", () => {
		const reordered = {
			SalesItemLineDetail: {
				TaxCodeRef: { value: "TAX" },
				ItemRef: { name: "Services", value: "1" },
				UnitPrice: 50,
				Qty: 2,
			},
			Description: "Labor",
			DetailType: "SalesItemLineDetail",
			Amount: 100,
		};
		const addr2 = {
			Long: "-97.7",
			Lat: "30.1",
			Country: "USA",
			PostalCode: "78701",
			CountrySubDivisionCode: "TX",
			City: "Austin",
			Line1: "1 Main St",
		};
		expect(qbPushFingerprint([reordered], addr2, false)).toBe(base());
	});

	it("changes on qty, unit price, TAX to NON, address and exemption", () => {
		expect(qbPushFingerprint([sales({ Qty: 3 })], addr, false)).not.toBe(base());
		expect(qbPushFingerprint([sales({ UnitPrice: 51 })], addr, false)).not.toBe(base());
		expect(qbPushFingerprint([sales({}, "NON")], addr, false)).not.toBe(base());
		expect(qbPushFingerprint([sales()], { ...addr, PostalCode: "78702" }, false)).not.toBe(base());
		expect(qbPushFingerprint([sales()], undefined, false)).not.toBe(base());
		expect(qbPushFingerprint([sales()], addr, true)).not.toBe(base());
	});

	it("changes on the discount amount", () => {
		const disc = (a: number) => ({ DetailType: "DiscountLineDetail", Amount: a });
		expect(qbPushFingerprint([sales(), disc(5)], addr, false)).not.toBe(
			qbPushFingerprint([sales(), disc(6)], addr, false),
		);
	});

	it("ignores non-tax-relevant fields", () => {
		const other = { ...sales(), Description: "Something else" };
		expect(qbPushFingerprint([other], { ...addr, Country: "US" }, false)).toBe(base());
	});
});

describe("qbTaxDeltaReason", () => {
	it("is null within a cent", () => {
		expect(qbTaxDeltaReason(1000, 1000, false)).toBeNull();
		expect(qbTaxDeltaReason(1001, 1000, false)).toBeNull();
		expect(qbTaxDeltaReason(999, 1000, true)).toBeNull();
	});

	it("explains a delta of two cents", () => {
		expect(qbTaxDeltaReason(1002, 1000, false)).toBe(
			"QuickBooks calculated $10.02 (you estimated $10.00)",
		);
	});

	it("appends the one-rate note for mixed groups", () => {
		expect(qbTaxDeltaReason(1200, 1000, true)).toBe(
			"QuickBooks calculated $12.00 (you estimated $10.00); QuickBooks applies one rate — line tax groups were not used",
		);
	});

	it("formats thousands separators and negatives", () => {
		expect(qbTaxDeltaReason(123456, 100000, false)).toBe(
			"QuickBooks calculated $1,234.56 (you estimated $1,000.00)",
		);
		expect(qbTaxDeltaReason(-5000, -1000, false)).toBe(
			"QuickBooks calculated -$50.00 (you estimated -$10.00)",
		);
	});
});
