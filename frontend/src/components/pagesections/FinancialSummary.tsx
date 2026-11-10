import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { FileText, MapPin, Briefcase } from "lucide-react";
import Card from "../ui/Card";
import { formatCurrency } from "../../util/util";
import { formatDocRatePercent, formatRatePercentLabel } from "../../lib/formatTax";
import {
	autoRateLocation,
	collapseSnapshotRates,
	isAddressRateSnapshot,
	taxBasis,
	toList,
	type CollapsedRate,
} from "../../lib/taxBreakdown";
import { isV2Snapshot, snapshotSource } from "../../types/tax";
import type { TaxSnapshot, TaxSnapshotRate, TaxSource } from "../../types/tax";
import { AutoLineTaxTag, TaxSourceChip } from "../tax/TaxSourceChip";
import { isKeptAddressRate, ungroupedLineGroup } from "../../lib/taxEditorMode";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FinancialSummaryLineItemRate {
	id: string;
	name: string;
	rate: number;
}

export interface FinancialSummaryLineItem {
	id?: string | null;
	name: string;
	description?: string | null;
	item_type?: string | null;
	quantity: number | string;
	unit_price: number | string;
	/** Pre-computed row total. Falls back to quantity × unit_price when absent. */
	total?: number | string | null;
	tax_group?: {
		name: string;
		/** Rates fallback when taxSnapshot absent. */
		rates?: { tax_rate: FinancialSummaryLineItemRate }[];
	} | null;
	/** Per-item tax amount (dollars); fallback when taxSnapshot absent. */
	tax_amount?: number | null;
	taxable?: boolean;
	/** Source attribution label, e.g. "Job Charges" or "Visit · May 2". When present, renders a source chip. */
	sourceLabel?: string | null;
	/** True for visit-sourced items (blue pin badge), false/absent for job items (gray briefcase badge). */
	isVisitSource?: boolean;
}

export interface FinancialSummaryProps {
	lineItems: FinancialSummaryLineItem[];
	/** Line ids contested by a dispute. Optional: a document with no dispute —
	 *  which is every job and visit — passes nothing and renders unchanged. */
	contestedIds?: ReadonlySet<string>;

	// Financials
	/** Several snapshots (a job and its visits) are summed row by row; per-line badges use the first. */
	taxSnapshot?: TaxSnapshot | readonly TaxSnapshot[] | null;
	/** Document `tax_source`; falls back to the v2 snapshot's own source. */
	taxSource?: TaxSource | null;
	/** Legacy flat-rate fallback (pre-snapshot records only). */
	legacyTaxRate?: number | null;
	legacyTaxAmount?: number | null;
	/** Prefixes the tax amount with "≈ " when the final figure is calculated elsewhere (QuickBooks). */
	taxIsEstimate?: boolean;
	subtotal?: number | null;
	discountAmount?: number | null;
	discountType?: string | null;
	discountValue?: number | null;

	// Right sidebar meta card
	/** Label for the document identifier — e.g. "Quote #", "Job Number", "Visit Date". */
	metaLabel: string;
	/** Value for the document identifier — e.g. "Q-001", "J-042", "May 21, 2026". */
	metaValue: string;

	/** Page-specific total card(s) rendered below the divider in the right sidebar. */
	totalsContent: ReactNode;

	// Card config
	cardTitle?: string;

	// Empty-state strings
	noLineItemsTitle?: string;
	noLineItemsDescription?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function FinancialSummary({
	lineItems,
	taxSnapshot,
	taxSource,
	legacyTaxRate,
	legacyTaxAmount,
	taxIsEstimate = false,
	contestedIds,
	subtotal,
	discountAmount,
	discountType,
	discountValue,
	metaLabel,
	metaValue,
	totalsContent,
	cardTitle = "Financial Summary",
	noLineItemsTitle = "No Line Items",
	noLineItemsDescription = "No line items have been added yet.",
}: FinancialSummaryProps) {
	const snapshots = useMemo(() => toList(taxSnapshot), [taxSnapshot]);
	const primarySnapshot = snapshots[0] ?? null;
	// group name → rates; snapshot is primary, line-item tax_group is fallback.
	const groupRatesMap = useMemo(() => {
		const map = new Map<string, TaxSnapshotRate[]>();
		for (const group of primarySnapshot?.groups ?? []) {
			if ((group.rates ?? []).length > 0) map.set(group.name, group.rates);
		}
		if (map.size === 0) {
			for (const item of lineItems) {
				const g = item.tax_group;
				if (g?.name && g.rates && g.rates.length > 0 && !map.has(g.name)) {
					// Number() coercion: Prisma Decimal serialises as string via Express JSON
					map.set(g.name, g.rates.map(r => ({
						id: r.tax_rate.id,
						name: r.tax_rate.name,
						rate: Number(r.tax_rate.rate),
					})));
				}
			}
		}
		return map;
	}, [primarySnapshot, lineItems]);

	const collapsedTaxRates = useMemo(() => collapseSnapshotRates(snapshots), [snapshots]);

	// No snapshot — per-rate totals from line items; split tax_amount by rate weight.
	// NOTE: tax_rate.rate is a Prisma Decimal, serialised as a string by Express JSON.
	// All usages explicitly coerce with Number() to prevent string-concatenation NaN
	// (e.g. reduce("0.06" + "0.02") → "00.060.02" → NaN) when groups have multiple rates.
	const lineItemCollapsedRates = useMemo((): CollapsedRate[] => {
		if (collapsedTaxRates.length > 0) return [];
		const rateMap = new Map<string, CollapsedRate>();
		for (const item of lineItems) {
			if (!item.taxable || item.tax_amount == null || !item.tax_group?.rates?.length) continue;
			const itemTaxCents = Math.round(Number(item.tax_amount) * 100);
			if (itemTaxCents === 0) continue;
			const combinedRate = item.tax_group.rates.reduce((s, r) => s + Number(r.tax_rate.rate), 0);
			if (combinedRate === 0) continue;
			for (const r of item.tax_group.rates) {
				const rateNum = Number(r.tax_rate.rate);
				const share = Math.round(itemTaxCents * (rateNum / combinedRate));
				const existing = rateMap.get(r.tax_rate.id);
				if (existing) {
					existing.amountCents += share;
				} else {
					rateMap.set(r.tax_rate.id, {
						id: r.tax_rate.id,
						name: r.tax_rate.name,
						rate: rateNum,
						amountCents: share,
					});
				}
			}
		}
		return [...rateMap.values()];
	}, [collapsedTaxRates, lineItems]);

	const source = taxSource ?? snapshotSource(primarySnapshot);
	const rateLocation = snapshots.map(autoRateLocation).find((l) => l != null) ?? null;
	const addressSourced = isAddressRateSnapshot(primarySnapshot, source);
	const allExempt = snapshots.length > 0 && snapshots.every((s) => s.client_exempt);
	// Client group or org default: the line names no group, but one taxed it.
	const ungroupedGroupName = addressSourced
		? null
		: (ungroupedLineGroup(
				primarySnapshot,
				source,
				lineItems.flatMap((li) => (li.tax_group?.name ? [li.tax_group.name] : [])),
			)?.name ?? null);

	const [visibleCount, setVisibleCount] = useState(10);

	return (
		<Card title={cardTitle}>
			<div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

				{/* ── Left column — line items table ───────────────────────────── */}
				<div className="lg:col-span-2">
					<h3 className="text-text-tertiary text-xs uppercase tracking-wide font-semibold mb-4">
						Line Items
					</h3>

					{lineItems.length === 0 ? (
						<div className="text-center py-8">
							<FileText size={40} className="mx-auto text-text-faint mb-3" />
							<h3 className="text-text-tertiary text-sm font-medium mb-1">
								{noLineItemsTitle}
							</h3>
							<p className="text-text-muted text-xs">{noLineItemsDescription}</p>
						</div>
					) : (
						<div>
							{/* Header row */}
							<div className="grid grid-cols-12 gap-2 pb-2 border-b border-border text-xs uppercase tracking-wide font-semibold text-text-tertiary">
								<div className="col-span-5 min-w-0">Item / Description</div>
								<div className="col-span-2 min-w-0 text-center">Type</div>
								<div className="col-span-1 min-w-0 text-right">Qty</div>
								<div className="col-span-2 min-w-0 text-right">Unit Price</div>
								<div className="col-span-2 min-w-0 text-right">Amount</div>
							</div>

							{/* Data rows */}
							{lineItems.slice(0, visibleCount).map((item, index) => {
								const rowTotal =
									item.total != null
										? Number(item.total)
										: Number(item.quantity) * Number(item.unit_price);
								// Manual mode stamps the default group on non-taxable lines too.
								const groupName =
									item.taxable === false
										? null
										: item.tax_group?.name || ungroupedGroupName;
								const isContested =
									item.id != null && contestedIds?.has(item.id) === true;
								return (
									<div
										key={item.id ?? index}
										className={`border-b border-border-subtle hover:bg-surface/30 transition-colors${isContested ? " border-l-2 border-l-warning-border" : ""}`}
									>
										{/* Primary row */}
										<div className="grid grid-cols-12 gap-2 pt-3 pb-1 items-center">
											<div className="col-span-5 min-w-0 text-sm">
												<p className="text-text-primary font-medium break-words">
													{item.name}
												</p>
												{isContested && (
													<span className="mt-0.5 inline-block text-xs font-medium text-warning-text">
														Contested
													</span>
												)}
											</div>
											<div className="col-span-2 min-w-0 flex justify-center">
												{item.item_type && (
													<span className="inline-block max-w-full truncate px-1.5 py-0.5 rounded text-xs font-medium bg-surface-raised text-text-secondary border border-border-strong">
														{item.item_type}
													</span>
												)}
											</div>
											<div
												className="col-span-1 min-w-0 text-right text-sm text-text-primary tabular-nums"
												title={String(item.quantity)}
											>
												{Number(item.quantity).toLocaleString("en-US", {
													minimumFractionDigits: 0,
													maximumFractionDigits: 2,
												})}
											</div>
											<div className="col-span-2 min-w-0 text-right text-sm text-text-primary tabular-nums">
												{formatCurrency(Number(item.unit_price))}
											</div>
											<div className="col-span-2 min-w-0 text-right text-sm text-text-primary font-semibold tabular-nums">
												{formatCurrency(rowTotal)}
											</div>
										</div>

										{/* Sub-row: description + source badge + tax badge */}
										<div className="space-y-1 pb-2.5 min-w-0">
											{item.description && (
												<p className="text-xs text-text-tertiary leading-relaxed break-words">
													{item.description}
												</p>
											)}
											<div className="flex flex-wrap items-center gap-1.5">
												{item.sourceLabel != null && (
													<span
														className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border whitespace-nowrap leading-none ${
															item.isVisitSource
																? "bg-primary/10 text-primary-text border-primary/20"
																: "bg-surface-raised/60 text-text-tertiary border-border-strong/50"
														}`}
													>
														{item.isVisitSource ? (
															<MapPin size={9} className="flex-shrink-0" />
														) : (
															<Briefcase size={9} className="flex-shrink-0" />
														)}
														<span>{item.sourceLabel}</span>
													</span>
												)}
												{groupName ? (
													<span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-surface-raised/60 border border-border-strong/50 text-[10px] font-medium text-text-muted whitespace-nowrap leading-none">
														{groupName}
														{groupRatesMap.has(groupName)
															? ` · ${groupRatesMap
																.get(groupName)!
																.map(r => `${r.name} ${formatRatePercentLabel(r.rate)}`)
																.join(" + ")}`
															: ""}
													</span>
												) : item.taxable !== false && addressSourced ? (
													<AutoLineTaxTag />
												) : (
													<span className="inline-flex items-center px-1.5 py-0.5 rounded bg-surface-raised/40 border border-border-strong/30 text-[10px] text-text-faint whitespace-nowrap leading-none">
														No Tax
													</span>
												)}
											</div>
										</div>
									</div>
								);
							})}

							{/* Load More */}
							{visibleCount < lineItems.length && (() => {
								const remaining = lineItems.length - visibleCount;
								const label = remaining > 10
									? `Load 10 of ${remaining} More`
									: `Load ${remaining} More`;
								return (
									<button
										onClick={() => setVisibleCount(prev => prev + 10)}
										className="mt-3 w-full py-1.5 text-xs font-medium text-text-tertiary hover:text-text-primary border border-border hover:border-border-strong rounded transition-colors"
									>
										{label}
									</button>
								);
							})()}
						</div>
					)}
				</div>

				{/* ── Right column — sidebar summary ───────────────────────────── */}
				<div className="lg:col-span-1 space-y-6">

					{/* Meta: item count + document identifier */}
					<div className="p-4 bg-surface/50 rounded-lg border border-border">
						<div className="flex items-start justify-between gap-4">
							<div>
								<p className="text-2xl font-bold text-text-primary tabular-nums leading-none">
									{lineItems.length}
								</p>
								<p className="text-[10px] text-text-tertiary uppercase tracking-wide font-semibold mt-1">
									Line Items
								</p>
							</div>
							<div className="text-right min-w-0">
								<p className="text-[10px] text-text-tertiary uppercase tracking-wide font-semibold">
									{metaLabel}
								</p>
								<p className="text-sm font-medium text-text-primary mt-1 break-all">
									{metaValue}
								</p>
							</div>
						</div>
					</div>

					{/* Financial lines */}
					<div className="space-y-3">
						{subtotal != null && (
							<div className="flex items-center justify-between text-sm">
								<span className="text-text-tertiary">Subtotal:</span>
								<span className="text-text-primary font-medium tabular-nums">
									{formatCurrency(subtotal)}
								</span>
							</div>
						)}

						{discountAmount != null && Number(discountAmount) > 0 && (
							<div className="flex items-center justify-between text-sm">
								<span className="text-text-tertiary">
									Discount
									{discountType === "percent" && discountValue
										? ` (${Number(discountValue)}%)`
										: ""}
									:
								</span>
								<span className="text-success-text font-medium tabular-nums">
									-{formatCurrency(Number(discountAmount))}
								</span>
							</div>
						)}

						{/* Tax — collapsed per-rate rows, or line-item fallback, or legacy flat-rate */}
						{(() => {
							if (allExempt) {
								return (
									<div className="flex items-center justify-between text-sm">
										<span className="text-text-tertiary">Tax:</span>
										<span className="text-text-primary font-medium">Client is tax exempt</span>
									</div>
								);
							}
							const rates = collapsedTaxRates.length > 0 ? collapsedTaxRates : lineItemCollapsedRates;
							const totalTaxCents = rates.reduce((s, r) => s + r.amountCents, 0);
							const approx = taxIsEstimate ? "≈ " : "";
							const basis = taxBasis(snapshots);
							const provenance = (
								<div className="flex flex-wrap items-center gap-1.5 empty:hidden">
									<TaxSourceChip
										source={source}
										kept={
											isKeptAddressRate(primarySnapshot) &&
											isV2Snapshot(primarySnapshot) &&
											primarySnapshot.kept_from_auto === true
										}
									/>
									{rateLocation && (
										<span className="text-xs text-text-muted">
											Rates for {rateLocation}
										</span>
									)}
									{basis && (
										<span className="text-xs text-text-muted tabular-nums">
											{basis}
										</span>
									)}
								</div>
							);

							if (rates.length > 0) {
								return (
									<>
										{rates.map(rate => (
											<div key={rate.id} className="flex items-center justify-between text-sm">
												<span className="text-text-tertiary">
													{rate.name} ({formatRatePercentLabel(rate.rate)}):
												</span>
												<span className="text-text-primary font-medium tabular-nums">
													{(rates.length === 1 ? approx : "") + formatCurrency(rate.amountCents / 100)}
												</span>
											</div>
										))}
										{rates.length > 1 && (
											<div className="flex items-center justify-between text-sm">
												<span className="text-text-tertiary font-medium">Total Tax:</span>
												<span className="text-text-primary font-medium tabular-nums">
													{approx + formatCurrency(totalTaxCents / 100)}
												</span>
											</div>
										)}
										{provenance}
									</>
								);
							}
							if (legacyTaxAmount != null && Number(legacyTaxAmount) > 0) {
								return (
									<>
										<div className="flex items-center justify-between text-sm">
											<span className="text-text-tertiary">
												Tax{legacyTaxRate != null ? ` (${formatDocRatePercent(legacyTaxRate)})` : ""}:
											</span>
											<span className="text-text-primary font-medium tabular-nums">
												{formatCurrency(Number(legacyTaxAmount))}
											</span>
										</div>
										{provenance}
									</>
								);
							}
							return null;
						})()}

						<div className="border-t border-border my-2" />

						{totalsContent}
					</div>
				</div>
			</div>
		</Card>
	);
}
