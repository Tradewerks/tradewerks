import { describe, it, expect, vi, beforeEach } from "vitest";

// Built via vi.hoisted (not a plain module-scope require, which vitest's ESM mock
// factories can't resolve) so both the db.js and lib/context.js mocks below share
// the exact same mock instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: {
			findFirst: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
		},
		quote_note: { deleteMany: vi.fn() },
		quote_line_item: { deleteMany: vi.fn() },
		request: { update: vi.fn() },
		document_dispute: { findFirst: vi.fn() },
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

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { db } from "../../db.js";
import { updateQuote, deleteQuote } from "../quotesController.js";
import type { Request } from "express";

const TERMINAL = ["Cancelled", "Rejected", "Revised"] as const;

// updateQuote's real signature is (req: Request, organizationId: string, context?: UserContext) —
// it reads quoteId from req.params.id and the patch from req.body, not the (id, {body}, orgId)
// shape the plan assumed. It also always returns an `err` key ("" on success, a message on
// failure), never omitting it, so success is asserted via a falsy `err` rather than the key's
// absence.
const makeReq = (body: Record<string, unknown>) =>
	({ params: { id: "q1" }, body } as unknown as Request);

describe("updateQuote terminal guard", () => {
	beforeEach(() => vi.clearAllMocks());

	for (const status of TERMINAL) {
		it(`refuses to modify a ${status} quote`, async () => {
			(db.quote.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
				id: "q1",
				status,
				quote_number: "Q-1001",
				line_items: [],
			});

			const result = await updateQuote(makeReq({ title: "new title" }), "org1");

			expect(result.err).toBeTruthy();
			expect(db.quote.update as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
		});
	}

	it("still allows editing a Sent quote", async () => {
		(db.quote.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
			id: "q1",
			status: "Sent",
			quote_number: "Q-1001",
			line_items: [],
		});
		(db.quote.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "q1" });

		const result = await updateQuote(makeReq({ title: "ok" }), "org1");

		expect(result.err).toBeFalsy();
	});
});

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const aSentQuote = (over: Record<string, unknown> = {}) => ({
	id: "q1",
	status: "Sent",
	quote_number: "Q-1001",
	request_id: "r1",
	line_items: [],
	...over,
});

/**
 * Rejected means the client declined; Cancelled means we withdrew it. The
 * funnel counts both as lost, but only Rejected is a fact about the client, so
 * only Rejected pushes the linked request to QuoteRejected. Swapping the two
 * branches in updateQuote's request sync is a one-character mistake that would
 * corrupt the request pipeline while every quote-status report still agreed.
 */
describe("quote reject vs cancel", () => {
	beforeEach(() => vi.clearAllMocks());

	it("rejecting stamps rejected_at, keeps the reason, and pushes the request", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aSentQuote());
		mockFn(db.quote.update).mockResolvedValue({ id: "q1", request_id: "r1" });

		const result = await updateQuote(
			makeReq({ status: "Rejected", rejection_reason: "Too expensive" }),
			"org1",
		);

		expect(result.err).toBeFalsy();
		const written = mockFn(db.quote.update).mock.calls[0][0].data;
		expect(written.status).toBe("Rejected");
		expect(written.rejection_reason).toBe("Too expensive");
		expect(written.rejected_at).toBeInstanceOf(Date);
		expect(mockFn(db.request.update)).toHaveBeenCalledWith({
			where: { id: "r1" },
			data: { status: "QuoteRejected" },
		});
	});

	it("cancelling keeps the reason but leaves the request alone", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aSentQuote());
		mockFn(db.quote.update).mockResolvedValue({ id: "q1", request_id: "r1" });

		const result = await updateQuote(
			makeReq({ status: "Cancelled", rejection_reason: "We withdrew it" }),
			"org1",
		);

		expect(result.err).toBeFalsy();
		const written = mockFn(db.quote.update).mock.calls[0][0].data;
		expect(written.status).toBe("Cancelled");
		expect(written.rejection_reason).toBe("We withdrew it");
		// Not a client decision, so rejected_at must stay unset.
		expect(written.rejected_at).toBeUndefined();
		expect(mockFn(db.request.update)).not.toHaveBeenCalled();
	});

	// Disputed → Cancelled is a legal transition, so nothing in the table stops
	// Cancel Quote from stranding an open dispute: resolveDispute requires the
	// quote to still be Disputed and Cancelled is terminal, so the row could
	// never be closed and it holds the one-open-dispute index forever.
	it("refuses a status change while a dispute is open", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aSentQuote({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue({ id: "disp1" });

		const result = await updateQuote(
			makeReq({ status: "Cancelled", rejection_reason: "second thoughts" }),
			"org1",
		);

		expect(result.err).toContain("open dispute");
		expect(mockFn(db.quote.update)).not.toHaveBeenCalled();
	});

	// The guard is scoped to status changes: an open dispute must not freeze
	// ordinary edits like retitling, which the dispute is often about.
	it("allows a non-status edit while a dispute is open", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aSentQuote({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue({ id: "disp1" });
		mockFn(db.quote.update).mockResolvedValue({ id: "q1" });

		const result = await updateQuote(makeReq({ title: "clarified" }), "org1");

		expect(result.err).toBeFalsy();
		expect(mockFn(db.document_dispute.findFirst)).not.toHaveBeenCalled();
	});
});

/**
 * document_dispute.quote_id is ON DELETE CASCADE, so deleting the quote takes
 * the dispute's reason, contested lines, resolution and actors with it. The
 * quote.deleted log row carries none of that, and spec §12 makes the audit
 * trail the only mitigation for a single dispatcher repealing on their own.
 */
describe("deleteQuote dispute-history guard", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses to delete a quote that has dispute history", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue({
			id: "q1",
			status: "Cancelled",
			quote_number: "Q-1001",
			job: null,
		});
		mockFn(db.document_dispute.findFirst).mockResolvedValue({ id: "disp1" });

		const result = await deleteQuote("q1", "org1");

		expect(result.err).toContain("dispute history");
		expect(mockFn(db.$transaction)).not.toHaveBeenCalled();
	});

	it("still deletes a quote with no dispute history", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue({
			id: "q1",
			status: "Draft",
			quote_number: "Q-1001",
			job: null,
		});
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const result = await deleteQuote("q1", "org1");

		expect(result.err).toBeFalsy();
		expect(mockFn(db.quote.delete)).toHaveBeenCalledWith({
			where: { id: "q1" },
		});
	});

	// replacement_quote_id is ON DELETE RESTRICT (D6), so without this refusal
	// the delete would surface as a raw constraint violation.
	it("refuses to delete a quote a dispute resolution produced", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue({
			id: "q2",
			status: "Issued",
			quote_number: "Q-1002",
			job: null,
		});
		mockFn(db.document_dispute.findFirst).mockResolvedValue({
			id: "disp1",
			replacement_quote_id: "q2",
		});

		const result = await deleteQuote("q2", "org1");

		expect(mockFn(db.document_dispute.findFirst)).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { OR: [{ quote_id: "q2" }, { replacement_quote_id: "q2" }] },
			}),
		);
		expect(result.err).toBe(
			"This quote was produced by a dispute resolution and is part of its audit trail. Cancel it instead.",
		);
		expect(mockFn(db.$transaction)).not.toHaveBeenCalled();
	});
});
