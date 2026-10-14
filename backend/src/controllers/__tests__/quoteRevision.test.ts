import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
		quote_line_item: {
			findMany: vi.fn(async () => []),
			createMany: vi.fn(),
		},
		quote_note: { findMany: vi.fn(async () => []), createMany: vi.fn() },
		request: { update: vi.fn() },
		// createQuoteRevision takes SELECT … FOR UPDATE on the quote before it
		// reads it, so the guards decide against a row nobody else can move.
		$queryRaw: vi.fn(async () => []),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateQuoteNumber: vi.fn(async () => "Q-1043"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

// Wraps assertValidQuoteTransition in a spy that still delegates to the real
// rule table by default (every other test needs the genuine Rejected/Issued/
// Approved/Expired → Revised behavior), so exactly one test below can force it
// to throw and exercise createQuoteRevision's InvalidTransitionError catch.
vi.mock("../../lib/statusTransitions.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../lib/statusTransitions.js")>();
	return {
		...actual,
		assertValidQuoteTransition: vi.fn(actual.assertValidQuoteTransition),
	};
});

import { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { createQuoteRevision } from "../../services/quoteRevision.js";
import {
	assertValidQuoteTransition,
	InvalidTransitionError,
} from "../../lib/statusTransitions.js";

const CTX = { dispatcherId: "d1", organizationId: "org1" };
const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

function aQuote(overrides: Record<string, unknown> = {}) {
	return {
		id: "q1",
		quote_number: "Q-1042",
		status: "Rejected",
		organization_id: "org1",
		client_id: "c1",
		request_id: null,
		title: "Rooftop unit replacement",
		description: null,
		address: null,
		coords: null,
		priority: null,
		version: 1,
		subtotal: 500,
		tax_rate: 0,
		tax_amount: 0,
		discount_type: null,
		discount_value: null,
		discount_amount: null,
		total: 500,
		tax_snapshot: null,
		issued_at: new Date("2026-09-01"),
		valid_until: new Date("2026-09-15"),
		line_items: [],
		job: null,
		request: null,
		...overrides,
	};
}

// A successful revision drives db.quote.findFirst three times in sequence:
// createQuoteRevision's own load, reviseQuote's internal re-load of the same
// row, and the replacement lookup at the end. A single shared mockResolvedValue
// would hand the ORIGINAL's quote_number back to that final lookup, failing
// the Q-1043 assertion — so success cases queue three values with
// mockResolvedValueOnce instead.
function queueSuccessfulLookup(quote: Record<string, unknown>) {
	mockFn(db.quote.findFirst)
		.mockResolvedValueOnce(quote)
		.mockResolvedValueOnce(quote)
		.mockResolvedValueOnce({ id: "q2", quote_number: "Q-1043" });
}

describe("createQuoteRevision", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.quote.create).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1043",
		});
	});

	it("revises a rejected quote, superseding the original", async () => {
		queueSuccessfulLookup(aQuote({ status: "Rejected" }));

		const result = await createQuoteRevision("q1", "org1", CTX);

		expect(result).toEqual({ id: "q2", quote_number: "Q-1043" });
		const created = mockFn(db.quote.create).mock.calls[0][0].data;
		expect(created.previous_quote_id).toBe("q1");
		expect(created.version).toBe(2);
		expect(created.status).toBe("Issued");
		const superseded = mockFn(db.quote.update).mock.calls.find(
			(c: [{ data: { status?: string } }]) =>
				c[0].data.status === "Revised",
		);
		expect(superseded).toBeTruthy();
	});

	/**
	 * The guards read the quote's status, so they are only sound if nothing can
	 * move the row between the read and the write. Without the lock, two
	 * concurrent revises both pass and the loser dies on previous_quote_id's
	 * unique index as a P2002 500. The lock must be taken BEFORE the read, and
	 * must carry organization_id: getScopedDb's extension cannot reach raw SQL,
	 * so without it one org can lock another org's row.
	 */
	it("locks the quote before reading it, scoped to the org", async () => {
		queueSuccessfulLookup(aQuote({ status: "Rejected" }));

		await createQuoteRevision("q1", "org1", CTX);

		const raw = mockFn(db.$queryRaw);
		expect(raw).toHaveBeenCalled();
		const sql = raw.mock.calls[0][0].join("?");
		expect(sql).toMatch(/FOR UPDATE/);
		expect(sql).toMatch(/organization_id/);
		expect(raw.mock.calls[0].slice(1)).toEqual(["q1", "org1"]);
		// Taken first: a lock after the read would protect nothing.
		expect(raw.mock.invocationCallOrder[0]).toBeLessThan(
			mockFn(db.quote.findFirst).mock.invocationCallOrder[0],
		);
	});

	/**
	 * Behind the lock this should be unreachable, but previous_quote_id is
	 * @unique and a lost race is the caller's answer, not a server fault: it
	 * has to read as a conflict rather than escape to the error handler.
	 */
	it("reports a raced revision as a conflict, not a 500", async () => {
		// Exactly the two lookups this path reaches — createQuoteRevision's own
		// load and reviseQuote's re-load. queueSuccessfulLookup would queue a
		// third for the post-create replacement fetch, which the throw below
		// never consumes, leaving it to leak into the next test.
		const raced = aQuote({ status: "Rejected" });
		mockFn(db.quote.findFirst)
			.mockResolvedValueOnce(raced)
			.mockResolvedValueOnce(raced);
		mockFn(db.quote.create).mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("Unique constraint", {
				code: "P2002",
				clientVersion: "test",
			}),
		);

		const result = await createQuoteRevision("q1", "org1", CTX);

		expect(result).toEqual({
			err: "This quote has already been revised.",
			conflict: true,
		});
	});

	it.each(["Issued", "Approved", "Expired"])(
		"revises a %s quote",
		async (status) => {
			queueSuccessfulLookup(aQuote({ status }));

			const result = await createQuoteRevision("q1", "org1", CTX);

			expect(result).toEqual({ id: "q2", quote_number: "Q-1043" });
		},
	);

	it.each(["Draft", "Sent", "Viewed", "Cancelled", "Revised"])(
		"refuses a %s quote and names the statuses that work",
		async (status) => {
			mockFn(db.quote.findFirst).mockResolvedValueOnce(
				aQuote({ status }),
			);

			const result = await createQuoteRevision("q1", "org1", CTX);

			expect(result.err).toContain(status);
			expect(db.quote.create).not.toHaveBeenCalled();
		},
	);

	/**
	 * A disputed quote has its own revision door — the dispute's Revise &
	 * Resend outcome, which also closes the dispute row. Coming in here would
	 * supersede the document and strand the dispute Open.
	 */
	it("sends a disputed quote back to its dispute", async () => {
		mockFn(db.quote.findFirst).mockResolvedValueOnce(
			aQuote({ status: "Disputed" }),
		);

		const result = await createQuoteRevision("q1", "org1", CTX);

		expect(result.err).toContain("dispute");
		expect(db.quote.create).not.toHaveBeenCalled();
	});

	/**
	 * The dispute path's Revise & Resend outcome gates on soldJobReason —
	 * once a job exists, the quote is no longer the live document. This door
	 * must refuse the same way, or a job-linked quote could be superseded
	 * here while the job keeps pointing at it.
	 */
	it("refuses a quote that already has a job", async () => {
		mockFn(db.quote.findFirst).mockResolvedValueOnce(
			aQuote({ status: "Approved", job: { id: "j1" } }),
		);

		const result = await createQuoteRevision("q1", "org1", CTX);

		expect(result.err).toContain("job was created");
		expect(db.quote.create).not.toHaveBeenCalled();
	});

	/**
	 * A sibling quote on the same request converting it to a job means the
	 * work is already sold, even though THIS quote has no job of its own.
	 */
	it("refuses a quote whose request was sold through a sibling quote", async () => {
		mockFn(db.quote.findFirst).mockResolvedValueOnce(
			aQuote({
				status: "Approved",
				request_id: "r1",
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

		const result = await createQuoteRevision("q1", "org1", CTX);

		expect(result.err).toContain("already sold as a job");
		expect(db.quote.create).not.toHaveBeenCalled();
	});

	/**
	 * Both doors agree, so this door needs the same distinction the dispute
	 * path draws: a request converted straight to a job sold nothing this quote
	 * offers, and a follow-on quote against it stays revisable.
	 */
	it("revises a quote whose request holds a job that came from no quote", async () => {
		queueSuccessfulLookup(
			aQuote({
				status: "Approved",
				request_id: "r1",
				request: { id: "r1", status: "ConvertedToJob", jobs: [] },
			}),
		);

		const result = await createQuoteRevision("q1", "org1", CTX);

		expect(result).toEqual({ id: "q2", quote_number: "Q-1043" });
		expect(db.quote.create).toHaveBeenCalled();
	});

	it("reports a missing quote as not found", async () => {
		mockFn(db.quote.findFirst).mockResolvedValueOnce(null);

		const result = await createQuoteRevision("nope", "org1", CTX);

		expect(result.err).toContain("not found");
	});

	it("moves an approved-quote request back to Quoted", async () => {
		queueSuccessfulLookup(
			aQuote({
				status: "Approved",
				request_id: "r1",
				request: { id: "r1", status: "QuoteApproved" },
			}),
		);

		await createQuoteRevision("q1", "org1", CTX);

		expect(db.request.update).toHaveBeenCalledWith({
			where: { id: "r1" },
			data: { status: "Quoted" },
		});
	});

	/**
	 * REVISABLE_STATUSES is derived from QUOTE_TRANSITIONS' `→ Revised` edges,
	 * but reviseQuote still re-asserts the transition internally. If that
	 * re-assert throws InvalidTransitionError, it must come back as a
	 * 422-mappable refusal, not an uncaught 500 leaking the raw error message.
	 */
	it("returns a refusal instead of throwing when reviseQuote's internal transition assert fails", async () => {
		queueSuccessfulLookup(aQuote({ status: "Rejected" }));
		mockFn(assertValidQuoteTransition).mockImplementationOnce(() => {
			throw new InvalidTransitionError("Rejected", "Revised");
		});

		const result = await createQuoteRevision("q1", "org1", CTX);

		expect(result.err).toBe(
			"Invalid status transition: Rejected → Revised",
		);
		expect(db.quote.update).not.toHaveBeenCalled();
	});
});
