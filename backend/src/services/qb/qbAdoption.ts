/**
 * Writing an adopted QuickBooks tax figure. Kept free of QuickBooks calls and of the service graph
 * so recomputeDocumentTotals can re-apply an adoption inside its own transaction.
 */
import { Prisma } from "../../../generated/prisma/client.js";
import { centsToDollars } from "../taxEngine.js";
import {
	readTaxSnapshot,
	toSnapshotV2,
	type AnyTaxSnapshot,
	type TaxSnapshotV2,
} from "../tax/snapshot.js";
import { qbTaxDeltaReason } from "./qbInvoiceTax.js";

export const QB_UNAVAILABLE_REASON = "QuickBooks unavailable — tax not confirmed";

export interface QbAdoptionResult {
	status: "adopted" | "needs_ack";
	qbTaxCents: number;
	oursCents: number;
	reason: string | null;
}

/** The review the resolver decided on a recompute; it takes the slot back when QuickBooks' clears. */
export interface ResolverReview {
	needsReview: boolean;
	reason: string | null;
}

export function asV2(snap: AnyTaxSnapshot): TaxSnapshotV2 {
	return snap.version === 2
		? snap
		: toSnapshotV2(snap, { source: null, rate_set_id: null, review_reason: null, sourcing: null });
}

/**
 * Same-reason re-confirms keep the ack. Unlike shouldResetAck, the source is not compared: it
 * flips between the resolver's and qb_ast on every recompute of an adopted draft.
 */
export function resetsAck(
	prevNeedsReview: boolean,
	prevReason: string | null,
	reason: string,
): boolean {
	return !prevNeedsReview || prevReason !== reason;
}

/**
 * The single writer of adopted QuickBooks totals (confirm and recompute both call it). Keeps the
 * snapshot's groups and lines as our estimate; only the document totals take QuickBooks' figure.
 * `resolver` marks a recompute re-applying an existing adoption. Returns null when the invoice or
 * its snapshot is missing.
 */
export async function applyQbAdoption(
	tx: Prisma.TransactionClient,
	invoiceId: string,
	orgId: string,
	qb: { qbTaxCents: number; fingerprint: string },
	resolver?: ResolverReview,
): Promise<QbAdoptionResult | null> {
	const inv = await tx.invoice.findFirst({
		where: { id: invoiceId, organization_id: orgId },
		select: {
			tax_snapshot: true,
			amount_paid: true,
			adjusts_invoice_id: true,
			tax_needs_review: true,
			tax_review_ack_at: true,
			line_items: { select: { taxable: true, tax_group_id: true } },
		},
	});
	const stored = readTaxSnapshot(inv?.tax_snapshot);
	if (!inv || !stored) return null;
	const snap = asV2(stored);

	const oursCents = snap.total_tax_cents;
	const groupIds = new Set(
		inv.line_items
			.filter((l) => l.taxable !== false && l.tax_group_id != null)
			.map((l) => l.tax_group_id),
	);
	const reason = qbTaxDeltaReason(qb.qbTaxCents, oursCents, groupIds.size > 1);

	const prevReason = snap.review_reason ?? null;
	const prevQbReview = snap.qb_review === true;
	let nextSnap: TaxSnapshotV2;
	let reviewData: Prisma.invoiceUpdateInput = {};
	let acked = inv.tax_review_ack_at != null;
	if (resolver && prevQbReview && prevReason === QB_UNAVAILABLE_REASON) {
		// Recompute cannot tell whether QuickBooks is reachable again; only a confirm clears this.
		nextSnap = { ...snap };
	} else if (reason) {
		nextSnap = { ...snap, review_reason: reason, qb_review: true };
		// A recompute that moves our estimate rewords the QuickBooks review; its ack still stands.
		const reset = !(resolver && prevQbReview) && resetsAck(inv.tax_needs_review, prevReason, reason);
		if (reset) acked = false;
		reviewData = {
			tax_needs_review: true,
			...(reset ? { tax_review_ack_by: null, tax_review_ack_at: null } : {}),
		};
	} else if (prevQbReview) {
		// QuickBooks now agrees: clear only the review that came from the earlier delta.
		nextSnap = { ...snap, qb_review: false };
		delete nextSnap.review_reason;
		reviewData = { tax_needs_review: false };
		if (resolver?.needsReview) {
			if (resolver.reason) nextSnap.review_reason = resolver.reason;
			acked = false;
			reviewData = { tax_needs_review: true, tax_review_ack_by: null, tax_review_ack_at: null };
		}
	} else {
		nextSnap = { ...snap, qb_review: false };
	}
	nextSnap = {
		...nextSnap,
		source: "qb_ast",
		qb_tax_cents: qb.qbTaxCents,
		qb_fingerprint: qb.fingerprint,
	};

	// Same formula as recomputeDocumentTotals, with QuickBooks' tax in place of ours.
	const total = centsToDollars(snap.subtotal_cents - snap.discount_cents + qb.qbTaxCents);
	const rawBalance = total - Number(inv.amount_paid ?? 0);
	const balanceDue = inv.adjusts_invoice_id != null ? rawBalance : Math.max(0, rawBalance);

	await tx.invoice.update({
		where: { id: invoiceId },
		data: {
			tax_amount: centsToDollars(qb.qbTaxCents),
			total,
			balance_due: balanceDue,
			tax_source: "qb_ast",
			tax_snapshot: nextSnap as unknown as Prisma.InputJsonValue,
			...reviewData,
		},
	});

	return {
		status: reason && !acked ? "needs_ack" : "adopted",
		qbTaxCents: qb.qbTaxCents,
		oursCents,
		reason,
	};
}
