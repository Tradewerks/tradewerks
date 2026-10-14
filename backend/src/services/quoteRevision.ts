import { Prisma } from "../../generated/prisma/client.js";
import { generateQuoteNumber } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import type { UserContext } from "../lib/context.js";
import {
	assertValidQuoteTransition,
	assertValidRequestTransition,
	InvalidTransitionError,
	QUOTE_TRANSITIONS,
} from "../lib/statusTransitions.js";
import type { DocumentShape } from "./disputeAdapters.js";
import { soldJobReason, SOLD_BY_QUOTE_JOBS } from "./disputeAdapters.js";
import { copyDocumentNotes, pick, REVISION_LINE_FIELDS } from "./documentNotes.js";

/**
 * Clones a quote into a fresh Issued revision and marks the original Revised.
 *
 * Reached two ways, deliberately sharing one implementation: a dispute resolved
 * as Revise & Resend, and the standalone Create Revision on a quote that was
 * rejected, expired, issued or approved. Both must produce the same document.
 */
export async function reviseQuote(
	tx: Prisma.TransactionClient,
	doc: DocumentShape,
	organizationId: string,
	context: UserContext,
): Promise<string> {
	const original = await tx.quote.findFirst({ where: { id: doc.id } });
	if (!original) throw new Error("quote not found");

	const lines = await tx.quote_line_item.findMany({
		where: { quote_id: doc.id },
		orderBy: { sort_order: "asc" },
	});

	const now = new Date();
	// A revision must not inherit an already-elapsed validity window.
	const windowMs =
		original.valid_until && original.issued_at
			? original.valid_until.getTime() - original.issued_at.getTime()
			: null;
	// > 0, not truthy: a zero-length window (valid_until === issued_at) would
	// fall through to null and produce a revision that never expires, and a
	// negative one — an original whose valid_until preceded its issue date —
	// would produce a revision born expired.
	const freshValidUntil =
		windowMs != null && windowMs > 0
			? new Date(now.getTime() + windowMs)
			: null;

	const quoteNumber = await generateQuoteNumber(tx, organizationId);

	const replacement = await tx.quote.create({
		data: {
			organization_id: organizationId,
			quote_number: quoteNumber,
			client_id: original.client_id,
			request_id: original.request_id,
			title: original.title,
			description: original.description,
			status: "Issued",
			address: original.address,
			coords: original.coords ?? undefined,
			priority: original.priority,
			version: original.version + 1,
			previous_quote_id: original.id,
			subtotal: original.subtotal,
			tax_rate: original.tax_rate,
			tax_amount: original.tax_amount,
			discount_type: original.discount_type,
			discount_value: original.discount_value,
			discount_amount: original.discount_amount,
			total: original.total,
			// The PDF renders per-group tax lines from the snapshot and falls
			// back to a flat "Tax (tax_rate%)" without it — for a tax-group org
			// tax_rate is 0, so dropping this prints "Tax (0.00%) $45.00".
			tax_snapshot: original.tax_snapshot ?? undefined,
			issued_at: now,
			valid_until: freshValidUntil,
			expires_at: freshValidUntil,
			created_by_dispatcher_id: context.dispatcherId ?? null,
		},
	});

	if (lines.length > 0) {
		await tx.quote_line_item.createMany({
			data: lines.map((li) => ({
				quote_id: replacement.id,
				...pick(li, REVISION_LINE_FIELDS),
			})),
		});
	}

	await copyDocumentNotes(tx, "quote", doc.id, replacement.id, context);

	assertValidQuoteTransition(doc.status, "Revised");
	await tx.quote.update({
		where: { id: doc.id },
		data: { status: "Revised" },
	});

	// Without this the request stays at QuoteApproved, claiming an approved
	// quote that has just been superseded.
	if (doc.request && doc.request.status === "QuoteApproved") {
		assertValidRequestTransition(doc.request.status, "Quoted");
		await tx.request.update({
			where: { id: doc.request.id },
			data: { status: "Quoted" },
		});
	}

	return replacement.id;
}

/**
 * Statuses a quote may be revised from directly: every status whose
 * QUOTE_TRANSITIONS row carries a `→ Revised` edge, minus the ones that edge
 * exists for other reasons. Draft, Sent and Viewed are editable, so superseding
 * a live document the client is still looking at would burn a quote number to
 * change a price. Disputed has its own door — resolving the dispute as Revise &
 * Resend, which also closes the row. Derived from the table so a new edge
 * reaches this gate rather than only reviseQuote's internal re-assert.
 */
const NON_REVISABLE_DESPITE_EDGE = new Set(["Draft", "Sent", "Viewed", "Disputed"]);
const REVISABLE_STATUSES = Object.entries(QUOTE_TRANSITIONS)
	.filter(
		([from, to]) =>
			to.includes("Revised") && !NON_REVISABLE_DESPITE_EDGE.has(from),
	)
	.map(([from]) => from);

export async function createQuoteRevision(
	quoteId: string,
	organizationId: string,
	context: UserContext,
): Promise<
	| { err: string; conflict?: true; notFound?: true }
	| { id: string; quote_number: string }
> {
	const sdb = getScopedDb(organizationId);

	return await sdb.$transaction(async (rawTx) => {
		const tx = rawTx as unknown as Prisma.TransactionClient;

		// Lock the quote before reading it, so the guards below decide against
		// a row nobody else can move. Without this, two concurrent revises both
		// read the same pre-revision status and both pass: generateQuoteNumber's
		// advisory lock serialises the WRITE, so the loser gets a correct quote
		// number and then dies on previous_quote_id's unique index as a P2002 —
		// a 500, when the honest answer is that the quote is already Revised.
		// With the lock the loser blocks here, re-reads Revised, and falls out
		// of REVISABLE_STATUSES as an ordinary 422.
		// organization_id is in the predicate because getScopedDb's extension
		// cannot reach raw SQL: without it a caller in one org can take a row
		// lock on another org's quote for the life of this transaction, even
		// though the scoped findFirst below then correctly refuses to read it.
		await tx.$queryRaw`SELECT id FROM quote WHERE id = ${quoteId} AND organization_id = ${organizationId} FOR UPDATE`;

		const quote = await tx.quote.findFirst({
			where: { id: quoteId, organization_id: organizationId },
			include: {
				job: true,
				request: { include: { jobs: SOLD_BY_QUOTE_JOBS } },
			},
		});
		if (!quote) return { err: "Quote not found", notFound: true };

		if (quote.status === "Disputed") {
			return {
				err: "This quote is under dispute — resolve the dispute and choose Revise & Resend instead.",
			};
		}

		// This door and the dispute path's Revise & Resend outcome both end at
		// reviseQuote, so the two must agree on eligibility. Without this check
		// a quote whose work is already sold (job created from it, or a sibling
		// quote on the request sold as a job) could be superseded here: the job
		// would be left pointing at a Revised document, and the fresh
		// replacement would be sellable a second time.
		const soldReason = soldJobReason(quote as unknown as DocumentShape);
		if (soldReason) {
			return { err: soldReason };
		}

		if (!REVISABLE_STATUSES.includes(quote.status)) {
			return {
				err: `A ${quote.status} quote cannot be revised. Revisions may be created from: ${REVISABLE_STATUSES.join(", ")}.`,
			};
		}

		// reviseQuote re-asserts the transition internally. This catch turns
		// an InvalidTransitionError from that re-assert into a 422 refusal
		// instead of an uncaught 500 leaking e.message —
		// assertValidQuoteTransition throws before either lookup below has run.
		let replacementId: string;
		try {
			replacementId = await reviseQuote(
				tx,
				quote as unknown as DocumentShape,
				organizationId,
				context,
			);
		} catch (e) {
			if (e instanceof InvalidTransitionError) return { err: e.message };
			// Belt-and-braces behind the row lock above. previous_quote_id is
			// @unique, so a revision that somehow raced past the guards lands
			// here rather than on the error handler: the same refusal the
			// guards produce has to surface as the same 4xx, not a 500.
			if (
				e instanceof Prisma.PrismaClientKnownRequestError &&
				e.code === "P2002"
			) {
				return {
					err: "This quote has already been revised.",
					conflict: true,
				};
			}
			throw e;
		}

		const replacement = await tx.quote.findFirst({
			where: { id: replacementId },
			select: { id: true, quote_number: true },
		});
		return {
			id: replacementId,
			quote_number: replacement?.quote_number ?? "",
		};
	});
}
