const { fakeDb, astMock } = vi.hoisted(() => {
	const astMock = vi.fn(async () => ({ automatedSalesTax: true }));
	const fakeDb: any = {
		organization: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
		invoice: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
		tax_group: { findMany: vi.fn(async () => []) },
		client_external_mapping: { upsert: vi.fn(async () => ({})) },
	};
	return { fakeDb, astMock };
});

vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));
vi.mock("../context.js", () => ({ getScopedDb: vi.fn(() => fakeDb) }));
vi.mock("../../db.js", () => ({ db: fakeDb }));
vi.mock("../../services/quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm-now"),
	isQBConnected: vi.fn(async () => true),
}));
vi.mock("../../services/qb/qbCustomers.js", () => ({ findOrCreateQBCustomer: vi.fn() }));
vi.mock("../../services/qb/qbItems.js", () => ({
	findOrCreateQBItem: vi.fn(async () => "T-9"),
	QB_ITEM_NAME_MAX: 100,
}));
vi.mock("../../services/qb/qbQuery.js", () => ({ qbQueryAll: vi.fn(async () => []) }));
vi.mock("../../services/qb/qbTax.js", () => ({
	getQBTaxPrefs: astMock,
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "../../../generated/prisma/client.js";
import { qbFetch } from "../../services/quickbooksService.js";
import { pushInvoice } from "../../services/qb/qbInvoices.js";
import { findOrCreateQBItem } from "../../services/qb/qbItems.js";
import { currentQbFingerprint } from "../recomputeDocumentTotals.js";
import type { TaxSnapshotV2 } from "../../services/tax/snapshot.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const snapshot = {
	version: 2,
	source: "manual",
	rounding: "jurisdiction_half_up",
	locked_at: "draft",
	client_exempt: false,
	groups: [{ id: "g1", tax_amount_cents: 1045, rates: [] }],
	total_tax_cents: 1045,
	subtotal_cents: 20000,
	discount_cents: 1000,
	total_cents: 20045,
} as unknown as TaxSnapshotV2;

// Stored as the database holds it: mappings for every realm the org was ever connected to, and
// lines out of sort order. The fake applies the include's realm filter and orderBy like Prisma.
const row = {
	id: "inv1",
	organization_id: "org1",
	invoice_number: "INV-1",
	status: "Draft",
	tax_amount: "10.45",
	discount_amount: "10.00",
	due_date: null,
	memo: null,
	qb_invoice_id: null,
	account_id: "",
	client_id: "c1",
	tax_snapshot: snapshot,
	line_items: [
		{
			id: "li2",
			sort_order: 1,
			total: "100.00",
			quantity: "1",
			unit_price: "100.00",
			name: "Labor",
			description: null,
			taxable: true,
			tax_group_id: "g1",
			tax_amount: "5.50",
			tax_group: { qb_tax_code_id: null },
			inventory_item: null,
		},
		{
			id: "li1",
			sort_order: 0,
			total: "100.00",
			quantity: "2",
			unit_price: "50.00",
			name: "Capacitor",
			description: "45/5 MFD",
			taxable: true,
			tax_group_id: "g1",
			tax_amount: "4.95",
			tax_group: { qb_tax_code_id: null },
			inventory_item: {
				id: "item1",
				external_mappings: [
					{ provider: "quickbooks", account_id: "realm-old", external_id: "QB-OLD" },
					{ provider: "quickbooks", account_id: "realm-now", external_id: "QB-77" },
				],
			},
		},
	],
	client: {
		name: "Ada",
		is_tax_exempt: false,
		address: "1 Client Way, Onalaska, WI 54650",
		coords: null,
		contacts: [],
		client_external_mapping: [
			{ provider: "quickbooks", account_id: "realm-now", external_id: "qbc1" },
		],
	},
	jobs: [{ job: { address: "2842 Main St, La Crosse, WI 54601", coords: null } }],
};

function findFirstLikePrisma(args: { include?: any }) {
	const realm = args.include?.line_items?.include?.inventory_item?.include?.external_mappings?.where
		?.account_id;
	const lines = [...row.line_items]
		.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
		.map((l) => ({
			...l,
			inventory_item: l.inventory_item && {
				...l.inventory_item,
				external_mappings: l.inventory_item.external_mappings
					.filter((m) => m.account_id === realm)
					.slice(0, 1),
			},
		}));
	const clientRealm = args.include?.client?.include?.client_external_mapping?.where?.account_id;
	return {
		...row,
		line_items: lines,
		client: {
			...row.client,
			client_external_mapping: row.client.client_external_mapping.filter(
				(m) => m.account_id === clientRealm,
			),
		},
	};
}

describe("QuickBooks push fingerprint seam, hand-typed taxable line", () => {
	const orgRow = (taxableItemId: string | null, taxableRealm: string | null) => ({
		qb_realm_id: "realm-now",
		qb_taxable_item_id: taxableItemId,
		qb_taxable_item_realm_id: taxableRealm,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		fakeDb.invoice.findFirst.mockImplementation(async (args: { include?: any }) =>
			findFirstLikePrisma(args),
		);
		fakeDb.organization.findUnique.mockResolvedValue(orgRow(null, null));
		fakeDb.organization.update.mockImplementation(async ({ data }: any) => {
			fakeDb.organization.findUnique.mockResolvedValue(
				orgRow(data.qb_taxable_item_id, data.qb_taxable_item_realm_id),
			);
			return {};
		});
		mockFn(qbFetch).mockResolvedValue({
			Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 10.45 } },
		});
	});

	// QuickBooks has no draft state, so only the finalize confirm may push one.
	it("does not push a draft outside the finalize confirm", async () => {
		astMock.mockResolvedValue({ automatedSalesTax: true });

		expect(await pushInvoice("inv1", "org1")).toBeUndefined();
		expect(mockFn(qbFetch).mock.calls.filter((c) => c[1] === "POST")).toHaveLength(0);
	});

	const recompute = () =>
		currentQbFingerprint(
			fakeDb as unknown as Prisma.TransactionClient,
			"inv1",
			"org1",
			snapshot,
			10,
		);
	const postedRefs = () =>
		mockFn(qbFetch)
			.mock.calls.find((c) => c[1] === "POST")![3]
			.Line.map((l: any) => l.SalesItemLineDetail?.ItemRef?.value ?? l.DetailType);

	it("AST, stand-in already stored: push and recompute hash identically", async () => {
		astMock.mockResolvedValue({ automatedSalesTax: true });
		fakeDb.organization.findUnique.mockResolvedValue(orgRow("T-5", "realm-now"));
		const pushed = await pushInvoice("inv1", "org1", { finalizing: true });

		expect(postedRefs()).toEqual(["QB-77", "T-5", "DiscountLineDetail"]);
		expect(findOrCreateQBItem).not.toHaveBeenCalled();
		expect(await recompute()).toBe(pushed!.fingerprint);
	});

	it("AST, first push creates the stand-in; the recompute after it hashes identically", async () => {
		astMock.mockResolvedValue({ automatedSalesTax: true });
		const pushed = await pushInvoice("inv1", "org1", { finalizing: true });

		expect(postedRefs()).toEqual(["QB-77", "T-9", "DiscountLineDetail"]);
		expect(fakeDb.organization.update).toHaveBeenCalledWith({
			where: { id: "org1" },
			data: { qb_taxable_item_id: "T-9", qb_taxable_item_realm_id: "realm-now" },
		});
		expect(await recompute()).toBe(pushed!.fingerprint);
	});

	it("AST, stand-in stored for another company: a new one is created and sent", async () => {
		astMock.mockResolvedValue({ automatedSalesTax: true });
		fakeDb.organization.findUnique.mockResolvedValue(orgRow("T-OLD", "realm-old"));
		const pushed = await pushInvoice("inv1", "org1", { finalizing: true });

		expect(postedRefs()).toEqual(["QB-77", "T-9", "DiscountLineDetail"]);
		expect(await recompute()).toBe(pushed!.fingerprint);
	});

	it("non-AST: the taxable line stays on Services and no stand-in is loaded or created", async () => {
		astMock.mockResolvedValue({ automatedSalesTax: false });
		fakeDb.organization.findUnique.mockResolvedValue(orgRow("T-5", "realm-now"));
		await pushInvoice("inv1", "org1", { finalizing: true });

		expect(postedRefs()).toEqual(["QB-77", "1", "DiscountLineDetail"]);
		expect(findOrCreateQBItem).not.toHaveBeenCalled();
		expect(fakeDb.organization.update).not.toHaveBeenCalled();
	});
});

describe("QuickBooks push fingerprint seam", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fakeDb.invoice.findFirst.mockImplementation(async (args: { include?: any }) =>
			findFirstLikePrisma(args),
		);
		fakeDb.organization.findUnique.mockResolvedValue({ qb_realm_id: "realm-now" });
		astMock.mockResolvedValue({ automatedSalesTax: false });
		mockFn(qbFetch).mockResolvedValue({
			Invoice: { Id: "qb-1", TxnTaxDetail: { TotalTax: 10.45 } },
		});
	});

	it("doPushInvoice and recompute hash the same invoice identically", async () => {
		const pushed = await pushInvoice("inv1", "org1", { finalizing: true });

		const body = mockFn(qbFetch).mock.calls.find((c) => c[1] === "POST")![3];
		// The case under test: the mapped item in the current realm, in document order, plus discount.
		expect(body.Line.map((l: any) => l.SalesItemLineDetail?.ItemRef?.value ?? l.DetailType)).toEqual([
			"QB-77",
			"1",
			"DiscountLineDetail",
		]);

		const fresh = await currentQbFingerprint(
			fakeDb as unknown as Prisma.TransactionClient,
			"inv1",
			"org1",
			snapshot,
			10,
		);
		expect(pushed?.fingerprint).toBeDefined();
		expect(fresh).toBe(pushed!.fingerprint);
	});

	it("is sensitive to the realm the item mapping is read under", async () => {
		const pushed = await pushInvoice("inv1", "org1", { finalizing: true });
		fakeDb.organization.findUnique.mockResolvedValue({ qb_realm_id: "realm-old" });

		const fresh = await currentQbFingerprint(
			fakeDb as unknown as Prisma.TransactionClient,
			"inv1",
			"org1",
			snapshot,
			10,
		);
		expect(fresh).not.toBe(pushed!.fingerprint);
	});

	it("is sensitive to the discount", async () => {
		const pushed = await pushInvoice("inv1", "org1", { finalizing: true });

		const fresh = await currentQbFingerprint(
			fakeDb as unknown as Prisma.TransactionClient,
			"inv1",
			"org1",
			snapshot,
			0,
		);
		expect(fresh).not.toBe(pushed!.fingerprint);
	});
});
