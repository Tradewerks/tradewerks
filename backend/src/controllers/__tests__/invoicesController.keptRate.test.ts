import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, orgCtx, loadRateSet, resolveAddressTax } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb: Record<string, any> = {
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return {
		mockDb,
		orgCtx: vi.fn(),
		loadRateSet: vi.fn(),
		resolveAddressTax: vi.fn(),
	};
});

vi.mock("../../db.js", () => ({ db: mockDb }));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));
// The real recompute behind recomputeInvoiceTotals; the rest of the service is stubbed.
vi.mock("../../services/invoiceService.js", async () => {
	const { recomputeDocumentTotals } = await import("../../lib/recomputeDocumentTotals.js");
	return {
		syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
		syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
		lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue(undefined),
		createInvoiceRecord: vi.fn(),
		recomputeInvoiceTotals: (id: string, org: string, tx: any) =>
			recomputeDocumentTotals("invoice", id, org, tx),
		invoiceInclude: {},
	};
});
vi.mock("../../services/qb/qbInvoices.js", () => ({
	mirrorInvoiceVoidToQuickBooks: vi.fn(),
	pushInvoiceDetached: vi.fn(),
}));
vi.mock("../../services/qb/qbAstAuthority.js", () => ({ confirmQuickBooksTax: vi.fn() }));
vi.mock("../../services/quickbooksService.js", () => ({
	isQBConnected: vi.fn().mockResolvedValue(false),
	getOrgRealmId: vi.fn(),
}));
vi.mock("../../services/disputeService.js", () => ({
	openDisputeStatusChangeRefusal: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
	getEffectiveTaxMode: vi.fn(async () => "manual"),
	getOrgTaxContext: orgCtx,
}));
vi.mock("../../services/tax/taxResolver.js", () => ({ loadRateSet, resolveAddressTax }));

import type { Request } from "express";
import { updateInvoice } from "../invoicesController.js";

const LA_CROSSE = {
	id: "rs1",
	state_code: "WI",
	total_rate: 0.055,
	components: [
		{
			id: "c1",
			jurisdiction_type: "state",
			jurisdiction_name: "WI",
			jurisdiction_code: "55",
			rate: 0.05,
		},
		{
			id: "c2",
			jurisdiction_type: "county",
			jurisdiction_name: "LA CROSSE",
			jurisdiction_code: "063",
			rate: 0.005,
		},
	],
};
const MANUAL_ORG = {
	stored_mode: "manual",
	auto_entitled: true,
	mode: "manual",
	registered_states: ["WI"],
	legacy_rate: 0,
	address: "1 Shop Rd, La Crosse, WI 54601",
};
const WI_STANDARD = {
	id: "g-def",
	name: "WI Standard",
	rates: [
		{
			sort_order: 0,
			tax_rate: { id: "r1", name: "State", rate: 0.0825, jurisdiction: null },
		},
	],
};
const KEPT_SNAPSHOT = {
	version: 2,
	locked_at: "draft",
	source: "provider",
	rate_set_id: "rs1",
	sourcing: "D",
	rounding: "jurisdiction_half_up",
	kept_from_auto: true,
	groups: [],
};
const ORG_DEFAULT_SNAPSHOT = {
	version: 2,
	locked_at: "draft",
	source: "org_default",
	rounding: "jurisdiction_half_up",
	groups: [],
};
const CLIENT = "11111111-1111-4111-8111-111111111111";
const L1 = "33333333-3333-4333-8333-333333333331";
const L2 = "33333333-3333-4333-8333-333333333332";
const ADDRESS = "400 Main St, La Crosse, WI 54601";

type Row = Record<string, any>;

const LINE = { quantity: 1, tax_group_id: null };

/** A Q-0010-shaped draft invoice: $420 taxable + $190 non-taxable, linked to one job. */
function seed(invoiceSnapshot: unknown, jobSnapshot: unknown = null) {
	const state: { invoice: Row; lines: Row[] } = {
		invoice: {
			id: "inv1",
			status: "Draft",
			client_id: CLIENT,
			invoice_number: "INV-1001",
			subtotal: 610,
			tax_rate: 0.055,
			tax_amount: 23.1,
			total: 633.1,
			discount_type: null,
			discount_value: null,
			discount_amount: 0,
			amount_paid: 0,
			adjusts_invoice_id: null,
			issued_at: null,
			issue_date: null,
			sent_at: null,
			tax_snapshot: invoiceSnapshot,
			tax_source: invoiceSnapshot ? "provider" : null,
			tax_needs_review: false,
			tax_resolution_id: "res-1",
			qb_invoice_id: null,
		},
		lines: [
			{ ...LINE, id: L1, name: "Furnace", unit_price: 420, total: 420, taxable: true },
			{ ...LINE, id: L2, name: "Labor", unit_price: 190, total: 190, taxable: false },
		],
	};
	const job = {
		address: ADDRESS,
		coords: { lat: 43.8, lon: -91.2 },
		tax_snapshot: jobSnapshot,
		tax_needs_review: false,
		tax_resolution_id: "res-1",
	};
	const view = () => ({
		...state.invoice,
		line_items: state.lines,
		jobs: [{ job }],
		client: { address: ADDRESS, coords: null },
	});
	Object.assign(mockDb, {
		invoice: {
			findFirst: vi.fn(async () => view()),
			findMany: vi.fn(async () => []),
			update: vi.fn(async ({ data }: { data: Row }) => {
				Object.assign(state.invoice, data);
				return view();
			}),
		},
		invoice_line_item: {
			update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
				Object.assign(state.lines.find((l) => l.id === where.id)!, data);
			}),
			create: vi.fn(),
			delete: vi.fn(),
		},
		client: {
			findFirst: vi.fn(async () => ({ is_tax_exempt: false, tax_group_id: null })),
		},
		tax_group: {
			findMany: vi.fn(async () => []),
			findFirst: vi.fn(async () => WI_STANDARD),
		},
		inventory_item: { findMany: vi.fn(async () => []) },
	});
	return state;
}

const edit = (body: object) =>
	updateInvoice({ params: { id: "inv1" }, body } as unknown as Request, "org1", {
		dispatcherId: "d1",
	});

// The editor's flat-rate figures for the price edit below (Furnace $420 → $500).
const CLIENT_TOTALS = { subtotal: 690, tax_rate: 0.0825, tax_amount: 41.25, total: 731.25 };
const PRICE_EDIT = {
	...CLIENT_TOTALS,
	line_items: [
		{ id: L1, name: "Furnace", quantity: 1, unit_price: 500, taxable: true },
		{ id: L2, name: "Labor", quantity: 1, unit_price: 190, taxable: false },
	],
};

describe("updateInvoice — kept address rate in manual mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		orgCtx.mockResolvedValue(MANUAL_ORG);
		loadRateSet.mockResolvedValue(LA_CROSSE);
	});

	it("a kept-rate draft stores the recompute, not the client's flat-rate totals", async () => {
		const state = seed(KEPT_SNAPSHOT);

		const result = await edit(PRICE_EDIT);

		expect(result.err).toBe("");
		const snap = state.invoice.tax_snapshot;
		expect(snap).toMatchObject({ rate_set_id: "rs1", kept_from_auto: true });
		// $500 at 5.5% = $27.50; the $190 labor line is not taxed.
		expect(snap.total_tax_cents).toBe(2750);
		expect(state.invoice.tax_amount).toBe(snap.total_tax_cents / 100);
		expect(state.invoice.subtotal).toBe(690);
		expect(state.invoice.total).toBe(717.5);
		expect(state.invoice.balance_due).toBe(717.5);
		expect(resolveAddressTax).not.toHaveBeenCalled();
	});

	it("a draft with no snapshot of its own inherits its job's kept rate the same way", async () => {
		const state = seed(null, KEPT_SNAPSHOT);

		await edit(PRICE_EDIT);

		expect(state.invoice.tax_snapshot.total_tax_cents).toBe(2750);
		expect(state.invoice.tax_amount).toBe(27.5);
		expect(state.invoice.total).toBe(717.5);
	});

	it("a manual draft with no kept rate keeps today's client totals", async () => {
		const state = seed(ORG_DEFAULT_SNAPSHOT);

		await edit(PRICE_EDIT);

		expect(state.invoice.tax_amount).toBe(41.25);
		expect(state.invoice.total).toBe(731.25);
	});
});
