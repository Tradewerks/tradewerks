import { useMemo } from "react";
import { Link } from "react-router-dom";
import { FileText } from "lucide-react";
import Card from "../ui/Card";
import type { Invoice, InvoiceLineItem } from "../../types/invoices";
import { isOverdue } from "../../types/invoices";
import { isV2Snapshot, snapshotSource } from "../../types/tax";
import type { TaxSnapshotRate } from "../../types/tax";
import { formatCurrency } from "../../util/util";
import { formatDocRatePercent, formatRatePercentLabel } from "../../lib/formatTax";
import {
	autoRateLocation,
	collapseSnapshotRates,
	isAddressRateSnapshot,
	taxBasis,
	type CollapsedRate,
} from "../../lib/taxBreakdown";
import { QbTaxEstimate } from "../tax/QbTaxEstimate";
import { AutoLineTaxTag, TaxSourceChip } from "../tax/TaxSourceChip";
import {
	groupLineItemsBySource,
	resolveLineSources,
	shouldGroupBySource,
	type LineItemGroup,
} from "./invoiceSources";
import { isKeptAddressRate, ungroupedLineGroup } from "../../lib/taxEditorMode";

interface InvoiceLineItemsProps {
	invoice: Invoice;
	/** Line item ids named by any dispute on this invoice, open or resolved. */
	contestedIds: Set<string>;
}

const HEADER_CELL = "min-w-0 text-xs font-semibold uppercase tracking-wide text-text-tertiary";

/** One line: name, type, qty, unit price, amount, and its secondary sub-row. */
function LineRow({
	item,
	isContested,
	groupRatesMap,
	addressSourced,
	ungroupedGroupName,
}: {
	item: InvoiceLineItem;
	isContested: boolean;
	groupRatesMap: Map<string, TaxSnapshotRate[]>;
	addressSourced: boolean;
	/** Group that taxed lines with no group of their own (client group, org default). */
	ungroupedGroupName: string | null;
}) {
	// Manual mode stamps the default group on non-taxable lines too.
	const groupName =
		item.taxable === false ? null : item.tax_group?.name || ungroupedGroupName;
	const autoTaxed = item.taxable !== false && !groupName && addressSourced;
	const hasSubRow =
		(item.description != null && item.description !== "") ||
		groupName != null ||
		item.taxable === false ||
		autoTaxed;

	return (
		<div
			className={`border-b border-border-subtle transition-colors hover:bg-surface/30${
				isContested ? " border-l-2 border-l-warning-border" : ""
			}`}
		>
			<div className="grid grid-cols-12 items-center gap-2 pb-1 pt-3">
				<div className="col-span-5 min-w-0 text-sm">
					<p className="break-words font-medium text-text-primary">
						{item.name}
					</p>
					{isContested && (
						<span className="mt-0.5 inline-block text-xs font-medium text-warning-text">
							Contested
						</span>
					)}
				</div>
				<div className="col-span-2 flex min-w-0 justify-center">
					{item.item_type != null && (
						<span className="inline-block max-w-full truncate rounded border border-border-strong bg-surface-raised px-1.5 py-0.5 text-xs font-medium text-text-secondary">
							{item.item_type}
						</span>
					)}
				</div>
				<div
					className="col-span-1 min-w-0 text-right text-sm tabular-nums text-text-primary"
					title={String(item.quantity)}
				>
					{Number(item.quantity).toLocaleString("en-US", {
						minimumFractionDigits: 0,
						maximumFractionDigits: 2,
					})}
				</div>
				<div className="col-span-2 min-w-0 text-right text-sm tabular-nums text-text-primary">
					{formatCurrency(Number(item.unit_price))}
				</div>
				<div className="col-span-2 min-w-0 text-right text-sm font-semibold tabular-nums text-text-primary">
					{formatCurrency(Number(item.total))}
				</div>
			</div>

			{/* Sub-row — only when there is secondary content. The source badge
			    that used to live here is gone: origin is a property of the
			    group a line sits in, not a chip repeated on every row. */}
			{hasSubRow && (
				<div className="min-w-0 space-y-1 pb-2.5">
					{item.description != null && item.description !== "" && (
						<p className="break-words text-xs leading-relaxed text-text-tertiary">
							{item.description}
						</p>
					)}
					<div className="flex flex-wrap items-center gap-1.5">
						{groupName ? (
							<span className="inline-flex items-center gap-1 whitespace-nowrap rounded border border-border-strong/50 bg-surface-raised/60 px-1.5 py-0.5 text-[10px] font-medium leading-none text-text-muted">
								{groupName}
								{groupRatesMap.has(groupName)
									? ` · ${groupRatesMap
											.get(groupName)!
											.map(
												(r) =>
													`${r.name} ${formatRatePercentLabel(r.rate)}`
											)
											.join(" + ")}`
									: ""}
							</span>
						) : autoTaxed ? (
							<AutoLineTaxTag />
						) : (
							<span className="inline-flex items-center whitespace-nowrap rounded border border-border-strong/30 bg-surface-raised/40 px-1.5 py-0.5 text-[10px] leading-none text-text-faint">
								No Tax
							</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * The group header: where these lines came from, and what they come to. The
 * subtotal sits in the column the line amounts already occupy, so one source's
 * charges reconcile straight down.
 */
function GroupHeader({ group }: { group: LineItemGroup }) {
	const amount = (
		<span className="flex-shrink-0 text-sm font-semibold tabular-nums text-text-secondary">
			{formatCurrency(group.subtotal)}
		</span>
	);

	return (
		<div className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 pt-4">
			{group.source ? (
				<Link
					to={group.source.to}
					className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-primary-text transition-colors duration-150 ease-out hover:text-text-primary"
				>
					{group.source.label}
				</Link>
			) : (
				<span className="min-w-0 truncate text-xs font-semibold uppercase tracking-wide text-text-muted">
					Not attributed
				</span>
			)}
			{amount}
		</div>
	);
}

/**
 * The invoice's lines, grouped by the work they bill when there is more than
 * one source. Grouping is presentation only — within a group the lines keep the
 * server's `sort_order`, which is the flat sequence the PDF prints.
 */
export default function InvoiceLineItems({ invoice, contestedIds }: InvoiceLineItemsProps) {
	const lineItems = useMemo(() => invoice.line_items ?? [], [invoice.line_items]);

	// Map group name -> rates, for the per-line tax badge.
	const groupRatesMap = useMemo(() => {
		const map = new Map<string, TaxSnapshotRate[]>();
		for (const group of invoice.tax_snapshot?.groups ?? []) {
			if ((group.rates ?? []).length > 0) map.set(group.name, group.rates);
		}
		return map;
	}, [invoice.tax_snapshot]);

	const collapsedTaxRates = useMemo(
		() => collapseSnapshotRates(invoice.tax_snapshot),
		[invoice.tax_snapshot]
	);

	// Fallback: derive per-rate totals from line items when no snapshot exists.
	const lineItemCollapsedRates = useMemo((): CollapsedRate[] => {
		if (collapsedTaxRates.length > 0) return [];
		const rateMap = new Map<string, CollapsedRate>();
		for (const item of lineItems) {
			if (!item.taxable || item.tax_amount == null || !item.tax_group?.rates?.length)
				continue;
			const itemTaxCents = Math.round(Number(item.tax_amount) * 100);
			if (itemTaxCents === 0) continue;
			const combinedRate = item.tax_group.rates.reduce(
				(s, r) => s + r.tax_rate.rate,
				0
			);
			if (combinedRate === 0) continue;
			for (const r of item.tax_group.rates) {
				const share = Math.round(
					itemTaxCents * (r.tax_rate.rate / combinedRate)
				);
				const existing = rateMap.get(r.tax_rate.id);
				if (existing) {
					existing.amountCents += share;
				} else {
					rateMap.set(r.tax_rate.id, {
						id: r.tax_rate.id,
						name: r.tax_rate.name,
						rate: r.tax_rate.rate,
						amountCents: share,
					});
				}
			}
		}
		return [...rateMap.values()];
	}, [collapsedTaxRates, lineItems]);

	const groups = useMemo(
		() => groupLineItemsBySource(lineItems, resolveLineSources(invoice)),
		[lineItems, invoice]
	);
	const grouped = shouldGroupBySource(groups);

	const total = Number(invoice.total ?? 0);
	const amountPaid = Number(invoice.amount_paid ?? 0);
	const balanceDue = Number(invoice.balance_due ?? 0);
	const overdue = isOverdue(invoice);

	const rates = collapsedTaxRates.length > 0 ? collapsedTaxRates : lineItemCollapsedRates;
	const totalTaxCents = rates.reduce((s, r) => s + r.amountCents, 0);

	if (lineItems.length === 0) {
		return (
			<Card title="Line Items">
				<div className="py-8 text-center">
					<FileText size={40} className="mx-auto mb-3 text-text-faint" />
					<p className="text-sm text-text-tertiary">No line items</p>
				</div>
			</Card>
		);
	}

	const taxSource = invoice.tax_source ?? snapshotSource(invoice.tax_snapshot);
	const addressSourced = isAddressRateSnapshot(invoice.tax_snapshot, taxSource);
	// QuickBooks' tax is the invoice's tax; the snapshot's groups are only our estimate.
	const qbSnapshot =
		taxSource === "qb_ast" &&
		isV2Snapshot(invoice.tax_snapshot) &&
		invoice.tax_snapshot.qb_tax_cents != null
			? invoice.tax_snapshot
			: null;
	const qbTaxCents = qbSnapshot?.qb_tax_cents ?? null;
	const rateLocation = autoRateLocation(invoice.tax_snapshot);
	const basis = taxBasis(invoice.tax_snapshot);
	// QuickBooks charging tax on an exempt client is shown as charged, not hidden.
	const exempt = invoice.tax_snapshot?.client_exempt === true && qbTaxCents == null;
	const ungroupedGroupName = addressSourced
		? null
		: (ungroupedLineGroup(
				invoice.tax_snapshot,
				taxSource,
				lineItems.flatMap((li) => (li.tax_group?.name ? [li.tax_group.name] : [])),
			)?.name ?? null);

	const renderRows = (items: InvoiceLineItem[]) =>
		items.map((item, index) => (
			<LineRow
				key={item.id ?? index}
				item={item}
				isContested={item.id != null && contestedIds.has(item.id)}
				groupRatesMap={groupRatesMap}
				addressSourced={addressSourced}
				ungroupedGroupName={ungroupedGroupName}
			/>
		));

	return (
		<Card title="Line Items">
			<div>
				{/* Column header. In grouped mode it sits above the first group
				    rather than repeating per group — the columns do not change,
				    and repeating them would triple the chrome. */}
				<div className="grid grid-cols-12 gap-2 border-b border-border pb-2">
					<div className={`col-span-5 ${HEADER_CELL}`}>Item / Description</div>
					<div className={`col-span-2 text-center ${HEADER_CELL}`}>Type</div>
					<div className={`col-span-1 text-right ${HEADER_CELL}`}>Qty</div>
					<div className={`col-span-2 text-right ${HEADER_CELL}`}>Unit Price</div>
					<div className={`col-span-2 text-right ${HEADER_CELL}`}>Amount</div>
				</div>

				{grouped
					? groups.map((group) => (
							<div
								key={
									group.source
										? `${group.source.kind}:${group.source.id}`
										: "unattributed"
								}
							>
								<GroupHeader group={group} />
								{renderRows(group.items)}
							</div>
						))
					: renderRows(lineItems)}

				{/* Totals — the whole invoice, below every group. Tax and
				    discount are invoice-level facts; splitting them per source
				    would invent numbers the tax snapshot never recorded. */}
				<div className="mt-4 space-y-2 pt-2">
					{invoice.subtotal != null && (
						<div className="flex justify-between text-sm">
							<span className="text-text-tertiary">Subtotal</span>
							<span className="tabular-nums text-text-primary">
								{formatCurrency(Number(invoice.subtotal))}
							</span>
						</div>
					)}

					{invoice.discount_amount != null &&
						Number(invoice.discount_amount) > 0 && (
							<div className="flex justify-between text-sm">
								<span className="text-text-tertiary">Discount</span>
								<span className="tabular-nums text-success-text">
									{"- "}
									{formatCurrency(
										Number(invoice.discount_amount)
									)}
								</span>
							</div>
						)}

					{exempt ? (
						<div className="flex justify-between text-sm">
							<span className="text-text-tertiary">Tax</span>
							<span className="text-text-primary">Client is tax exempt</span>
						</div>
					) : qbTaxCents != null ? (
						<div className="flex justify-between text-sm">
							<span className="text-text-tertiary">
								Sales tax (calculated by QuickBooks)
							</span>
							<span className="tabular-nums text-text-primary">
								{formatCurrency(qbTaxCents / 100)}
							</span>
						</div>
					) : rates.length > 0 ? (
						<>
							{rates.map((rate) => (
								<div
									key={rate.id}
									className="flex justify-between text-sm"
								>
									<span className="text-text-tertiary">
										{rate.name} (
										{formatRatePercentLabel(
											rate.rate
										)}
										)
									</span>
									<span className="tabular-nums text-text-primary">
										{formatCurrency(
											rate.amountCents / 100
										)}
									</span>
								</div>
							))}
							{rates.length > 1 && (
								<div className="flex justify-between text-sm">
									<span className="font-medium text-text-tertiary">
										Total Tax
									</span>
									<span className="font-medium tabular-nums text-text-primary">
										{formatCurrency(
											totalTaxCents / 100
										)}
									</span>
								</div>
							)}
						</>
					) : (
						invoice.tax_rate != null &&
						Number(invoice.tax_rate) > 0 && (
							<div className="flex justify-between text-sm">
								<span className="text-text-tertiary">
									Tax ({formatDocRatePercent(invoice.tax_rate)})
								</span>
								<span className="tabular-nums text-text-primary">
									{formatCurrency(
										Number(invoice.tax_amount ?? 0)
									)}
								</span>
							</div>
						)
					)}

					{!exempt && (
						<div className="flex flex-wrap items-center gap-1.5 empty:hidden">
							<TaxSourceChip
								source={taxSource}
								kept={
									isKeptAddressRate(invoice.tax_snapshot) &&
									isV2Snapshot(invoice.tax_snapshot) &&
									invoice.tax_snapshot.kept_from_auto === true
								}
							/>
							{rateLocation && (
								<span className="text-xs text-text-muted">
									Rates for {rateLocation}
								</span>
							)}
							{basis && (
								<span className="text-xs tabular-nums text-text-muted">{basis}</span>
							)}
						</div>
					)}
					{qbSnapshot && <QbTaxEstimate snapshot={qbSnapshot} />}

					<div className="flex justify-between border-t border-border pt-2">
						<span className="font-semibold text-text-primary">Total</span>
						<span className="text-lg font-bold tabular-nums text-text-primary">
							{formatCurrency(total)}
						</span>
					</div>

					{amountPaid > 0 && (
						<>
							<div className="flex justify-between text-sm">
								<span className="text-text-tertiary">
									Amount Paid
								</span>
								<span className="tabular-nums text-success-text">
									{"- "}
									{formatCurrency(amountPaid)}
								</span>
							</div>
							<div className="flex justify-between border-t border-border pt-2">
								<span className="font-semibold text-text-primary">
									Balance Due
								</span>
								<span
									className={`text-lg font-bold tabular-nums ${
										balanceDue > 0
											? overdue
												? "text-error-text"
												: "text-warning-text"
											: "text-success-text"
									}`}
								>
									{formatCurrency(balanceDue)}
								</span>
							</div>
						</>
					)}
				</div>
			</div>
		</Card>
	);
}
