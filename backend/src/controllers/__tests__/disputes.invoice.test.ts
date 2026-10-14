import { describe, it, expect, vi, beforeEach } from "vitest";

// Built via vi.hoisted (not a plain module-scope require, which vitest's ESM mock
// factories can't resolve) so both the db.js and lib/context.js mocks below share
// the exact same mock instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: {
			findFirst: vi.fn(),
			update: vi.fn(),
			create: vi.fn(),
			// Both void doors read the live adjustments; none by default.
			findMany: vi.fn(async () => []),
			// The over-crediting ceiling sums the adjustment chain; the
			// Revise & Resend guard counts it. Defaults survive
			// vi.clearAllMocks, so tests that ignore the chain still run.
			aggregate: vi.fn(async () => ({ _sum: { total: 0 } })),
			count: vi.fn(async () => 0),
		},
		invoice_line_item: { findMany: vi.fn(), createMany: vi.fn() },
		// An adjustment reads the root's billed jobs and visits to attribute
		// its lines; none by default.
		invoice_job: {
			findMany: vi.fn(async () => []),
			updateMany: vi.fn(),
			update: vi.fn(),
		},
		invoice_visit: {
			findMany: vi.fn(async () => []),
			updateMany: vi.fn(),
			update: vi.fn(),
		},
		// Default impls survive vi.clearAllMocks (which clears calls, not
		// implementations), so a test that ignores notes still runs.
		invoice_note: {
			findMany: vi.fn(async () => []),
			createMany: vi.fn(),
		},
		quote: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
		quote_line_item: { findMany: vi.fn(), createMany: vi.fn() },
		quote_note: { findMany: vi.fn(async () => []), createMany: vi.fn() },
		document_dispute: {
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		request: { update: vi.fn() },
		tax_group: { findMany: vi.fn(async () => []) },
		inventory_item: { findMany: vi.fn(async () => []) },
		$executeRaw: vi.fn(),
		// SELECT ... FOR UPDATE on the original, taken before the chain is read.
		$queryRaw: vi.fn(async () => []),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateInvoiceNumber: vi.fn(async () => "INV-1040"),
	generateQuoteNumber: vi.fn(async () => "Q-1002"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

// disputeService now reaches into the invoice money helpers; they own their own
// tests and a real call here would need the full payment and tax tables.
vi.mock("../../services/invoiceService.js", () => ({
	syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
	syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
	lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue(undefined),
	// The void / revise guards read paid-to-date from the payment rows now;
	// override per test to exercise a stale amount_paid column.
	invoicePaidTotal: vi.fn().mockResolvedValue(0),
	// invoicesController (imported below for the void guard) pulls these three
	// from the same module; a named import missing from a mock factory is a
	// module-load error, not a test failure.
	createInvoiceRecord: vi.fn().mockResolvedValue(undefined),
	recomputeInvoiceTotals: vi.fn().mockResolvedValue(undefined),
	invoiceInclude: {},
}));

// The QuickBooks void runs after commit through one shared helper, which has
// its own suite.
vi.mock("../../services/qb/qbInvoices.js", () => ({
	mirrorInvoiceVoidToQuickBooks: vi.fn().mockResolvedValue(undefined),
	pushInvoice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { db } from "../../db.js";
import { mirrorInvoiceVoidToQuickBooks } from "../../services/qb/qbInvoices.js";
import {
	invoicePaidTotal,
	syncBilledAmounts,
	syncInvoicePaymentTotals,
} from "../../services/invoiceService.js";
import { openDispute, resolveDispute } from "../../services/disputeService.js";
import { updateInvoice } from "../invoicesController.js";
import { disputeErrorResponse } from "../disputesController.js";
import { resolveDisputeSchema } from "../../lib/validate/disputes.js";
import type { Request } from "express";

const CTX = { dispatcherId: "d1", organizationId: "org1" };
const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
/** Every grant but self-resolution: these suites test the outcomes, not the
 *  authority gates, which disputes.authz.test.ts and the parity matrix cover. */
const AUTHZ = { canConcede: true, canRefund: true, canResolveOwn: false };

function anInvoice(overrides: Record<string, unknown> = {}) {
	return {
		id: "inv1",
		invoice_number: "INV-1039",
		status: "Sent",
		organization_id: "org1",
		client_id: "c1",
		amount_paid: 0,
		total: 500,
		subtotal: 500,
		tax_rate: 0,
		tax_amount: 0,
		discount_type: null,
		discount_value: null,
		discount_amount: null,
		due_date: null,
		payment_terms_days: 30,
		memo: null,
		internal_notes: null,
		tax_snapshot: null,
		recurring_plan_id: null,
		version: 1,
		adjusts_invoice_id: null,
		line_items: [
			{ id: "il1", name: "Labour", total: 350 },
			{ id: "il2", name: "Parts", total: 150 },
		],
		...overrides,
	};
}

function anOpenDispute(overrides: Record<string, unknown> = {}) {
	return {
		id: "disp1",
		status: "Open",
		document_kind: "invoice",
		invoice_id: "inv1",
		status_at_open: "Sent",
		...overrides,
	};
}

describe("invoice dispute eligibility", () => {
	beforeEach(() => vi.clearAllMocks());

	it("can be disputed once paid", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Paid", amount_paid: 500 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.document_dispute.create).mockImplementation(
			({ data }: { data: Record<string, unknown> }) => ({
				id: "disp1",
				...data,
			}),
		);

		const result = await openDispute(
			"invoice",
			"inv1",
			{ reason: "billed twice" },
			"org1",
			CTX,
		);

		expect(result).not.toHaveProperty("err");
		expect(
			mockFn(db.document_dispute.create).mock.calls[0][0].data
				.status_at_open,
		).toBe("Paid");
		expect(db.invoice.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "Disputed" } }),
		);
		// The status write is kind-aware now; the quote branch must stay shut.
		expect(db.quote.update).not.toHaveBeenCalled();
	});

	it("can be disputed once issued by hand", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Issued" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.document_dispute.create).mockImplementation(
			({ data }: { data: Record<string, unknown> }) => ({
				id: "disp1",
				...data,
			}),
		);

		const result = await openDispute(
			"invoice",
			"inv1",
			{ reason: "labour hours contested at the door" },
			"org1",
			CTX,
		);

		expect(result).not.toHaveProperty("err");
		expect(
			mockFn(db.document_dispute.create).mock.calls[0][0].data.status_at_open,
		).toBe("Issued");
	});

	// DW-69: snapshot name/total at open time so the record still means
	// something if the line is ever gone by the time anyone reads it back.
	it("snapshots the contested lines' name and total, not just their ids", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Issued" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.document_dispute.create).mockImplementation(
			({ data }: { data: Record<string, unknown> }) => ({
				id: "disp1",
				...data,
			}),
		);

		await openDispute(
			"invoice",
			"inv1",
			{ reason: "labour hours wrong", contested_line_item_ids: ["il1"] },
			"org1",
			CTX,
		);

		const written = mockFn(db.document_dispute.create).mock.calls[0][0]
			.data.contested_line_item_ids;
		expect(written).toEqual([{ id: "il1", name: "Labour", total: 350 }]);
	});

	it("cannot be disputed while Draft", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Draft" }),
		);

		const result = await openDispute(
			"invoice",
			"inv1",
			{ reason: "nope" },
			"org1",
			CTX,
		);

		expect(result).toHaveProperty(
			"err",
			"A Draft invoice can't be disputed. Disputes may be opened from: Created, Sent, Viewed, Partially Paid, Fully Paid.",
		);
	});
});

describe("invoice money rules on resolve", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses Repeal when money is applied", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", amount_paid: 120 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "written off" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect((result as { err: string }).err).toMatch(/adjustment/i);
		// Spec §4 words this with the currency symbol; the frontend emits the
		// byte-identical string.
		expect((result as { err: string }).err).toContain("$120.00 applied");
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("refuses Revise & Resend when money is applied", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", amount_paid: 120 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect(db.invoice.create).not.toHaveBeenCalled();
	});

	it("allows Repeal on an unpaid invoice and stores the reason", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "raised against the wrong client" },
			"org1",
			CTX,
			AUTHZ,
		);

		const update = mockFn(db.invoice.update).mock.calls[0][0];
		expect(update.data.status).toBe("Void");
		expect(update.data.void_reason).toBe("raised against the wrong client");
		expect(update.data.voided_at).toBeInstanceOf(Date);

		// `status: "Open"` in the where IS the compare-and-swap, and the data is
		// the audit row spec §12 makes the only mitigation for single-actor
		// repeal. Both were unpinned (DW-23).
		const claim = mockFn(db.document_dispute.updateMany).mock.calls[0][0];
		expect(claim.where).toEqual({ id: "disp1", status: "Open" });
		expect(claim.data).toMatchObject({
			status: "Resolved",
			resolution: "Repeal",
			resolution_note: "raised against the wrong client",
			resolved_by_dispatcher_id: "d1",
		});
		expect(claim.data.resolved_at).toBeInstanceOf(Date);
	});

	// DW-53: the void guard reads paid-to-date from the payment rows, not the
	// cached amount_paid column, so a stale column can't wave a paid invoice
	// through Repeal (the refund guard already reads the rows).
	it("refuses Repeal from the payment rows even when amount_paid is stale", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", amount_paid: 0 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(anOpenDispute());
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		// Once: voidInvoice reads it exactly once, and this must not leak the
		// stale figure into the tests that follow.
		mockFn(invoicePaidTotal).mockResolvedValueOnce(1200);

		await expect(
			resolveDispute(
				"invoice",
				"inv1",
				"disp1",
				{ resolution: "Repeal", note: "x" },
				"org1",
				CTX,
				AUTHZ,
			),
		).rejects.toThrow(/1,200\.00 applied/);

		const voided = mockFn(db.invoice.update).mock.calls.some(
			(c) => c[0]?.data?.status === "Void",
		);
		expect(voided).toBe(false);
	});
});

describe("invoice Revise & Resend", () => {
	beforeEach(() => vi.clearAllMocks());

	function armRevise() {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "inv2",
			invoice_number: "INV-1040",
		});
		mockFn(db.invoice_visit.findMany).mockResolvedValue([]);
		mockFn(db.invoice_job.findMany).mockResolvedValue([]);
		mockFn(db.invoice.findMany).mockResolvedValue([]);
	}

	/**
	 * Replacing an already-adjusted invoice voids a document the adjustment
	 * chain points at: its `adjusts_invoice_id` would name a dead row, and its
	 * share of the job's billing drops out of the chain syncBilledAmounts
	 * walks, so profitability silently loses that money while the adjustment
	 * stays collectible. ServiceTitan treats an adjusted invoice as locked
	 * audit trail for the same reason; NetSuite and QuickBooks both require an
	 * applied credit to be unapplied before the invoice can be voided.
	 */
	it("refuses to replace an invoice that already has an adjustment", async () => {
		armRevise();
		mockFn(db.invoice.count).mockResolvedValue(1);
		mockFn(db.invoice_line_item.findMany).mockResolvedValue([]);

		await expect(
			resolveDispute(
				"invoice",
				"inv1",
				"disp1",
				{ resolution: "ReviseAndResend" },
				"org1",
				CTX,
				AUTHZ,
			),
		).rejects.toThrow(/already been adjusted/);

		// The original must not be voided on the way out.
		const voided = mockFn(db.invoice.update).mock.calls.some(
			(c) => c[0]?.data?.status === "Void",
		);
		expect(voided).toBe(false);
	});

	it("still replaces an invoice with no adjustments", async () => {
		armRevise();
		mockFn(db.invoice.count).mockResolvedValue(0);
		mockFn(db.invoice_line_item.findMany).mockResolvedValue([]);

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).not.toHaveProperty("err");
	});

	it("voids the original, creates a replacement, and moves the job links", async () => {
		armRevise();
		mockFn(db.invoice_line_item.findMany).mockResolvedValue([
			{
				id: "il1",
				name: "Labour",
				description: null,
				quantity: 2,
				unit_price: 100,
				total: 200,
				item_type: null,
				sort_order: 0,
				tax_group_id: null,
				taxable: true,
				tax_amount: null,
				inventory_item_id: null,
				source_job_id: "j1",
				source_visit_id: "v1",
			},
		]);

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		const created = mockFn(db.invoice.create).mock.calls[0][0].data;
		expect(created.version).toBe(2);
		expect(created.previous_invoice_id).toBe("inv1");
		expect(created.status).toBe("Issued");
		expect(created.amount_paid).toBe(0);

		// The line's job attribution must survive, or the job's billed amount
		// vanishes along with the voided original.
		const clonedLines = mockFn(db.invoice_line_item.createMany).mock
			.calls[0][0].data;
		expect(clonedLines[0].source_job_id).toBe("j1");
		expect(clonedLines[0].source_visit_id).toBe("v1");

		expect(db.invoice_job.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { invoice_id: "inv1" },
				data: { invoice_id: "inv2" },
			}),
		);
		expect(db.invoice_visit.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { invoice_id: "inv1" },
				data: { invoice_id: "inv2" },
			}),
		);
		expect(syncBilledAmounts).toHaveBeenCalled();

		const voided = mockFn(db.invoice.update).mock.calls.find(
			(c: [{ data: { status?: string } }]) => c[0].data.status === "Void",
		);
		expect(voided).toBeTruthy();
		expect(voided[0].data.void_reason).toMatch(/INV-1040/);

		const claim = mockFn(db.document_dispute.updateMany).mock.calls[0][0];
		expect(claim.where).toEqual({ id: "disp1", status: "Open" });
		expect(claim.data).toMatchObject({
			status: "Resolved",
			resolution: "ReviseAndResend",
			resolution_note: null,
			resolved_by_dispatcher_id: "d1",
		});

		// The pointer goes on the invoice column, not the quote one.
		expect(db.document_dispute.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { replacement_invoice_id: "inv2" },
			}),
		);
	});

	// The PDF renders note content and nothing else, so dropping the notes
	// silently deletes client-facing text from the replacement.
	it("carries the notes onto the replacement without claiming authorship", async () => {
		armRevise();
		mockFn(db.invoice_line_item.findMany).mockResolvedValue([]);
		mockFn(db.invoice_note.findMany).mockResolvedValue([
			{
				id: "n1",
				content: "Net 15 agreed by phone",
				organization_id: "org1",
				creator_dispatcher_id: "d9",
			},
		]);

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		const copied = mockFn(db.invoice_note.createMany).mock.calls[0][0].data;
		expect(copied).toHaveLength(1);
		expect(copied[0].invoice_id).toBe("inv2");
		expect(copied[0].content).toBe("Net 15 agreed by phone");
		expect(copied[0].creator_dispatcher_id).toBe("d1");
	});
});

// D5: the replacement's due date is max(original due date, reissue + terms).
// It is issued today, so it must never be born overdue, and it must never
// shorten a window the client still had.
describe("invoice Revise & Resend — replacement due date (D5)", () => {
	beforeEach(() => vi.clearAllMocks());

	const DAY = 86_400_000;

	async function reviseWith(original: Record<string, unknown>) {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", ...original }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(anOpenDispute());
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "inv2",
			invoice_number: "INV-1040",
		});
		mockFn(db.invoice.count).mockResolvedValue(0);
		mockFn(db.invoice_line_item.findMany).mockResolvedValue([]);
		mockFn(db.invoice_visit.findMany).mockResolvedValue([]);
		mockFn(db.invoice_job.findMany).mockResolvedValue([]);
		mockFn(db.invoice.findMany).mockResolvedValue([]);

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);
		return mockFn(db.invoice.create).mock.calls[0][0].data.due_date as Date;
	}

	it("an overdue original is re-dated to reissue + terms, not born overdue", async () => {
		const due = await reviseWith({
			due_date: new Date(Date.now() - 40 * DAY),
			payment_terms_days: 30,
		});
		expect(due.getTime()).toBeGreaterThan(Date.now());
		// reissue (now) + 30 days, within a minute of wall clock
		expect(Math.abs(due.getTime() - (Date.now() + 30 * DAY))).toBeLessThan(
			60_000,
		);
	});

	it("a not-yet-due original with a longer window keeps that later date", async () => {
		const laterDue = new Date(Date.now() + 120 * DAY);
		const due = await reviseWith({
			due_date: laterDue,
			payment_terms_days: 15,
		});
		expect(due.getTime()).toBe(laterDue.getTime());
	});

	it("null terms keeps the original due date", async () => {
		const originalDue = new Date(Date.now() + 50 * DAY);
		const due = await reviseWith({
			due_date: originalDue,
			payment_terms_days: null,
		});
		expect(due.getTime()).toBe(originalDue.getTime());
	});

	it("a null original due date falls back to reissue + terms", async () => {
		const due = await reviseWith({ due_date: null, payment_terms_days: 20 });
		expect(Math.abs(due.getTime() - (Date.now() + 20 * DAY))).toBeLessThan(
			60_000,
		);
	});
});

// The document can move underneath an open dispute — a Void arriving from
// another session, say — while the banner is still on screen offering the
// outcomes. updateInvoice now refuses a status change under an open dispute
// (see the guard suite at the end of this file), but the resolve path still has
// to survive a document that already moved. Mirrors the quote-side test.
describe("invoice that moved out of Disputed under an open dispute", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses Revise & Resend instead of reviving the voided invoice", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Void" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice_line_item.findMany).mockResolvedValue([]);
		mockFn(db.invoice.create).mockResolvedValue({
			id: "inv2",
			invoice_number: "INV-1040",
		});

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect((result as { err: string }).err).toContain("no longer Disputed");
		// assertValidInvoiceTransition short-circuits on from === to, so
		// nothing below would have stopped a Void invoice being cloned into a
		// live Issued one with the job billing moved onto it.
		expect(db.invoice.create).not.toHaveBeenCalled();
		expect(db.invoice_job.updateMany).not.toHaveBeenCalled();
		expect(db.invoice_visit.updateMany).not.toHaveBeenCalled();
		// The dispute stays Open — the dispatcher gets to retry once they look.
		expect(db.document_dispute.updateMany).not.toHaveBeenCalled();
	});

	it("refuses Repeal instead of overwriting the earlier void record", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Void" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "second thoughts" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("refuses Issue Adjustment instead of un-voiding the original", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Void", amount_paid: 500 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute({ status_at_open: "Paid" }),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{
				resolution: "IssueAdjustment",
				adjustment_lines: [
					{
						name: "Credit",
						quantity: -1,
						unit_price: 200,
						total: -200,
					},
				],
			},
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect(db.invoice.create).not.toHaveBeenCalled();
		// restoreInvoiceStatus would otherwise have written Sent over Void.
		expect(db.invoice.update).not.toHaveBeenCalled();
	});
});

describe("invoice Issue Adjustment", () => {
	beforeEach(() => vi.clearAllMocks());

	it("restores a paid original through Sent and recomputes it", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", amount_paid: 500 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute({ status_at_open: "Paid" }),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{
				resolution: "IssueAdjustment",
				adjustment_lines: [
					{
						name: "Credit: duplicate labour",
						quantity: -1,
						unit_price: 200,
						total: -200,
					},
				],
			},
			"org1",
			CTX,
			AUTHZ,
		);

		expect(db.document_dispute.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { adjustment_invoice_id: "adj1" },
			}),
		);

		// Paid has no direct restore edge; it goes back through Sent and the
		// payment rows put it back to Paid.
		const restore = mockFn(db.invoice.update).mock.calls.find(
			(c: [{ where: { id: string }; data: { status?: string } }]) =>
				c[0].where.id === "inv1",
		);
		expect(restore[0].data.status).toBe("Sent");
		expect(syncInvoicePaymentTotals).toHaveBeenCalledWith(
			"inv1",
			expect.anything(),
		);
	});

	/**
	 * Restoring through Sent would claim the system emailed a document the
	 * dispatcher handed over by hand. Issued has a direct restore edge instead.
	 */
	it("restores an issued original to Issued", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", amount_paid: 0 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute({ status_at_open: "Issued" }),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{
				resolution: "IssueAdjustment",
				adjustment_lines: [
					{
						name: "Credit: duplicate labour",
						quantity: -1,
						unit_price: 200,
						total: -200,
					},
				],
			},
			"org1",
			CTX,
			AUTHZ,
		);

		const restore = mockFn(db.invoice.update).mock.calls.find(
			(c: [{ where: { id: string }; data: { status?: string } }]) =>
				c[0].where.id === "inv1",
		);
		expect(restore[0].data.status).toBe("Issued");
	});
});

// PATCH /invoices/:id used to be a way out of Disputed with no way back: the
// resolve endpoint requires the invoice to still be Disputed and Void is
// terminal, so the dispute could never be closed and it kept the
// dispute_one_open_per_invoice index forever.
describe("updateInvoice under an open dispute", () => {
	beforeEach(() => vi.clearAllMocks());

	const patch = (body: Record<string, unknown>) =>
		updateInvoice(
			{ params: { id: "inv1" }, body } as unknown as Request,
			"org1",
			CTX,
		);

	it("refuses a status change while a dispute is open", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		const result = await patch({
			status: "Void",
			void_reason: "client complained",
		});

		expect(result.err).toContain("open dispute");
		expect(db.document_dispute.findFirst).toHaveBeenCalledWith({
			where: { invoice_id: "inv1", status: "Open" },
			select: { id: true },
		});
		expect(db.invoice.update).not.toHaveBeenCalled();
	});
});

/**
 * The kebab's Void bypassed the rule the dispute outcomes enforce: a
 * partially-paid invoice could be voided outright, which also fired
 * voidQBInvoice and left the payment rows pointing at a dead document.
 */
describe("updateInvoice refuses a void that would strand a payment", () => {
	beforeEach(() => vi.clearAllMocks());

	const patch = (body: Record<string, unknown>) =>
		updateInvoice(
			{ params: { id: "inv1" }, body } as unknown as Request,
			"org1",
			CTX,
		);

	it("refuses when money has been applied", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "PartiallyPaid", amount_paid: 120 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const result = await patch({
			status: "Void",
			void_reason: "client complained",
		});

		expect(result.err).toBe(
			"This invoice has $120.00 applied. Issue an adjustment instead — voiding would strand the payment.",
		);
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("allows a void when nothing has been applied", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Sent", amount_paid: 0 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const result = await patch({
			status: "Void",
			void_reason: "raised against the wrong client",
		});

		expect(result.err).toBe("");
	});

	it("does not block a non-void update on a partially-paid invoice", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "PartiallyPaid", amount_paid: 120 }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const result = await patch({ memo: "spoke to the client" });

		expect(result.err).toBe("");
	});
});

// Spec 7.3 / 10: these two refusals are races, not bad requests.
describe("dispute conflicts map to 409", () => {
	beforeEach(() => vi.clearAllMocks());

	it("tags a second open dispute as a conflict", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice());
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		const result = await openDispute(
			"invoice",
			"inv1",
			{ reason: "wrong total" },
			"org1",
			CTX,
		);

		expect(result).toMatchObject({ conflict: true });
		expect(disputeErrorResponse(result as { err: string }).status).toBe(
			409,
		);
	});

	it("tags a lost compare-and-swap as a conflict", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		// Another dispatcher already claimed it.
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 0 });

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "written off" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toMatchObject({ conflict: true });
		expect(disputeErrorResponse(result as { err: string }).status).toBe(
			409,
		);
	});

	it("leaves every other refusal at 422", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Draft" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const result = await openDispute(
			"invoice",
			"inv1",
			{ reason: "wrong total" },
			"org1",
			CTX,
		);

		expect(disputeErrorResponse(result as { err: string }).status).toBe(
			422,
		);
	});
});

// One act, one QuickBooks behaviour (D3): a dispute void reaches QuickBooks the
// way the kebab's Void does, and only once the local void has committed.
describe("dispute-driven void and QuickBooks", () => {
	beforeEach(() => vi.clearAllMocks());

	it("marks the voided invoice not_synced, then voids it in QuickBooks after commit", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", qb_invoice_id: "qb-77" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		const order: string[] = [];
		mockFn(db.$transaction).mockImplementationOnce(
			async (fn: (tx: unknown) => unknown) => {
				const out = await fn(db);
				order.push("commit");
				return out;
			},
		);
		mockFn(mirrorInvoiceVoidToQuickBooks).mockImplementationOnce(async () => {
			order.push("quickbooks");
		});

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "written off" },
			"org1",
			CTX,
			AUTHZ,
		);

		const voided = mockFn(db.invoice.update).mock.calls.find(
			(c: [{ data: { status?: string } }]) => c[0].data.status === "Void",
		);
		expect(voided[0].data.qb_sync_status).toBe("not_synced");
		expect(mirrorInvoiceVoidToQuickBooks).toHaveBeenCalledWith(
			"org1",
			"inv1",
			"qb-77",
		);
		expect(order).toEqual(["commit", "quickbooks"]);
	});

	it("voids the original a Revise & Resend replaces in QuickBooks too", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", qb_invoice_id: "qb-78" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "inv2",
			invoice_number: "INV-1040",
		});
		mockFn(db.invoice.count).mockResolvedValue(0);
		mockFn(db.invoice_line_item.findMany).mockResolvedValue([]);

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(mirrorInvoiceVoidToQuickBooks).toHaveBeenCalledWith(
			"org1",
			"inv1",
			"qb-78",
		);
	});

	it("does not reach QuickBooks when the resolution is refused", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", amount_paid: 120, qb_invoice_id: "qb-79" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "written off" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(mirrorInvoiceVoidToQuickBooks).not.toHaveBeenCalled();
	});
});

/**
 * D1: an adjustment is its own Issued invoice, and receivables read it by its
 * own status. Voiding the invoice it adjusts — by Repeal or by the kebab —
 * would leave the credit live against a dead parent and understate AR by it,
 * so both doors refuse and name the adjustment to void first.
 */
describe("voiding an invoice that has a live adjustment", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses Repeal and names the adjustment", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({
				status: "Disputed",
				adjustments: [{ id: "adj1", invoice_number: "INV-1001" }],
			}),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });

		const result = await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "written off" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toEqual({
			err: "INV-1001 adjusts this invoice. Void INV-1001 first, then void this one.",
		});
		expect(db.invoice.update).not.toHaveBeenCalled();
		// Refused before the compare-and-swap, so the dispute stays Open.
		expect(db.document_dispute.updateMany).not.toHaveBeenCalled();
	});

	it("loads only live adjustments, so a voided one no longer blocks", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", adjustments: [] }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "written off" },
			"org1",
			CTX,
			AUTHZ,
		);

		const load = mockFn(db.invoice.findFirst).mock.calls[0][0];
		expect(load.include.adjustments).toEqual({
			where: { status: { not: "Void" } },
			select: { id: true, invoice_number: true },
		});
		expect(db.invoice.update).toHaveBeenCalled();
	});

	it("re-checks the chain inside the void itself", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", adjustments: [] }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.invoice.findMany).mockResolvedValueOnce([
			{ invoice_number: "INV-1001" },
		]);

		await expect(
			resolveDispute(
				"invoice",
				"inv1",
				"disp1",
				{ resolution: "Repeal", note: "written off" },
				"org1",
				CTX,
				AUTHZ,
			),
		).rejects.toThrow("INV-1001 adjusts this invoice");
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("refuses the kebab's Void and names the adjustment", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Sent" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.invoice.findMany).mockResolvedValueOnce([
			{ invoice_number: "INV-1001" },
		]);

		const result = await updateInvoice(
			{
				params: { id: "inv1" },
				body: { status: "Void", void_reason: "raised against the wrong client" },
			} as unknown as Request,
			"org1",
			CTX,
		);

		expect(result.err).toBe(
			"INV-1001 adjusts this invoice. Void INV-1001 first, then void this one.",
		);
		expect(db.invoice.findMany).toHaveBeenCalledWith({
			where: { adjusts_invoice_id: "inv1", status: { not: "Void" } },
			select: { invoice_number: true },
		});
		expect(db.invoice.update).not.toHaveBeenCalled();
	});
});

// A voided adjustment has to stop reducing its job's revenue, so every void
// door re-derives the chain once the void is written (DW-73).
describe("every void door re-derives job billing", () => {
	beforeEach(() => vi.clearAllMocks());

	it("Repeal re-syncs after the void", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Disputed", adjusts_invoice_id: "inv0" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "credit issued in error" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(syncBilledAmounts).toHaveBeenCalledWith("inv1", expect.anything());
		const voidOrder = mockFn(db.invoice.update).mock.invocationCallOrder[0];
		expect(mockFn(syncBilledAmounts).mock.invocationCallOrder[0]).toBeGreaterThan(
			voidOrder,
		);
	});

	it("the kebab's Void re-syncs too", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ status: "Issued", adjusts_invoice_id: "inv0" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const result = await updateInvoice(
			{
				params: { id: "inv1" },
				body: { status: "Void", void_reason: "credit issued in error" },
			} as unknown as Request,
			"org1",
			CTX,
		);

		expect(result.err).toBe("");
		expect(syncBilledAmounts).toHaveBeenCalledWith("inv1", expect.anything());
	});
});

// Payments stay allowed mid-dispute (D7), so a payment racing a Repeal is
// ordinary use. insertInvoicePayment takes the same lock (DW-08).
describe("resolveDispute locks the invoice before reading it", () => {
	beforeEach(() => vi.clearAllMocks());

	it("takes the org-scoped row lock ahead of the load", async () => {
		const order: string[] = [];
		mockFn(db.$queryRaw).mockImplementationOnce(async () => {
			order.push("lock");
			return [];
		});
		mockFn(db.invoice.findFirst).mockImplementationOnce(async () => {
			order.push("read");
			return anInvoice({ status: "Disputed" });
		});
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 0 });

		await resolveDispute(
			"invoice",
			"inv1",
			"disp1",
			{ resolution: "Repeal", note: "written off" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(order).toEqual(["lock", "read"]);
		const [strings, ...values] = mockFn(db.$queryRaw).mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(strings.join("?")).toMatch(
			/SELECT id FROM invoice WHERE id = \? AND organization_id = \? FOR UPDATE/,
		);
		expect(values).toEqual(["inv1", "org1"]);
	});
});

// A set of lines that nets to zero writes a client-facing document that
// corrects nothing and burns an invoice number. The modal blocks it; the
// schema has to block an API caller too.
describe("resolveDisputeSchema net adjustment", () => {
	const line = (total: number) => ({
		name: "line",
		quantity: total < 0 ? -1 : 1,
		unit_price: Math.abs(total),
		total,
	});

	it("rejects lines that net to zero", () => {
		const result = resolveDisputeSchema.safeParse({
			resolution: "IssueAdjustment",
			adjustment_lines: [line(-200), line(200)],
		});
		expect(result.success).toBe(false);
	});

	it("accepts a re-price whose lines net to a non-zero credit", () => {
		const result = resolveDisputeSchema.safeParse({
			resolution: "IssueAdjustment",
			adjustment_lines: [line(-500), line(450)],
		});
		expect(result.success).toBe(true);
	});
});

// invoice_line_item amounts are Decimal(10,2); past that the write dies inside
// the transaction as an unexplained 500 with the dispute left Open (DW-48).
describe("adjustment line amounts stay inside their column", () => {
	const lines = (quantity: number, unit_price: number) => ({
		resolution: "IssueAdjustment",
		adjustment_lines: [
			{ name: "Correction", quantity, unit_price, total: quantity * unit_price },
		],
	});

	it("rejects a unit price past the column", () => {
		expect(resolveDisputeSchema.safeParse(lines(1, 1e9)).success).toBe(false);
	});

	it("accepts the column's largest credit", () => {
		expect(
			resolveDisputeSchema.safeParse(lines(-1, 99_999_999.99)).success,
		).toBe(true);
	});
});
