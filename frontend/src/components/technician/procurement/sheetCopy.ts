import i18n from "../../../i18n";
import type { FieldPurchase, FieldPurchaseKind } from "../../../types/fieldPurchases";

/**
 * Every word the purchase sheet says that changes when the sheet is a refund. A
 * refund reuses the whole screen — same photo, same lines, same review — so
 * without one source a credit slip reads as money spent: "Total paid", "What you
 * bought". Text lives in `sheet.purchase.*` / `sheet.refund.*`.
 */
const FIELDS = [
	/** The paper itself with its article, mid-sentence: "the receipt" / "la nota de crédito". */
	"noun",
	/** The heading when the vendor is not known yet. */
	"untitled",
	"receiptTitle",
	"photograph",
	"photoRequired",
	"noPhoto",
	"detailsTitle",
	"totalLabel",
	"dateLabel",
	"linesTitle",
	"linePlaceholder",
	/** "…do not add up to the $X {reconcileVerb}". */
	"reconcileVerb",
	"jobsTitle",
	"submitLabel",
	"submitted",
	"blockedNoPhoto",
	"blockedNoLines",
	"discardTitle",
	"discardBody",
	"discardLabel",
	"discardFailed",
] as const;

export type SheetCopy = Record<(typeof FIELDS)[number], string>;

/** Read at call time, so it follows the current language. */
export const sheetCopy = (kind: FieldPurchaseKind): SheetCopy => {
	const k = kind === "refund" ? "refund" : "purchase";
	return Object.fromEntries(FIELDS.map((f) => [f, i18n.t(`sheet.${k}.${f}`)])) as SheetCopy;
};

/**
 * A refund's status, said as where the money is. "Approved" alone reads as done,
 * but an approved refund is a credit the store promised — the technician needs to
 * know whether it has actually landed.
 */
export function refundStateLabel(p: Pick<FieldPurchase, "status" | "refund_settled_at">): string {
	const { t } = i18n;
	switch (p.status) {
		case "draft":
			return t("refund.notSent");
		case "pending_review":
		case "pending_second_signoff":
			return t("refund.withDispatch");
		case "queried":
			return t("refund.needsChange");
		case "rejected":
			return t("refund.notCredited");
		case "approved":
			return t(p.refund_settled_at ? "refund.creditReceived" : "refund.creditOnWay");
		default:
			return t(`status.fieldPurchase.${p.status}`);
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
	if (p.kind === "refund")
		return name ? i18n.t("detail.refundTitle", { name }) : i18n.t("sheet.refund.untitled");
	return name || i18n.t("sheet.purchase.untitled");
}

/** The line under the heading: where the purchase stands. */
export function sheetStatus(p: Pick<FieldPurchase, "kind" | "status" | "refund_settled_at">): string {
	return p.kind === "refund" ? refundStateLabel(p) : i18n.t(`status.fieldPurchase.${p.status}`);
}

/** "1 refund pending · $42.00" — plural-aware, money already formatted. */
export function pendingRefundsLine(count: number, value: string): string {
	return i18n.t("detail.pendingRefunds", { count, value });
}
