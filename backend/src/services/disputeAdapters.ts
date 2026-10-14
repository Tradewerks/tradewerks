import type { Prisma } from "../../generated/prisma/client.js";
import { formatCurrency } from "../lib/money.js";

export type DisputeKind = "quote" | "invoice";
export type Outcome = "ReviseAndResend" | "IssueAdjustment" | "Repeal";

// Ruling P11: disabled-outcome copy must be byte-identical to the frontend's, hence formatCurrency

/**
 * Money, not status, decides whether an invoice may be voided — so the rule and
 * its sentence live here, exported, rather than being restated by every caller.
 * `updateInvoice` is the second caller: the kebab's Void reaches the same
 * decision the dispute outcomes do.
 */
export function voidBlockedByPaymentReason(amountPaid: number): string | null {
	if (!(amountPaid > 0)) return null;
	return `This invoice has ${formatCurrency(amountPaid)} applied. Issue an adjustment instead — voiding would strand the payment.`;
}

/**
 * An adjustment is a standalone Issued invoice that AR and job profitability
 * read by its own status, so voiding the invoice it adjusts leaves the credit
 * live against a dead parent. Both void doors — Repeal, and the kebab's Void in
 * updateInvoice — refuse while one is live and name it, so the dispatcher voids
 * the credit as a deliberate act first (D1).
 */
export function voidBlockedByAdjustmentReason(
	adjustments: readonly { invoice_number: string }[],
): string | null {
	const numbers = adjustments.map((a) => a.invoice_number);
	if (numbers.length === 0) return null;
	if (numbers.length === 1) {
		return `${numbers[0]} adjusts this invoice. Void ${numbers[0]} first, then void this one.`;
	}
	const list = `${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
	return `${list} adjust this invoice. Void them first, then void this one.`;
}

/** The adjustments that still count. A voided one credits nothing. */
export const LIVE_ADJUSTMENTS = {
	where: { status: { not: "Void" } },
	select: { id: true, invoice_number: true },
} as const;

/**
 * A contested line as stored on the dispute row — a snapshot taken when the
 * dispute opened, not a live id. The line itself can be deleted later (quotes
 * have no lock against it once Issued, unlike invoices), and a bare id would
 * then resolve to nothing: no name, no amount, just a dangling reference.
 */
export interface ContestedLine {
	id: string;
	name: string;
	total: number;
}

export interface DocumentShape {
	id: string;
	status: string;
	organization_id: string | null;
	line_items: { id: string; name: string; total: unknown }[];
	/** findFirst returns every scalar column; the feed row names the document by these. */
	quote_number?: string;
	invoice_number?: string;
	// quote only
	job?: { id: string } | null;
	/**
	 * `jobs` holds the request's QUOTE-DERIVED jobs only — the evidence that a
	 * quote on this request has already been sold. The request's own status
	 * cannot answer that: a request converted straight to a job (a tech's
	 * on-site fix, no quote in the path) reads ConvertedToJob while every quote
	 * hanging off it is still unsold work.
	 */
	request?: {
		id: string;
		status: string;
		jobs?: { id: string; quote_id: string | null }[];
	} | null;
	/** Invoice only. Drives both void-based outcomes' gate below. */
	amount_paid?: unknown;
	/** Invoice only: set once the invoice has been pushed to QuickBooks. */
	qb_invoice_id?: string | null;
	/** Invoice only: live (non-Void) adjustments written against this one. */
	adjustments?: { id: string; invoice_number: string }[] | null;
}

export interface DocumentAdapter {
	kind: DisputeKind;
	/**
	 * Statuses from which a dispute may be opened. Both delivery doors are
	 * sources: Issued means the dispatcher delivered it by hand, Sent means the
	 * system emailed it, and a client can contest either.
	 */
	disputableStatuses: readonly string[];
	/**
	 * Display strings for this document's statuses, where the stored enum value
	 * and the badge differ. Refusals name the status as the UI shows it, so any
	 * adapter whose labels diverge from its enum must supply them here. Omitted
	 * means the value and the label are the same.
	 */
	statusLabels?: Readonly<Record<string, string>>;
	/** The dispute record column holding this document's id. */
	foreignKey: "quote_id" | "invoice_id";
	load(
		tx: Prisma.TransactionClient,
		id: string,
		organizationId: string,
	): Promise<DocumentShape | null>;
	/** Outcomes legal for this document right now, in display order. */
	availableOutcomes(doc: DocumentShape): Outcome[];
	/** Why an unavailable outcome is unavailable — used for the UI and the 422 body. */
	unavailableReason(doc: DocumentShape, outcome: Outcome): string | null;
}

/**
 * The request's quote-derived jobs, as soldJobReason reads them. Exported so
 * the revise door loads the same evidence the dispute door does — the two must
 * agree on eligibility, and a door that forgets this include would silently
 * decide "not sold" for every quote it sees.
 */
export const SOLD_BY_QUOTE_JOBS = {
	where: { quote_id: { not: null } },
	select: { id: true, quote_id: true },
} as const;

/**
 * Why this quote can no longer be revised, or null if it still can.
 *
 * A sibling quote on the same request counts: once another quote there has
 * become a job, cloning THIS one would offer work that is already sold (D9).
 *
 * A job that came from no quote does not count. It sold whatever the
 * technician did on site, not what this quote offers, so a follow-on quote
 * written against that same request is live work and stays revisable. Reading
 * request.status instead stranded exactly that quote: no forward outcome at
 * all, and a refusal naming a job the quote page could not show.
 */
export function soldJobReason(doc: DocumentShape): string | null {
	if (doc.job) {
		return "A job was created from this quote — the quote is no longer the live document. Repeal it, or correct the job's invoice.";
	}
	// Excludes this quote's own job by id rather than leaning on the branch
	// above to have caught it: the two facts arrive from different queries, and
	// a caller that loads one without the other must not report this quote's
	// own sale as somebody else's.
	const soldBySibling = doc.request?.jobs?.some(
		(job) => job.quote_id != null && job.quote_id !== doc.id,
	);
	if (soldBySibling) {
		return "Another quote on this request was already sold as a job — the work is spoken for. Repeal this quote, or correct that job's invoice.";
	}
	return null;
}

export const quoteAdapter: DocumentAdapter = {
	kind: "quote",
	disputableStatuses: ["Issued", "Sent", "Viewed", "Approved"],
	statusLabels: {
		Draft: "Draft",
		Issued: "Created",
		Sent: "Sent",
		Viewed: "Viewed",
		Approved: "Approved",
		Disputed: "Disputed",
		Rejected: "Rejected",
		Revised: "Revised",
		Expired: "Expired",
		Cancelled: "Cancelled",
	},
	foreignKey: "quote_id",

	async load(tx, id, organizationId) {
		return (await tx.quote.findFirst({
			where: { id, organization_id: organizationId },
			include: {
				line_items: { select: { id: true, name: true, total: true } },
				job: true,
				request: { include: { jobs: SOLD_BY_QUOTE_JOBS } },
			},
		})) as DocumentShape | null;
	},

	availableOutcomes(doc) {
		// Once the work has been sold the quote is no longer the live
		// document, so the only honest thing left to do with it is kill it.
		if (soldJobReason(doc)) return ["Repeal"];
		return ["ReviseAndResend", "Repeal"];
	},

	unavailableReason(doc, outcome) {
		if (outcome === "IssueAdjustment") {
			return "Adjustments apply to invoices, not quotes.";
		}
		if (outcome === "ReviseAndResend") {
			return soldJobReason(doc);
		}
		return null;
	},
};

/**
 * Replacing an already-adjusted invoice would void a document the accounting
 * record now depends on: the adjustment's `adjusts_invoice_id` would point at a
 * dead row, and its share of the job's billing drops out of the chain
 * `syncBilledAmounts` walks, so profitability silently loses that money while
 * the adjustment stays collectible.
 *
 * This matches the market rather than inventing a rule. ServiceTitan treats an
 * invoice that has an adjustment as permanently locked audit trail — a further
 * adjustment is the only correction. NetSuite and QuickBooks both require an
 * applied credit to be unapplied before the invoice can be voided at all.
 */
const adjustedReason =
	"This invoice has already been corrected by an adjustment. Issue a further adjustment against it instead.";

const hasAdjustments = (doc: DocumentShape): boolean =>
	(doc.adjustments?.length ?? 0) > 0;

/**
 * Money, not status, decides what may be done to an invoice. Voiding a document
 * that holds a payment strands that payment on a dead record — and QuickBooks
 * refuses the void anyway — so both void-based outcomes are gated on
 * amount_paid === 0. Everything else routes through an adjustment document.
 */
export const invoiceAdapter: DocumentAdapter = {
	kind: "invoice",
	disputableStatuses: ["Issued", "Sent", "Viewed", "PartiallyPaid", "Paid"],
	statusLabels: {
		Draft: "Draft",
		Issued: "Created",
		Sent: "Sent",
		Viewed: "Viewed",
		PartiallyPaid: "Partially Paid",
		Paid: "Fully Paid",
		Disputed: "Disputed",
		Void: "Void",
	},
	foreignKey: "invoice_id",

	async load(tx, id, organizationId) {
		return (await tx.invoice.findFirst({
			where: { id, organization_id: organizationId },
			include: {
				line_items: { select: { id: true, name: true, total: true } },
				// Needed by availableOutcomes: an invoice with a live adjustment
				// is part of the audit trail and can no longer be voided by
				// either outcome.
				adjustments: LIVE_ADJUSTMENTS,
			},
		})) as DocumentShape | null;
	},

	availableOutcomes(doc) {
		if (Number(doc.amount_paid ?? 0) > 0 || hasAdjustments(doc)) {
			return ["IssueAdjustment"];
		}
		return ["ReviseAndResend", "IssueAdjustment", "Repeal"];
	},

	unavailableReason(doc, outcome) {
		if (outcome === "Repeal" || outcome === "ReviseAndResend") {
			const blocked = voidBlockedByPaymentReason(
				Number(doc.amount_paid ?? 0),
			);
			if (blocked) return blocked;
		}
		if (outcome === "Repeal") {
			return voidBlockedByAdjustmentReason(doc.adjustments ?? []);
		}
		if (outcome === "ReviseAndResend" && hasAdjustments(doc)) {
			return adjustedReason;
		}
		return null;
	},
};
