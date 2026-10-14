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
	newTitle: string;
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
	newTitle: "New field purchase",
	receiptTitle: "Receipt",
	photograph: "Photograph receipt",
	photoRequired:
		"A photo is required before you can submit — it is the only record of the purchase.",
	noPhoto: "No receipt yet.",
	detailsTitle: "Receipt details",
	totalLabel: "Total paid",
	dateLabel: "When it was bought",
	linesTitle: "What you bought",
	linePlaceholder: "Part as it reads on the receipt",
	reconcileVerb: "paid",
	jobsTitle: "Jobs this covers",
	submitLabel: "Submit for review",
	submitted: "Submitted for review",
	blockedNoPhoto: "Photograph the receipt first",
	blockedNoLines: "Add what you bought first",
	discardTitle: "Discard this draft?",
	discardBody: "The photo and every line on it go with it. There is no undo.",
	discardLabel: "Discard this draft",
	discardFailed: "Could not discard the draft",
};

const REFUND: SheetCopy = {
	noun: "credit slip",
	newTitle: "New refund",
	receiptTitle: "Credit slip",
	photograph: "Photograph the credit slip",
	photoRequired:
		"A photo of the credit slip is required before you can submit — it is the only record of the return.",
	noPhoto: "No credit slip yet.",
	detailsTitle: "Credit slip details",
	totalLabel: "Credit total",
	dateLabel: "When you returned it",
	linesTitle: "What you returned",
	linePlaceholder: "Part as it reads on the credit slip",
	reconcileVerb: "credited",
	jobsTitle: "Jobs credited",
	submitLabel: "Send refund to dispatch",
	submitted: "Refund sent to dispatch",
	blockedNoPhoto: "Photograph the credit slip first",
	blockedNoLines: "Add what you returned first",
	discardTitle: "Discard this refund?",
	discardBody:
		"The photo and every line on it go with it. The original purchase is not affected.",
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

/** The same, as a heading that has to say it is a refund at all. */
export function refundStatusLabel(p: Pick<FieldPurchase, "status" | "refund_settled_at">): string {
	return p.status === "draft" ? "New refund" : `Refund · ${refundStateLabel(p)}`;
}

/** The sheet's heading, whichever kind it is. */
export function sheetTitle(p: Pick<FieldPurchase, "kind" | "status" | "refund_settled_at">) {
	if (p.kind === "refund") return refundStatusLabel(p);
	return p.status === "draft" ? PURCHASE.newTitle : FIELD_PURCHASE_STATUS_LABELS[p.status];
}

/** "1 refund pending · $42.00" — plural-aware, money already formatted. */
export function pendingRefundsLine(count: number, value: string): string {
	return `${count} refund${count === 1 ? "" : "s"} pending · ${value}`;
}
