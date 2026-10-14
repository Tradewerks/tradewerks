import type {
	FieldPurchaseRefundParentLine,
	FieldPurchaseRefundSummary,
} from "../../../types/fieldPurchases";
import type { LineDraft } from "./lineDrafts";

/**
 * One part of the original purchase, grouped the way stock comes back: a linked
 * item is one part however many lines brought it in, and an unlinked line is only
 * itself.
 */
export interface ReturnablePart {
	key: string;
	description: string;
	inventory_item_id: string | null;
	unit_price: string;
	/** Still returnable after every other refund and every line on this sheet. */
	left: number;
	/** Where it comes back off, from the purchase's own line. */
	from: string | null;
}

const partKey = (itemId: string | null | undefined, description: string) =>
	itemId ? `item:${itemId}` : `desc:${description.trim().toLowerCase()}`;

export const draftKey = (d: LineDraft) => partKey(d.inventory_item_id || null, d.description);

/** Where a parent line's stock sits, said the way the vehicle page says it. */
function fromLabel(l: FieldPurchaseRefundParentLine): string | null {
	if (l.disposition !== "receive" || !l.inventory_item_id) return null;
	return l.vehicle_name ?? "the warehouse";
}

export function returnableParts(
	parentLines: FieldPurchaseRefundParentLine[],
	drafts: LineDraft[]
): ReturnablePart[] {
	const parts = new Map<string, ReturnablePart>();
	for (const l of parentLines) {
		const key = partKey(l.inventory_item_id, l.description);
		const existing = parts.get(key);
		if (existing) {
			existing.left += Number(l.returnable_qty) || 0;
			continue;
		}
		parts.set(key, {
			key,
			description: l.description,
			inventory_item_id: l.inventory_item_id,
			unit_price: l.unit_price,
			left: Number(l.returnable_qty) || 0,
			from: fromLabel(l),
		});
	}
	for (const d of drafts) {
		const part = parts.get(draftKey(d));
		if (part) part.left -= Number(d.quantity) || 0;
	}
	return [...parts.values()];
}

type RefundRow = FieldPurchaseRefundSummary["refunds"][number];

/** "Capacitor ×2, Tape +1 more" — what a refund took back, in a line that truncates. */
export function partsSummary(parts: RefundRow["parts"]): string | null {
	if (!parts || parts.length === 0) return null;
	const named = parts.slice(0, 2).map((p) => {
		const qty = Number(p.quantity);
		return qty > 1 ? `${p.description} ×${qty}` : p.description;
	});
	const rest = parts.length - named.length;
	return rest > 0 ? `${named.join(", ")} +${rest} more` : named.join(", ");
}

/**
 * What the purchase has cost once its refunds are counted. Only a credit that has
 * landed comes off the net: one on its way or with dispatch is shown, never
 * subtracted, and a rejected or unsent refund is money nobody is returning.
 */
export function refundLedger(paid: number, summary: FieldPurchaseRefundSummary) {
	const received = Number(summary.settled_value) || 0;
	return {
		paid,
		received,
		onItsWay: Number(summary.approved_value) || 0,
		withDispatch: Number(summary.in_progress_value) || 0,
		net: paid - received,
		stillRefundable: Number(summary.remaining) || 0,
	};
}
