import { describe, it, expect, vi, beforeEach } from "vitest";

// Same hoisted-mock shape as disputes.quote.test.ts so db.js and lib/context.js
// share one instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
		quote_line_item: { findMany: vi.fn(), createMany: vi.fn() },
		quote_note: { findMany: vi.fn(async () => []), createMany: vi.fn() },
		invoice: {
			findFirst: vi.fn(),
			update: vi.fn(),
			create: vi.fn(),
			count: vi.fn(async () => 0),
			aggregate: vi.fn(async () => ({ _sum: { total: 0 } })),
		},
		invoice_line_item: { findMany: vi.fn(), createMany: vi.fn() },
		invoice_note: { findMany: vi.fn(async () => []), createMany: vi.fn() },
		invoice_job: { updateMany: vi.fn() },
		invoice_visit: { updateMany: vi.fn() },
		document_dispute: {
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		request: { update: vi.fn() },
		$queryRaw: vi.fn(async () => []),
		$executeRaw: vi.fn(),
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
	syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
	syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
	lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue(undefined),
	invoicePaidTotal: vi.fn().mockResolvedValue(0),
	createInvoiceRecord: vi.fn().mockResolvedValue(undefined),
	recomputeInvoiceTotals: vi.fn().mockResolvedValue(undefined),
	invoiceInclude: {},
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { openDispute, resolveDispute } from "../../services/disputeService.js";
import { disputeErrorResponse, postResolution } from "../disputesController.js";
import { ErrorCodes } from "../../types/responses.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const CTX = { dispatcherId: "d1", organizationId: "org1" };

const aQuote = () => ({
	id: "q1",
	quote_number: "Q-9",
	status: "Disputed",
	organization_id: "org1",
	line_items: [],
	job: null,
	request: null,
});

const openedBy = (dispatcherId: string | null) => ({
	id: "disp1",
	status: "Open",
	document_kind: "quote",
	quote_id: "q1",
	status_at_open: "Sent",
	opened_by_dispatcher_id: dispatcherId,
});

/** Fails the compare-and-swap, so a resolution that reaches it stops there
 *  rather than executing an outcome. Reaching the swap at all is the claim:
 *  the authority checks sit in front of it. */
const casLoses = () =>
	mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 0 });

const resolveAsD1 = (authz: {
	canConcede: boolean;
	canRefund?: boolean;
	canResolveOwn: boolean;
}) =>
	resolveDispute(
		"quote",
		"q1",
		"disp1",
		{ resolution: "ReviseAndResend" },
		"org1",
		CTX,
		{ canRefund: true, ...authz },
	);

describe("separation of duties on dispute resolution", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote());
		casLoses();
	});

	it("refuses the dispatcher who opened the dispute", async () => {
		mockFn(db.document_dispute.findFirst).mockResolvedValue(openedBy("d1"));

		const result = await resolveAsD1({
			canConcede: true,
			canResolveOwn: false,
		});

		expect(result).toMatchObject({ forbidden: "self_resolution" });
		// Before the compare-and-swap, so the dispute stays Open for whoever
		// is allowed to close it.
		expect(db.document_dispute.updateMany).not.toHaveBeenCalled();
	});

	it("lets the opener through with resolve_own_disputes", async () => {
		mockFn(db.document_dispute.findFirst).mockResolvedValue(openedBy("d1"));

		const result = await resolveAsD1({
			canConcede: true,
			canResolveOwn: true,
		});

		expect(result).not.toMatchObject({ forbidden: "self_resolution" });
		expect(db.document_dispute.updateMany).toHaveBeenCalled();
	});

	it("lets a different dispatcher resolve it", async () => {
		mockFn(db.document_dispute.findFirst).mockResolvedValue(openedBy("d2"));

		const result = await resolveAsD1({
			canConcede: true,
			canResolveOwn: false,
		});

		expect(result).not.toMatchObject({ forbidden: "self_resolution" });
		expect(db.document_dispute.updateMany).toHaveBeenCalled();
	});

	// A dispute opened by the system (a followup, an import) has no opener to
	// be separated from, and must not become unresolvable.
	it("does not block a dispute with no recorded opener", async () => {
		mockFn(db.document_dispute.findFirst).mockResolvedValue(openedBy(null));

		const result = await resolveAsD1({
			canConcede: true,
			canResolveOwn: false,
		});

		expect(result).not.toMatchObject({ forbidden: "self_resolution" });
		expect(db.document_dispute.updateMany).toHaveBeenCalled();
	});

	// A dropped argument must fail closed: the default is no authority at all.
	it("defaults to refusing self-resolution when no authority is passed", async () => {
		mockFn(db.document_dispute.findFirst).mockResolvedValue(openedBy("d1"));

		const result = await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
		);

		expect(result).toMatchObject({ forbidden: "self_resolution" });
	});
});

describe("concession gate on postResolution", () => {
	const asReq = (permissions: string[], body: Record<string, unknown>) =>
		({
			body,
			user: { organization_id: "org1", role: "dispatcher", permissions },
		}) as unknown as Request;

	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote());
		mockFn(db.document_dispute.findFirst).mockResolvedValue(openedBy("d2"));
		casLoses();
	});

	it("refuses Repeal without concede_disputes", async () => {
		const result = await postResolution(
			"quote",
			"q1",
			"disp1",
			asReq(["resolve_disputes"], {
				resolution: "Repeal",
				note: "goodwill",
			}),
		);

		expect(result).toMatchObject({ forbidden: "concession" });
		// Refused before the compare-and-swap — the dispute stays Open.
		expect(db.document_dispute.updateMany).not.toHaveBeenCalled();
	});

	it("lets Repeal through with concede_disputes", async () => {
		const result = await postResolution(
			"quote",
			"q1",
			"disp1",
			asReq(["resolve_disputes", "concede_disputes"], {
				resolution: "Repeal",
				note: "goodwill",
			}),
		);

		expect(result).not.toMatchObject({ forbidden: "concession" });
		expect(db.quote.findFirst).toHaveBeenCalled();
	});

	// Proves `kind` is actually threaded into outcomeRefusal: the same body and
	// the same permissions are refused on an invoice and allowed on a quote,
	// because only the invoice repeal voids a collectible document.
	it("refuses to repeal an INVOICE without refund_invoices", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue({
			id: "inv1",
			status: "Disputed",
			organization_id: "org1",
			line_items: [],
			amount_paid: 0,
			adjustments: [],
		});
		const result = await postResolution(
			"invoice",
			"inv1",
			"disp1",
			asReq(["resolve_disputes", "concede_disputes"], {
				resolution: "Repeal",
				note: "goodwill",
			}),
		);

		expect(result).toMatchObject({ forbidden: "concession" });
		expect(result).toMatchObject({ err: expect.stringMatching(/void invoices/i) });
		expect(db.document_dispute.updateMany).not.toHaveBeenCalled();
	});

	it("lets Revise & Resend through without concede_disputes", async () => {
		const result = await postResolution(
			"quote",
			"q1",
			"disp1",
			asReq(["resolve_disputes"], { resolution: "ReviseAndResend" }),
		);

		expect(result).not.toMatchObject({ forbidden: "concession" });
		expect(db.quote.findFirst).toHaveBeenCalled();
	});
});

describe("disputeErrorResponse on a refused authority", () => {
	it("maps a self-resolution refusal to its own 403 code", () => {
		const refusal = disputeErrorResponse({
			err: "You opened this dispute.",
			forbidden: "self_resolution",
		});
		expect(refusal.status).toBe(403);
		expect(refusal.body.error?.code).toBe(
			ErrorCodes.SELF_RESOLUTION_FORBIDDEN,
		);
	});

	it("maps a concession refusal to a plain 403", () => {
		const refusal = disputeErrorResponse({
			err: "No permission to Repeal",
			forbidden: "concession",
		});
		expect(refusal.status).toBe(403);
		expect(refusal.body.error?.code).toBe(ErrorCodes.FORBIDDEN);
	});

	// The existing mapping must not shift: a conflict is still 409, a missing
	// document still 404.
	it("leaves the conflict and not-found mappings alone", () => {
		expect(disputeErrorResponse({ err: "x", conflict: true }).status).toBe(
			409,
		);
		expect(disputeErrorResponse({ err: "quote not found" }).status).toBe(
			404,
		);
		expect(disputeErrorResponse({ err: "bad input" }).status).toBe(422);
	});
});

/**
 * A caller who is not a dispatcher would be recorded as no opener at all, which
 * separation of duties reads as a system-opened dispute and waves through for
 * good, and would resolve with no resolver on the audit row (DW-25).
 */
describe("dispute actors must be office staff", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses to open a dispute for a caller who is not a dispatcher", async () => {
		const result = await openDispute(
			"quote",
			"q1",
			{ reason: "scope changed" },
			"org1",
			{ techId: "t1", organizationId: "org1" },
		);

		expect(result).toMatchObject({ forbidden: "not_office_staff" });
		expect(db.document_dispute.create).not.toHaveBeenCalled();
		expect(disputeErrorResponse(result as never).status).toBe(403);
	});

	it("refuses to resolve for a caller who is not a dispatcher", async () => {
		const result = await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			{ techId: "t1", organizationId: "org1" },
			{ canConcede: true, canRefund: true, canResolveOwn: true },
		);

		expect(result).toMatchObject({ forbidden: "not_office_staff" });
		expect(db.document_dispute.updateMany).not.toHaveBeenCalled();
	});
});
