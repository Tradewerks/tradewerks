import { describe, it, expect, vi, beforeEach } from "vitest";

// Built via vi.hoisted (not a plain module-scope require, which vitest's ESM mock
// factories can't resolve) so both the db.js and lib/context.js mocks below share
// the exact same mock instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
		quote_line_item: { findMany: vi.fn(), createMany: vi.fn() },
		// Default impl survives vi.clearAllMocks (which clears calls, not
		// implementations), so every revise test gets an empty note list.
		quote_note: {
			findMany: vi.fn(async () => []),
			createMany: vi.fn(),
		},
		document_dispute: {
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		request: { update: vi.fn() },
		$executeRaw: vi.fn(),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateQuoteNumber: vi.fn(async () => "Q-1002"),
}));

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
import { openDispute, resolveDispute } from "../../services/disputeService.js";
import { postResolution } from "../disputesController.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { DocumentRuleError } from "../../lib/statusTransitions.js";
import { logActivity } from "../../services/logger.js";

const CTX = { dispatcherId: "d1", organizationId: "org1" };
const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
/** Every grant but self-resolution: these suites test the outcomes, not the
 *  authority gates, which disputes.authz.test.ts and the parity matrix cover. */
const AUTHZ = { canConcede: true, canRefund: true, canResolveOwn: false };

function aQuote(overrides: Record<string, unknown> = {}) {
	return {
		id: "q1",
		quote_number: "Q-1001",
		status: "Sent",
		organization_id: "org1",
		client_id: "c1",
		request_id: "r1",
		title: "Rooftop unit",
		description: "",
		address: "1 Main St",
		coords: null,
		priority: "Medium",
		version: 1,
		subtotal: 100,
		tax_rate: 0,
		tax_amount: 0,
		discount_type: null,
		discount_value: null,
		discount_amount: null,
		total: 100,
		tax_snapshot: { groups: [{ name: "State", total_tax_cents: 600 }] },
		issued_at: new Date("2026-08-01T00:00:00Z"),
		valid_until: new Date("2026-08-31T00:00:00Z"),
		job: null,
		request: { id: "r1", status: "Quoted" },
		line_items: [
			{ id: "li1", name: "Compressor", total: 450 },
			{ id: "li2", name: "Labor", total: 150 },
		],
		...overrides,
	};
}

function anOpenDispute(overrides: Record<string, unknown> = {}) {
	return {
		id: "disp1",
		status: "Open",
		document_kind: "quote",
		quote_id: "q1",
		status_at_open: "Sent",
		...overrides,
	};
}

describe("openDispute on a quote", () => {
	beforeEach(() => vi.clearAllMocks());

	it("rejects a status that cannot be disputed", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Draft" }),
		);

		const result = await openDispute(
			"quote",
			"q1",
			{ reason: "too high" },
			"org1",
			CTX,
		);

		expect(result).toHaveProperty("err");
		expect(db.document_dispute.create).not.toHaveBeenCalled();
	});

	/**
	 * The status is named as it appears on the badge, with an agreeing article —
	 * the old copy read "A Issued quote" the moment Issued became reachable here.
	 */
	it("names the statuses that work, with an article that agrees", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote({ status: "Draft" }));

		const result = await openDispute(
			"quote",
			"q1",
			{ reason: "too high" },
			"org1",
			CTX,
		);

		expect(result).toHaveProperty(
			"err",
			"A Draft quote can't be disputed. Disputes may be opened from: Created, Sent, Viewed, Approved.",
		);
	});

	/**
	 * Mark as Issued is the hand-delivery door: the dispatcher printed the quote
	 * and gave it to the client, so the client can contest it. Approve, Reject,
	 * Create Revision and Convert to Job are all already offered from Issued.
	 */
	it("opens a dispute on a hand-delivered quote", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote({ status: "Issued" }));
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.document_dispute.create).mockImplementation(
			({ data }: { data: Record<string, unknown> }) => ({
				id: "disp1",
				...data,
			}),
		);

		const result = await openDispute(
			"quote",
			"q1",
			{ reason: "priced above the walk-in estimate" },
			"org1",
			CTX,
		);

		expect(result).not.toHaveProperty("err");
		expect(
			mockFn(db.document_dispute.create).mock.calls[0][0].data.status_at_open,
		).toBe("Issued");
		expect(mockFn(db.quote.update).mock.calls[0][0].data.status).toBe("Disputed");
	});

	it("rejects a second open dispute on the same document", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote());
		mockFn(db.document_dispute.findFirst).mockResolvedValue({
			id: "existing",
			status: "Open",
		});

		const result = await openDispute(
			"quote",
			"q1",
			{ reason: "again" },
			"org1",
			CTX,
		);

		expect(result).toHaveProperty("err");
		expect(db.document_dispute.create).not.toHaveBeenCalled();
	});

	it("rejects contested ids that do not belong to the document", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote());
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);

		const result = await openDispute(
			"quote",
			"q1",
			{ reason: "line 3", contested_line_item_ids: ["not-mine"] },
			"org1",
			CTX,
		);

		expect(result).toHaveProperty("err");
	});

	// DW-69: a bare id rots the moment the line it names is deleted — and a
	// quote line has no lock against that, unlike an invoice's once issued.
	// Snapshotting name/total here means the record still means something
	// after the line is gone.
	it("snapshots the contested lines' name and total, not just their ids", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote());
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.document_dispute.create).mockImplementation(
			({ data }: { data: Record<string, unknown> }) => ({
				id: "disp1",
				...data,
			}),
		);

		await openDispute(
			"quote",
			"q1",
			{ reason: "line 1 is wrong", contested_line_item_ids: ["li1"] },
			"org1",
			CTX,
		);

		const written = mockFn(db.document_dispute.create).mock.calls[0][0]
			.data.contested_line_item_ids;
		expect(written).toEqual([{ id: "li1", name: "Compressor", total: 450 }]);
	});

	it("records status_at_open, the actor and the document link", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Approved" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.document_dispute.create).mockImplementation(
			({ data }: { data: Record<string, unknown> }) => ({
				id: "disp1",
				...data,
			}),
		);

		await openDispute(
			"quote",
			"q1",
			{ reason: "scope changed" },
			"org1",
			CTX,
		);

		const created = mockFn(db.document_dispute.create).mock.calls[0][0]
			.data;
		expect(created.status_at_open).toBe("Approved");
		expect(created.opened_by_dispatcher_id).toBe("d1");
		expect(created.opened_at).toBeInstanceOf(Date);
		expect(created.document_kind).toBe("quote");
		expect(created.quote_id).toBe("q1");
		expect(mockFn(db.quote.update).mock.calls[0][0].data.status).toBe(
			"Disputed",
		);
	});

	it("names the quote by number on its feed row", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(aQuote({ status: "Sent" }));
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.document_dispute.create).mockImplementation(
			({ data }: { data: Record<string, unknown> }) => ({ id: "disp1", ...data }),
		);

		await openDispute("quote", "q1", { reason: "scope changed" }, "org1", CTX);

		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "quote.dispute_opened",
				changes: expect.objectContaining({
					_quote_number: { old: null, new: "Q-1001" },
				}),
			}),
		);
	});
});

describe("resolveDispute on a quote", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns a conflict when the dispute was already resolved", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 0 });

		const result = await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "Repeal", note: "client walked" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
	});

	it("allows only Repeal once a job exists", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Disputed", job: { id: "j1" } }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		const result = await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect(db.quote.create).not.toHaveBeenCalled();
	});

	// D9: a sibling quote on the same request already became the job. Cloning
	// this one would offer work that is already sold.
	it("allows only Repeal once a sibling quote on the request became the job", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({
				status: "Disputed",
				job: null,
				request: {
					id: "r1",
					status: "ConvertedToJob",
					jobs: [
						{
							id: "j9",
							job_number: "J-0009",
							quote_id: "q-sibling",
						},
					],
				},
			}),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		const result = await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect((result as { err: string }).err).toContain(
			"already sold as a job",
		);
		expect(db.quote.create).not.toHaveBeenCalled();
	});

	/**
	 * A converted request is not by itself proof this quote's work was sold.
	 * A request converted straight to a job — the tech fixed something on site,
	 * no quote in the path — leaves a follow-on quote for DIFFERENT work still
	 * live, and it must stay revisable. The evidence that matters is a job
	 * derived from a quote, which is what `jobs` carries.
	 */
	it("still allows Revise & Resend when the request's job came from no quote", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({
				status: "Disputed",
				job: null,
				request: { id: "r1", status: "ConvertedToJob", jobs: [] },
			}),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.quote_line_item.findMany).mockResolvedValue([]);
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1002",
		});

		await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(db.quote.create).toHaveBeenCalled();
	});

	/**
	 * This quote's OWN job appears in the request's quote-derived jobs too. The
	 * sibling branch must exclude it, or the dispatcher reads that some other
	 * quote sold the work when it was this one.
	 */
	it("names this quote's own job rather than a sibling when they are the same job", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({
				status: "Disputed",
				job: { id: "j1" },
				request: {
					id: "r1",
					status: "ConvertedToJob",
					jobs: [{ id: "j1", job_number: "J-0001", quote_id: "q1" }],
				},
			}),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);

		const result = await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect((result as { err: string }).err).toContain(
			"job was created from this quote",
		);
		expect(db.quote.create).not.toHaveBeenCalled();
	});

	it("still allows Revise & Resend when the request has not been converted", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({
				status: "Disputed",
				request: { id: "r1", status: "Quoted" },
			}),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.quote_line_item.findMany).mockResolvedValue([]);
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1002",
		});

		await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(db.quote.create).toHaveBeenCalled();
	});

	it("Repeal cancels the quote and stores the note", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });

		await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "Repeal", note: "duplicate of Q-1000" },
			"org1",
			CTX,
			AUTHZ,
		);

		const update = mockFn(db.quote.update).mock.calls[0][0];
		expect(update.data.status).toBe("Cancelled");
		expect(update.data.rejection_reason).toBe("duplicate of Q-1000");

		// The compare-and-swap and the audit row it writes (DW-23).
		const claim = mockFn(db.document_dispute.updateMany).mock.calls[0][0];
		expect(claim.where).toEqual({ id: "disp1", status: "Open" });
		expect(claim.data).toMatchObject({
			status: "Resolved",
			resolution: "Repeal",
			resolution_note: "duplicate of Q-1000",
			resolved_by_dispatcher_id: "d1",
		});
		expect(claim.data.resolved_at).toBeInstanceOf(Date);
	});

	it("Revise & Resend clones the quote and supersedes the original", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({
				status: "Disputed",
				request: { id: "r1", status: "QuoteApproved" },
			}),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.quote_line_item.findMany).mockResolvedValue([
			{
				id: "li1",
				name: "Compressor",
				description: null,
				quantity: 1,
				unit_price: 100,
				total: 100,
				item_type: null,
				sort_order: 0,
				tax_group_id: null,
				taxable: true,
				tax_amount: null,
				inventory_item_id: null,
			},
		]);
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1002",
		});

		await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		const created = mockFn(db.quote.create).mock.calls[0][0].data;
		expect(created.version).toBe(2);
		expect(created.previous_quote_id).toBe("q1");
		expect(created.status).toBe("Issued");

		const originalUpdate = mockFn(db.quote.update).mock.calls[0][0];
		expect(originalUpdate.data.status).toBe("Revised");

		// Without this the request stays at QuoteApproved, claiming an
		// approved quote that has just been superseded.
		expect(db.request.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "Quoted" } }),
		);

		expect(db.quote_line_item.createMany).toHaveBeenCalled();
	});

	// Without the snapshot the client-facing PDF falls back to a flat
	// "Tax (tax_rate%)" line, which reads 0% for any org using tax groups.
	it("carries the tax snapshot onto the replacement", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.quote_line_item.findMany).mockResolvedValue([]);
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1002",
		});

		await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		const created = mockFn(db.quote.create).mock.calls[0][0].data;
		expect(created.tax_snapshot).toEqual({
			groups: [{ name: "State", total_tax_cents: 600 }],
		});
	});

	it("gives the replacement a fresh validity window", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.quote_line_item.findMany).mockResolvedValue([]);
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1002",
		});

		await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		const created = mockFn(db.quote.create).mock.calls[0][0].data;
		expect(created.valid_until.getTime()).toBeGreaterThan(Date.now());
	});

	// The PDF renders note content and nothing else, so dropping the notes
	// silently deletes client-facing text from the replacement.
	it("carries the notes onto the replacement without claiming authorship", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Disputed" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.quote_line_item.findMany).mockResolvedValue([]);
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1002",
		});
		mockFn(db.quote_note.findMany).mockResolvedValue([
			{
				id: "n1",
				content: "Includes crane hire",
				organization_id: "org1",
				creator_dispatcher_id: "d9",
			},
		]);

		await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "ReviseAndResend" },
			"org1",
			CTX,
			AUTHZ,
		);

		const copied = mockFn(db.quote_note.createMany).mock.calls[0][0].data;
		expect(copied).toHaveLength(1);
		expect(copied[0].quote_id).toBe("q2");
		expect(copied[0].content).toBe("Includes crane hire");
		expect(copied[0].creator_dispatcher_id).toBe("d1");
	});
});

// Cancelling a Disputed quote leaves the dispute Open, so the banner still
// offers Resolve on a cancelled quote. assertValidQuoteTransition short-circuits
// on from === to, so Repeal would sail past ("Cancelled" → "Cancelled") and
// overwrite the rejection_reason of an already-dead quote.
describe("quote that moved out of Disputed under an open dispute", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses Repeal instead of rewriting a cancelled quote's reason", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Cancelled" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });

		const result = await resolveDispute(
			"quote",
			"q1",
			"disp1",
			{ resolution: "Repeal", note: "second thoughts" },
			"org1",
			CTX,
			AUTHZ,
		);

		expect(result).toHaveProperty("err");
		expect((result as { err: string }).err).toContain("no longer Disputed");
		expect(db.quote.update).not.toHaveBeenCalled();
		// The dispute stays Open — the dispatcher gets to retry once they look.
		expect(db.document_dispute.updateMany).not.toHaveBeenCalled();
	});
});

// The document can move underneath an open dispute — Cancel Quote is legal from
// Disputed — and the banner is still on screen offering Revise & Resend. The
// modal has to be able to render the refusal, so it must not be a 500.
describe("postResolution error mapping", () => {
	beforeEach(() => vi.clearAllMocks());

	const reqFor = (body: unknown) =>
		({
			body,
			user: { organization_id: "org1", uid: "d1", role: "dispatcher" },
			params: {},
			headers: {},
		}) as never;

	it("returns { err } instead of throwing when the transition is refused", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(
			aQuote({ status: "Cancelled" }),
		);
		mockFn(db.document_dispute.findFirst).mockResolvedValue(
			anOpenDispute(),
		);
		mockFn(db.document_dispute.updateMany).mockResolvedValue({ count: 1 });
		mockFn(db.quote_line_item.findMany).mockResolvedValue([]);
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1002",
		});

		const result = await postResolution(
			"quote",
			"q1",
			"disp1",
			reqFor({ resolution: "ReviseAndResend" }),
		);

		expect(result).toHaveProperty("err");
		expect((result as { err: string }).err).toContain(
			"no longer Disputed",
		);
	});

	it("still maps a schema failure to { err }", async () => {
		const result = await postResolution(
			"quote",
			"q1",
			"disp1",
			reqFor({ resolution: "Repeal" }),
		);

		expect(result).toHaveProperty("err");
	});

	// The over-credit ceiling and the void re-asserts are rules, not faults: a
	// working money guard must not page on-call as a 5xx (DW-11).
	it("maps a document rule to { err } instead of throwing", async () => {
		mockFn(db.quote.findFirst).mockRejectedValueOnce(
			new DocumentRuleError("A rule refused this write."),
		);

		const result = await postResolution(
			"quote",
			"q1",
			"disp1",
			reqFor({ resolution: "ReviseAndResend" }),
		);

		expect(result).toEqual({ err: "A rule refused this write." });
	});

	// Resolving inserts no dispute row, so a unique violation there is a
	// replacement losing a numbering race — not an open dispute (DW-27).
	it("does not blame an open dispute for a unique violation while resolving", async () => {
		mockFn(db.quote.findFirst).mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
				code: "P2002",
				clientVersion: "7",
				meta: { target: ["quote_number"] },
			}),
		);

		const result = await postResolution(
			"quote",
			"q1",
			"disp1",
			reqFor({ resolution: "ReviseAndResend" }),
		);

		expect(result).toMatchObject({ conflict: true });
		expect((result as { err: string }).err).not.toContain("open dispute");
	});
});
