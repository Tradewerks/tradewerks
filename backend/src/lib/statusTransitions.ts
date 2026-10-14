/**
 * Centralized status transition rules.
 *
 * Only user-initiated transitions go through this guard.
 * Internal system updates (payment sync, PDF generation) bypass it.
 *
 * If `from === to` the call is a no-op and always allowed.
 */

// Exported for quoteTransitionsParity.test.ts, which reads the frontend mirror
// (frontend/src/lib/quoteTransitions.ts) as text and deep-equals it against
// this — the authoritative side — in both directions (DW-21).
export const QUOTE_TRANSITIONS: Record<string, readonly string[]> = {
	Draft:     ["Issued", "Sent", "Cancelled"],
	Issued:    ["Sent", "Approved", "Rejected", "Revised", "Expired", "Cancelled", "Disputed"],
	// A client can accept or decline without the system ever recording a view.
	Sent:      ["Viewed", "Approved", "Rejected", "Expired", "Cancelled", "Disputed"],
	Viewed:    ["Approved", "Rejected", "Expired", "Cancelled", "Disputed"],
	Approved:  ["Revised", "Disputed"],
	// Revise & Resend supersedes this quote; Repeal cancels it.
	Disputed:  ["Revised", "Cancelled"],
	// Revised is the one exit: a client's "no" is recoverable by superseding
	// the quote, not by editing it. quotesController still refuses every edit
	// to a Rejected quote, and the funnel still counts it lost until the
	// revision actually exists.
	Rejected:  ["Revised"],
	Revised:   [],
	Expired:   ["Revised"],
	Cancelled: [],
};

const REQUEST_TRANSITIONS: Record<string, readonly string[]> = {
	New:            ["Reviewing", "Cancelled"],
	Reviewing:      ["Quoted", "New", "Cancelled"],
	Quoted:         ["QuoteApproved", "QuoteRejected", "Reviewing"],
	QuoteApproved:  ["ConvertedToJob", "Cancelled", "Quoted"],
	QuoteRejected:  ["Reviewing", "Quoted"],
	ConvertedToJob: [],
	Cancelled:      [],
};

const INVOICE_TRANSITIONS: Record<string, readonly string[]> = {
	// Two delivery doors, not two steps: Issued is "final, I deliver it
	// myself", Sent is "final, the system emailed it". updateInvoice finalizes
	// (freezes the tax basis, dates the document) on whichever one the invoice
	// leaves Draft through. Quotes have allowed both since the start.
	// Dispute honours both doors. A hand-delivered document is in the client's
	// hands as surely as an emailed one, so Issued carries Disputed on both
	// maps and the invoice's Disputed row carries Issued back.
	Draft:        ["Issued", "Sent", "Void"],
	Issued:       ["Sent", "Void", "Disputed"],
	Sent:         ["Viewed", "Disputed", "Void"],
	Viewed:       ["Disputed", "Void"],
	PartiallyPaid:["Disputed", "Void"],
	// A paid invoice can still be contested. Every outcome available from here
	// is additive — Issue Adjustment writes a new document and restores this one.
	Paid:         ["Disputed"],
	// Restores to whatever the invoice was when the dispute opened. A
	// PartiallyPaid or Paid original restores through Sent and is then
	// recomputed by syncInvoicePaymentTotals, which bypasses this guard.
	// An Issued original restores directly. Nothing re-locks: finalization is
	// keyed on leaving Draft (isInvoiceFinalizingTransition), and issued_at is
	// write-once in updateInvoice.
	Disputed:     ["Sent", "Viewed", "Void", "Issued"],
	Void:         [],
};

export class InvalidTransitionError extends Error {
	status = 422;
	constructor(from: string, to: string) {
		super(`Invalid status transition: ${from} → ${to}`);
		this.name = "InvalidTransitionError";
	}
}

/**
 * A deliberate refusal of a write, as opposed to a fault.
 *
 * updateInvoice's catch reports every unrecognised throw as "Internal server
 * error", which turned its own rules into unexplained failures: refusing to
 * rewrite the line items of an issued invoice is the tax snapshot doing exactly
 * its job, and the dispatcher needs to read that rather than a 500-shaped
 * message. Sibling of InvalidTransitionError, and caught the same way.
 */
export class DocumentRuleError extends Error {
	status = 422;
	constructor(message: string) {
		super(message);
		this.name = "DocumentRuleError";
	}
}

export function assertValidRequestTransition(from: string, to: string): void {
	if (from === to) return;
	const allowed = REQUEST_TRANSITIONS[from];
	if (!allowed) {
		throw new InvalidTransitionError(from, to);
	}
	if (!allowed.includes(to)) {
		throw new InvalidTransitionError(from, to);
	}
}

export function assertValidQuoteTransition(from: string, to: string): void {
	if (from === to) return;
	const allowed = QUOTE_TRANSITIONS[from];
	if (!allowed) {
		throw new InvalidTransitionError(from, to);
	}
	if (!allowed.includes(to)) {
		throw new InvalidTransitionError(from, to);
	}
}

/**
 * Whether this invoice status change is the FINALIZATION — the posting act
 * that freezes the tax basis (locking the tax snapshot, after which the server
 * refuses line-item edits) and dates the document.
 *
 * It is keyed on leaving Draft, not on a target status, because Issued and Sent
 * are two delivery doors rather than two steps: Issued means "final, I will
 * deliver it myself", Sent means "final, the system emailed it". Both commit to
 * the same claim for the same amount. Keying it on `to === "Issued"` alone left
 * the emailed path unfrozen and undated — a document in the client's hands
 * whose line items the server still accepted a rewrite of.
 *
 * Void is excluded: killing a draft commits to nothing.
 *
 * Lives here, beside the table it depends on, so the rule has one definition
 * that both doors and their tests read.
 */
export function isInvoiceFinalizingTransition(
	from: string,
	to: string | undefined,
): boolean {
	return from === "Draft" && (to === "Issued" || to === "Sent");
}

export function assertValidInvoiceTransition(from: string, to: string): void {
	if (from === to) return;
	const allowed = INVOICE_TRANSITIONS[from];
	if (!allowed) {
		throw new InvalidTransitionError(from, to);
	}
	if (!allowed.includes(to)) {
		throw new InvalidTransitionError(from, to);
	}
}
