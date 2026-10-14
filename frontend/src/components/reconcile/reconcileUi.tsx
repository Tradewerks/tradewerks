import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, Link2, Receipt } from "lucide-react";
import {
	ITEM_ORIGIN_LABELS,
	type ItemOrigin,
	type LinkageAudit,
	type LinkageMatchTier,
	type ReconcilePurchaseOrigin,
} from "../../api/inventory";
import { COL_LABEL, ENTITY_LABELS, shortDate, TIER_LABELS } from "./reconcileFormat";
import { RECORD_LINK } from "../fieldPurchases/fieldPurchaseFormat";
import { purchaseHref } from "../fieldPurchases/queueFilters";
import { FIELD_PURCHASE_STATUS_LABELS } from "../../types/fieldPurchases";
import { useAnyPermission } from "../../hooks/usePermission";

/**
 * How much to trust a suggestion, in one glance. An exact hit is safe to accept
 * in bulk; a SKU hit on a folded name is a guess a human should read first.
 */
export function TierChip({ tier }: { tier: LinkageMatchTier | null }) {
	if (!tier) {
		return (
			<span className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-warning-border bg-warning-bg px-1.5 py-px text-[10px] font-medium text-warning-text">
				<AlertTriangle size={9} />
				No match
			</span>
		);
	}
	const strong = tier === "exact";
	return (
		<span
			className={`inline-flex flex-shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium ${
				strong
					? "border-success-border bg-success-bg text-success-text"
					: "border-info-border bg-info-bg text-info-text"
			}`}
		>
			{strong ? <CheckCircle2 size={9} /> : <Link2 size={9} />}
			{TIER_LABELS[tier]}
		</span>
	);
}

export function OriginChip({ origin }: { origin: ItemOrigin }) {
	return (
		<span className="flex-shrink-0 rounded border border-border-subtle bg-surface-raised px-1.5 py-px text-[10px] font-medium text-text-tertiary">
			{ITEM_ORIGIN_LABELS[origin]}
		</span>
	);
}

/**
 * Which kinds of document the gap is in. The server has always returned this
 * and nothing rendered it, so "41 unmapped names" could not be read as "almost
 * all of it is old invoices".
 */
export function EntityBreakdown({ counts }: { counts: LinkageAudit["counts"] }) {
	const gaps = counts.filter((c) => c.unmapped > 0).sort((a, b) => b.unmapped - a.unmapped);
	if (gaps.length === 0) return null;

	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle bg-surface px-3 py-1.5">
			<span className={COL_LABEL}>Gap by document</span>
			{gaps.map((c) => (
				<span key={c.entity} className="text-[11px] text-text-muted">
					{ENTITY_LABELS[c.entity]}{" "}
					<span className="font-medium tabular-nums text-text-secondary">
						{c.unmapped}
					</span>
					<span className="text-text-faint"> / {c.total}</span>
				</span>
			))}
		</div>
	);
}

/**
 * The receipt that put this part in the queue. A row here is the residue of a
 * decision made in the field: settling "FOIL TAPE 2IN X 60YD" with no link to
 * where it came from hides that it came off a $101 receipt. Hidden without
 * permission to open one - a link that bounces is worse than no link.
 */
export function PurchaseOriginLinks({ purchases }: { purchases?: ReconcilePurchaseOrigin[] }) {
	const canSee = useAnyPermission(["view_field_purchases", "review_field_purchases"]);
	if (!canSee || !purchases || purchases.length === 0) return null;

	return (
		<section aria-label="Field purchases behind this part" className="px-3 py-2">
			<h3 className={`flex items-center gap-1.5 ${COL_LABEL}`}>
				<Receipt size={11} className="text-text-muted" />
				Bought in the field
			</h3>
			<ul className="mt-1 space-y-0.5">
				{purchases.map((p) => (
					<li key={p.id} className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
						<Link to={purchaseHref(p.id, p.status)} className={RECORD_LINK}>
							{p.vendor_name || "Vendor not recorded"}
						</Link>
						<span className="text-text-muted">
							{p.technician_name}
							{p.purchased_at ? ` · ${shortDate(p.purchased_at)}` : ""}
							{` · ${FIELD_PURCHASE_STATUS_LABELS[p.status]}`}
						</span>
					</li>
				))}
			</ul>
		</section>
	);
}

export function ActionError({ error }: { error: unknown }) {
	if (!(error instanceof Error)) return null;
	return (
		<div
			role="alert"
			className="mt-2 flex items-start gap-1.5 rounded border border-error-border bg-error-bg px-2 py-1.5 text-xs text-error-text"
		>
			<AlertTriangle size={12} className="mt-px flex-shrink-0" />
			{error.message}
		</div>
	);
}

export function RowSkeleton() {
	return (
		<div aria-hidden className="animate-pulse">
			{[0, 1, 2, 3, 4, 5].map((i) => (
				<div
					key={i}
					className="space-y-1.5 border-b border-border px-3 py-2.5"
				>
					<div className="flex items-center justify-between gap-2">
						<div className="h-3 w-2/5 rounded bg-surface-raised" />
						<div className="h-3 w-14 rounded bg-surface-raised" />
					</div>
					<div className="h-2.5 w-3/5 rounded bg-surface-raised" />
				</div>
			))}
		</div>
	);
}

/** One label voice across every input on the adopt form. */
export function Field({
	label,
	hint,
	htmlFor,
	children,
}: {
	label: string;
	hint?: string;
	htmlFor?: string;
	children: ReactNode;
}) {
	return (
		<div className="flex min-w-0 flex-col gap-1">
			<span className="flex items-baseline gap-1">
				<label htmlFor={htmlFor} className={COL_LABEL}>
					{label}
				</label>
				{hint && (
					<span
						aria-hidden
						className="text-[10px] font-medium text-warning-text"
					>
						{hint}
					</span>
				)}
			</span>
			{children}
		</div>
	);
}
