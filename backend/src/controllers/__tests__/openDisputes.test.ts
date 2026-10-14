import { describe, it, expect, vi, beforeEach } from "vitest";

// Same hoisted-mock shape as disputes.authz.test.ts: db.js and lib/context.js
// must share one instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
		invoice: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), count: vi.fn(async () => 0) },
		document_dispute: {
			findMany: vi.fn(async () => []),
			findFirst: vi.fn(),
			count: vi.fn(async () => 0),
		},
		$queryRaw: vi.fn(async () => []),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateInvoiceNumber: vi.fn(async () => "INV-1"),
	generateQuoteNumber: vi.fn(async () => "Q-1"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../services/invoiceService.js", () => ({
	syncBilledAmounts: vi.fn(),
	syncInvoicePaymentTotals: vi.fn(),
	lockInvoiceTaxSnapshot: vi.fn(),
	invoicePaidTotal: vi.fn(),
	createInvoiceRecord: vi.fn(),
	recomputeInvoiceTotals: vi.fn(),
	invoiceInclude: {},
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getScopedDb } from "../../lib/context.js";
import {
	listDisputesWithOutcomes,
	listOpenDisputes,
	OPEN_DISPUTES_LIMIT,
	type DisputeAccess,
} from "../../services/disputeService.js";
import { openDisputesRoute } from "../disputesController.js";
import { callHandlers } from "../../routes/__tests__/harness.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const FULL: DisputeAccess = {
	authz: { canConcede: true, canRefund: true, canResolveOwn: true },
	canResolve: true,
	dispatcherId: "d1",
};

const quoteRow = (over: Record<string, unknown> = {}) => ({
	id: "disp-q",
	document_kind: "quote",
	quote_id: "q1",
	invoice_id: null,
	status: "Open",
	reason: "Scope changed",
	contested_line_item_ids: null,
	opened_at: new Date("2026-09-01T00:00:00Z"),
	opened_by_dispatcher_id: "d2",
	opened_by_dispatcher: { id: "d2", name: "Sam" },
	quote: { quote_number: "Q-0031", total: "860.00", client: { id: "c1", name: "J. Rivera" } },
	invoice: null,
	...over,
});

const invoiceRow = (over: Record<string, unknown> = {}) => ({
	id: "disp-i",
	document_kind: "invoice",
	quote_id: null,
	invoice_id: "i1",
	status: "Open",
	reason: "Charged 2 hrs, was 1",
	contested_line_item_ids: [
		{ id: "li1", name: "Labor", total: 150 },
		{ id: "li2", name: "Trip", total: 45.5 },
	],
	opened_at: new Date("2026-08-30T00:00:00Z"),
	opened_by_dispatcher_id: "d1",
	opened_by_dispatcher: { id: "d1", name: "Dee" },
	quote: null,
	invoice: { invoice_number: "INV-0142", balance_due: "1240.00", client: { id: "c2", name: "Acme HVAC" } },
	...over,
});

const aDisputedQuote = () => ({
	id: "q1",
	quote_number: "Q-0031",
	status: "Disputed",
	organization_id: "org1",
	line_items: [],
	job: null,
	request: { id: "r1", status: "Quoted", jobs: [] },
});

const aDisputedInvoice = (over: Record<string, unknown> = {}) => ({
	id: "i1",
	invoice_number: "INV-0142",
	status: "Disputed",
	organization_id: "org1",
	line_items: [],
	amount_paid: 0,
	adjustments: [],
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	mockFn(mockDb.document_dispute.findMany).mockResolvedValue([]);
	mockFn(mockDb.document_dispute.count).mockResolvedValue(0);
});

describe("listOpenDisputes", () => {
	it("returns an empty list without querying when no kind is viewable", async () => {
		const result = await listOpenDisputes("org1", [], FULL);
		expect(result).toEqual({ items: [], counts: { quote: 0, invoice: 0 }, total: 0 });
		expect(mockDb.document_dispute.findMany).not.toHaveBeenCalled();
	});

	it("scopes to the org, Open status and the viewable kinds only", async () => {
		await listOpenDisputes("org1", ["invoice"], FULL);
		expect(getScopedDb).toHaveBeenCalledWith("org1");
		const args = mockFn(mockDb.document_dispute.findMany).mock.calls[0][0];
		expect(args.where.status).toBe("Open");
		expect(args.where.document_kind).toEqual({ in: ["invoice"] });
		expect(args.orderBy).toEqual({ opened_at: "asc" });
		expect(args.take).toBe(OPEN_DISPUTES_LIMIT);
		const countKinds = mockFn(mockDb.document_dispute.count).mock.calls.map(
			(c) => c[0].where.document_kind,
		);
		expect(countKinds).toEqual([{ in: ["invoice"] }]);
	});

	it("filters to one client across both document kinds", async () => {
		await listOpenDisputes("org1", ["quote", "invoice"], FULL, "c1");
		const where = mockFn(mockDb.document_dispute.findMany).mock.calls[0][0].where;
		expect(where.OR).toEqual([{ quote: { client_id: "c1" } }, { invoice: { client_id: "c1" } }]);
	});

	it("maps rows: number, client, amount (quote total / invoice balance), contested sum", async () => {
		mockFn(mockDb.document_dispute.findMany).mockResolvedValue([invoiceRow(), quoteRow()]);
		mockFn(mockDb.document_dispute.count).mockResolvedValue(1);
		mockFn(mockDb.quote.findFirst).mockResolvedValue(aDisputedQuote());
		mockFn(mockDb.invoice.findFirst).mockResolvedValue(aDisputedInvoice());

		const result = await listOpenDisputes("org1", ["quote", "invoice"], FULL);

		expect(result.total).toBe(2);
		expect(result.counts).toEqual({ quote: 1, invoice: 1 });
		expect(result.items[0]).toMatchObject({
			dispute_id: "disp-i",
			kind: "invoice",
			document_id: "i1",
			document_number: "INV-0142",
			client: { id: "c2", name: "Acme HVAC" },
			amount: 1240,
			contested_amount: 195.5,
			reason: "Charged 2 hrs, was 1",
			opened_by: { id: "d1", name: "Dee" },
		});
		expect(result.items[1]).toMatchObject({
			kind: "quote",
			document_number: "Q-0031",
			amount: 860,
			contested_amount: null,
		});
	});

	it("reports the full total even when rows are capped", async () => {
		mockFn(mockDb.document_dispute.findMany).mockResolvedValue([quoteRow()]);
		mockFn(mockDb.document_dispute.count).mockResolvedValue(51);
		mockFn(mockDb.quote.findFirst).mockResolvedValue(aDisputedQuote());
		const result = await listOpenDisputes("org1", ["quote"], FULL);
		expect(result.items).toHaveLength(1);
		expect(result.total).toBe(51);
	});

	it("can_resolve is false when the document can no longer be loaded", async () => {
		mockFn(mockDb.document_dispute.findMany).mockResolvedValue([quoteRow()]);
		mockFn(mockDb.quote.findFirst).mockResolvedValue(null);
		const result = await listOpenDisputes("org1", ["quote"], FULL);
		expect(result.items[0].can_resolve).toBe(false);
	});

	/**
	 * Parity with the detail page: "You can resolve" must be true exactly when
	 * DisputeStage would render at least one enabled outcome for this caller.
	 */
	describe("can_resolve parity with listDisputesWithOutcomes", () => {
		const cases: Array<{
			name: string;
			kind: "quote" | "invoice";
			row: Record<string, unknown>;
			doc: Record<string, unknown>;
			access: DisputeAccess;
		}> = [
			{
				name: "self-opened quote without resolve_own_disputes",
				kind: "quote",
				row: quoteRow({ opened_by_dispatcher_id: "d1" }),
				doc: aDisputedQuote(),
				access: { ...FULL, authz: { ...FULL.authz, canResolveOwn: false } },
			},
			{
				name: "caller without resolve_disputes",
				kind: "quote",
				row: quoteRow(),
				doc: aDisputedQuote(),
				access: { ...FULL, canResolve: false },
			},
			{
				name: "invoice with a payment, caller without concede_disputes",
				kind: "invoice",
				row: invoiceRow({ opened_by_dispatcher_id: "d2" }),
				doc: aDisputedInvoice({ amount_paid: 100 }),
				access: { ...FULL, authz: { canConcede: false, canRefund: true, canResolveOwn: true } },
			},
			{
				name: "invoice without refund_invoices but with concede_disputes",
				kind: "invoice",
				row: invoiceRow({ opened_by_dispatcher_id: "d2" }),
				doc: aDisputedInvoice(),
				access: { ...FULL, authz: { canConcede: true, canRefund: false, canResolveOwn: true } },
			},
			{
				name: "admin-equivalent full authority",
				kind: "quote",
				row: quoteRow({ opened_by_dispatcher_id: "d1" }),
				doc: aDisputedQuote(),
				access: FULL,
			},
		];

		for (const c of cases) {
			it(c.name, async () => {
				mockFn(mockDb.document_dispute.findMany).mockResolvedValue([c.row]);
				mockFn(c.kind === "quote" ? mockDb.quote.findFirst : mockDb.invoice.findFirst).mockResolvedValue(c.doc);

				const open = await listOpenDisputes("org1", [c.kind], c.access);
				const detail = await listDisputesWithOutcomes(c.kind, c.kind === "quote" ? "q1" : "i1", "org1", c.access);
				const detailCanResolve = detail.disputes[0].outcomes!.some((o) => !o.disabled);

				expect(open.items[0].can_resolve).toBe(detailCanResolve);
			});
		}
	});
});

describe("GET /disputes/open route", () => {
	it("403s a dispatcher holding neither view permission", async () => {
		const r = await callHandlers(openDisputesRoute, {
			user: { uid: "u1", organization_id: "org1", role: "dispatcher", permissions: ["view_jobs"] },
		});
		expect(r.status).toBe(403);
		expect(mockDb.document_dispute.findMany).not.toHaveBeenCalled();
	});

	it("400s a malformed client_id", async () => {
		const r = await callHandlers(openDisputesRoute, {
			user: { uid: "u1", organization_id: "org1", role: "dispatcher", permissions: ["view_quotes"] },
			query: { client_id: "not-a-uuid" },
		});
		expect(r.status).toBe(400);
		expect(r.body).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
	});

	it("lists only invoice disputes for a view_invoices-only dispatcher", async () => {
		const r = await callHandlers(openDisputesRoute, {
			user: { uid: "u1", organization_id: "org1", role: "dispatcher", permissions: ["view_invoices"] },
		});
		expect(r.body).toMatchObject({ success: true });
		const where = mockFn(mockDb.document_dispute.findMany).mock.calls[0][0].where;
		expect(where.document_kind).toEqual({ in: ["invoice"] });
		expect(r.body.data.counts.quote).toBe(0);
	});

	it("lists both kinds for admin", async () => {
		await callHandlers(openDisputesRoute, {
			user: { uid: "u1", organization_id: "org1", role: "admin", permissions: [] },
		});
		const where = mockFn(mockDb.document_dispute.findMany).mock.calls[0][0].where;
		expect(where.document_kind).toEqual({ in: ["quote", "invoice"] });
	});
});
