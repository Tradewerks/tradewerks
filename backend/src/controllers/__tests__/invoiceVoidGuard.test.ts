import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: {
			findFirst: vi.fn(),
			update: vi.fn(),
			// Live adjustments the void guard reads; none.
			findMany: vi.fn(async () => []),
		},
		invoice_payment: { aggregate: vi.fn() },
		$queryRaw: vi.fn().mockResolvedValue([]),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({ db: mockDb }));
vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));
// The lock and the paid aggregate run for real against the stubs above.
vi.mock("../../services/invoiceService.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/invoiceService.js")>()),
	syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
	syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
	lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue(undefined),
	invoiceInclude: {},
}));
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
vi.mock("../../services/tax/taxMode.js", () => ({
	getEffectiveTaxMode: vi.fn(async () => "manual"),
	dropClientTaxTotals: <T,>(p: T) => p,
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { updateInvoice } from "../invoicesController.js";
import { voidBlockedByPaymentReason } from "../../services/disputeAdapters.js";
import { mirrorInvoiceVoidToQuickBooks } from "../../services/qb/qbInvoices.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

function anInvoice(overrides: Record<string, unknown> = {}) {
	return {
		id: "inv1",
		invoice_number: "INV-1039",
		status: "Sent",
		organization_id: "org1",
		amount_paid: 0,
		total: 500,
		tax_snapshot: null,
		issued_at: new Date(),
		issue_date: new Date(),
		sent_at: new Date(),
		qb_invoice_id: null,
		qb_credit_memo_id: null,
		line_items: [],
		...overrides,
	};
}

const voidIt = () =>
	updateInvoice(
		{
			params: { id: "inv1" },
			body: { status: "Void", void_reason: "raised against the wrong client" },
		} as unknown as Request,
		"org1",
		{ dispatcherId: "d1" },
	);

describe("updateInvoice void guard", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses a void when a payment committed after the pre-transaction read", async () => {
		// The pre-transaction read saw nothing paid; a payment then committed
		// before this transaction took the lock.
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ amount_paid: 0 }));
		mockFn(db.invoice_payment.aggregate).mockResolvedValue({ _sum: { amount: 50 } });

		const result = await voidIt();

		expect(result.err).toBe(voidBlockedByPaymentReason(50));
		expect(db.invoice.update).not.toHaveBeenCalled();
		expect(mirrorInvoiceVoidToQuickBooks).not.toHaveBeenCalled();
	});

	it("takes the invoice row lock before the paid check when voiding", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice());
		mockFn(db.invoice_payment.aggregate).mockResolvedValue({ _sum: { amount: 0 } });
		mockFn(db.invoice.update).mockResolvedValue(anInvoice({ status: "Void" }));

		const result = await voidIt();

		expect(result.err).toBe("");
		const lockOrder = mockFn(db.$queryRaw).mock.invocationCallOrder[0];
		const paidOrder = mockFn(db.invoice_payment.aggregate).mock.invocationCallOrder[0];
		expect(lockOrder).toBeDefined();
		expect(paidOrder).toBeDefined();
		expect(lockOrder).toBeLessThan(paidOrder);
		expect(mockFn(db.$queryRaw).mock.calls[0].slice(1)).toEqual(["inv1", "org1"]);
	});
});
