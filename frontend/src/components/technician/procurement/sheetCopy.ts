import {
	FIELD_PURCHASE_STATUS_LABELS,
	type FieldPurchase,
	type FieldPurchaseKind,
} from "../../../types/fieldPurchases";

/**
 * Every word the purchase sheet says that changes when the sheet is a refund. A
 * refund reuses the whole screen — same photo, same lines, same review — so
 * without one source a credit slip reads as money spent: "Total paid", "What you
 * bought". The purchase column is the screen's existing wording, unchanged.
 */
export interface SheetCopy {
	/** The paper itself, mid-sentence: "the {noun}". */
	noun: string;
	/** The heading when the vendor is not known yet. */
	untitled: string;
	receiptTitle: string;
	photograph: string;
	photoRequired: string;
	noPhoto: string;
	detailsTitle: string;
	totalLabel: string;
	dateLabel: string;
	linesTitle: string;
	linePlaceholder: string;
	/** "…do not add up to the $X {reconcileVerb}". */
	reconcileVerb: string;
	jobsTitle: string;
	submitLabel: string;
	submitted: string;
	blockedNoPhoto: string;
	blockedNoLines: string;
	discardTitle: string;
	discardBody: string;
	discardLabel: string;
	discardFailed: string;
}

const PURCHASE: SheetCopy = {
	noun: "receipt",
	untitled: "Field purchase",
	receiptTitle: "Receipt",
	photograph: "Photograph receipt",
	photoRequired: "Required to submit — it's the only record of the purchase.",
	noPhoto: "No receipt yet.",
	detailsTitle: "Receipt details",
	totalLabel: "Total paid",
	dateLabel: "Purchase date",
	linesTitle: "Items",
	linePlaceholder: "Part as it reads on the receipt",
	reconcileVerb: "paid",
	jobsTitle: "Jobs this covers",
	submitLabel: "Submit for review",
	submitted: "Submitted for review",
	blockedNoPhoto: "Photograph the receipt first",
	blockedNoLines: "Add the items first",
	discardTitle: "Discard this draft?",
	discardBody: "The photo and all items will be deleted. This can't be undone.",
	discardLabel: "Discard this draft",
	discardFailed: "Could not discard the draft",
};

const REFUND: SheetCopy = {
	noun: "credit slip",
	untitled: "Refund",
	receiptTitle: "Credit slip",
	photograph: "Photograph credit slip",
	photoRequired: "Required to submit — it's the only record of the return.",
	noPhoto: "No credit slip yet.",
	detailsTitle: "Credit slip details",
	totalLabel: "Credit total",
	dateLabel: "Return date",
	linesTitle: "Items returned",
	linePlaceholder: "Part as it reads on the credit slip",
	reconcileVerb: "credited",
	jobsTitle: "Jobs credited",
	submitLabel: "Send refund to dispatch",
	submitted: "Refund sent to dispatch",
	blockedNoPhoto: "Photograph the credit slip first",
	blockedNoLines: "Add the returned items first",
	discardTitle: "Discard this refund?",
	discardBody:
		"The photo and all items will be deleted. The original purchase isn't affected.",
	discardLabel: "Discard this refund",
	discardFailed: "Could not discard the refund",
};

export const sheetCopy = (kind: FieldPurchaseKind): SheetCopy =>
	kind === "refund" ? REFUND : PURCHASE;

/**
 * A refund's status, said as where the money is. "Approved" alone reads as done,
 * but an approved refund is a credit the store promised — the technician needs to
 * know whether it has actually landed.
 */
export function refundStateLabel(p: Pick<FieldPurchase, "status" | "refund_settled_at">): string {
	switch (p.status) {
		case "draft":
			return "Not sent yet";
		case "pending_review":
		case "pending_second_signoff":
			return "With dispatch";
		case "queried":
			return "Needs a change from you";
		case "rejected":
			return "Not credited";
		case "approved":
			return p.refund_settled_at ? "Credit received" : "Credit on its way";
		default:
			return FIELD_PURCHASE_STATUS_LABELS[p.status];
	}
}

export type RefundTone = "success" | "warning" | "error" | "muted";

/** How loudly a refund's state should read: amber while money or a reply is still owed. */
export function refundStateTone(
	p: Pick<FieldPurchase, "status" | "refund_settled_at">
): RefundTone {
	if (p.status === "approved") return p.refund_settled_at ? "success" : "warning";
	if (p.status === "queried") return "warning";
	if (p.status === "rejected") return "error";
	return "muted";
}

/**
 * The sheet's heading: which purchase this is, named by where it was bought. A
 * status ("Pending review") or a "New field purchase" said nothing about which
 * receipt was open, and "New" stayed on a draft reopened days later.
 */
export function sheetTitle(p: Pick<FieldPurchase, "kind">, vendor: string): string {
	const name = vendor.trim();
	if (p.kind === "refund") return name ? `Refund · ${name}` : REFUND.untitled;
	return name || PURCHASE.untitled;
}

/** The line under the heading: where the purchase stands. */
export function sheetStatus(p: Pick<FieldPurchase, "kind" | "status" | "refund_settled_at">): string {
	return p.kind === "refund" ? refundStateLabel(p) : FIELD_PURCHASE_STATUS_LABELS[p.status];
}

/** "1 refund pending · $42.00" — plural-aware, money already formatted. */
export function pendingRefundsLine(count: number, value: string): string {
	return `${count} refund${count === 1 ? "" : "s"} pending · ${value}`;
}
