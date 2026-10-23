import { RotateCcw } from "lucide-react";
import { useState, useEffect } from "react";
import type { GroupTaxSummary } from "../../../hooks/forms/useFinancialCalculations";
import type { TaxSnapshot } from "../../../types/tax";
import { formatTaxGroupLabel } from "../../../types/tax";
import { formatDocRatePercent, formatRatePercentLabel } from "../../../lib/formatTax";
import { formatCurrency } from "../../../util/util";
import { autoEstimateTax, type AutoTaxState } from "../../../lib/taxEditorMode";

// ─── Props ────────────────────────────────────────────────────────────────────

interface FinancialSummaryProps {
	subtotal: number;
	discountType: "percent" | "amount";
	discountValue: number;
	discountAmount: number;
	total: number;
	isLoading: boolean;
	onDiscountTypeChange: (type: "percent" | "amount") => void;
	onDiscountValueChange: (value: number) => void;
	totalLabel?: string;

	// ── Legacy single-rate props (kept for backward compat) ─────────────────
	/** @deprecated Use groupsSummary + totalTax for new callers */
	taxRate?: number;
	/** @deprecated Use groupsSummary + totalTax for new callers */
	taxAmount?: number;
	/** @deprecated Use groupsSummary + totalTax for new callers */
	onTaxRateChange?: (rate: number) => void;

	// ── Multi-group additions (optional — new callers) ───────────────────────
	/** Per-group tax breakdown from useFinancialCalculations */
	groupsSummary?: GroupTaxSummary[];
	/** Total tax across all groups */
	totalTax?: number;

	// ── Snapshot display (issued invoices) ───────────────────────────────────
	/** When set, all financial values are read from the snapshot (readonly display) */
	snapshot?: TaxSnapshot | null;

	// ── Context ───────────────────────────────────────────────────────────────
	clientExempt?: boolean;
	/** Set only in auto tax mode: replaces the flat rate row with an auto row and estimate. */
	autoTax?: AutoTaxState | null;
	/** Manual mode holding an address rate: the tax row is exact, not an estimate. */
	keptRate?: boolean;
	/**
	 * The address of a kept-rate document changed: "pending" until the dispatcher answers which
	 * tax to use, then the answered group's tax. Replaces the kept/auto row.
	 */
	chosenTax?: { label: string; cents: number } | "pending" | null;

	// ── Edit mode ─────────────────────────────────────────────────────────────
	mode?: "create" | "edit";
	isTaxDirty?: boolean;
	isDiscountDirty?: boolean;
	onTaxUndo?: () => void;
	onDiscountUndo?: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a decimal rate (0–1) as a percentage string, e.g. 0.085 → "8.5%" */
const fmtRate = formatRatePercentLabel;

// ─── Component ────────────────────────────────────────────────────────────────

const FinancialSummary = ({
	subtotal,
	discountType,
	discountValue,
	discountAmount,
	total,
	isLoading,
	onDiscountTypeChange,
	onDiscountValueChange,
	totalLabel = "Total Amount",

	// legacy
	taxRate = 0,
	taxAmount = 0,
	onTaxRateChange,

	// multi-group
	groupsSummary,
	totalTax,

	// snapshot
	snapshot = null,

	// context
	clientExempt = false,
	autoTax = null,
	keptRate = false,
	chosenTax = null,

	// edit mode
	mode = "create",
	isTaxDirty = false,
	isDiscountDirty = false,
	onTaxUndo,
	onDiscountUndo,
}: FinancialSummaryProps) => {
	const [taxDisplay, setTaxDisplay] = useState(String(taxRate));
	const [discountDisplay, setDiscountDisplay] = useState(String(discountValue));

	const showDirty = mode === "edit";

	// Sync display state when props change externally (undo, reset, template pre-fill)
	useEffect(() => {
		setTaxDisplay(String(taxRate));
	}, [taxRate]);

	useEffect(() => {
		setDiscountDisplay(String(discountValue));
	}, [discountValue]);

	const handleTaxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value;
		setTaxDisplay(val);
		if (val !== "" && onTaxRateChange) onTaxRateChange(parseFloat(val) || 0);
	};

	const handleDiscountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const val = e.target.value;
		setDiscountDisplay(val);
		if (val !== "") onDiscountValueChange(parseFloat(val) || 0);
	};

	const taxRowDirty = showDirty && isTaxDirty;
	const discountRowDirty = showDirty && isDiscountDirty;

	// ── Determine display mode ─────────────────────────────────────────────────

	const isSnapshotDisplay = snapshot !== null;

	// Values to actually render (snapshot overrides live props)
	const displaySubtotal = isSnapshotDisplay ? snapshot.subtotal_cents / 100 : subtotal;
	const displayDiscountAmount = isSnapshotDisplay
		? snapshot.discount_cents / 100
		: discountAmount;
	const displayTotal = isSnapshotDisplay ? snapshot.total_cents / 100 : total;

	// ── Resolve tax rows ───────────────────────────────────────────────────────

	type TaxRow = { label: string; amount: number; key: string };

	const taxRows: TaxRow[] = (() => {
		if (clientExempt) return [];

		// Snapshot mode: derive rows from snapshot.groups
		if (isSnapshotDisplay) {
			if (snapshot.groups.length === 0) return [];
			return snapshot.groups.map((sg) => {
				const rateStr = sg.rates
					.map((r) => fmtRate(r.rate))
					.join(" + ");
				const label =
					sg.rates.length > 0
						? `Tax — ${sg.name} (${rateStr})`
						: `Tax — ${sg.name}`;
				return {
					label,
					amount: sg.tax_amount_cents / 100,
					key: sg.id,
				};
			});
		}

		// Multi-group live mode
		if (groupsSummary && groupsSummary.length > 0) {
			if (groupsSummary.length === 1) {
				const gs = groupsSummary[0];
				return [
					{
						label: `Tax (${fmtRate(gs.group.combined_rate)})`,
						amount: gs.tax_amount,
						key: gs.group.id,
					},
				];
			}
			return groupsSummary.map((gs) => ({
				label: `Tax — ${formatTaxGroupLabel(gs.group)}`,
				amount: gs.tax_amount,
				key: gs.group.id,
			}));
		}

		// Legacy single-rate mode: show editable rate row if onTaxRateChange exists.
		// Return [] here — useLegacyTaxRow (below) distinguishes this from "truly no tax".
		return [];
	})();

	// Server ignores client-side tax in auto mode, so the flat rate row would mislead.
	const autoMode = !isSnapshotDisplay && !!autoTax;
	const keptActive = keptRate && autoMode;
	const autoRowActive = autoMode && !clientExempt && (autoTax?.autoTaxableAmount ?? 0) > 0;
	const autoEstimate = autoRowActive ? (autoTax?.estimate ?? null) : null;
	const chosen = autoRowActive ? chosenTax : null;
	const autoTaxAmount =
		chosen === "pending"
			? 0
			: chosen
				? chosen.cents / 100
				: autoEstimate
					? autoEstimateTax(
							autoTax?.autoTaxableAmount ?? 0,
							autoEstimate,
							autoTax?.lineBasesCents,
						)
					: 0;
	// With zero groups, totalTax is the legacy flat-rate amount, which the server drops in auto.
	const overrideTax = groupsSummary && groupsSummary.length > 0 ? (totalTax ?? 0) : 0;

	// Whether we should fall back to the legacy editable tax-rate row
	const useLegacyTaxRow =
		!isSnapshotDisplay &&
		!autoMode &&
		!keptRate &&
		(!groupsSummary || groupsSummary.length === 0) &&
		onTaxRateChange !== undefined;

	// Effective total tax for display
	const displayTotalTax = isSnapshotDisplay
		? snapshot.total_tax_cents / 100
		: (totalTax ?? taxAmount);

	return (
		<div className="relative w-full bg-base rounded-lg border border-border shadow-xl overflow-hidden">
			{/* Loading overlay */}
			{isLoading && (
				<div className="absolute inset-0 bg-base/60 backdrop-blur-[1px] z-10 flex items-center justify-center">
					<div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
				</div>
			)}

			{/* Header */}
			<div className="flex items-center justify-between px-3 py-2 bg-surface border-b border-border">
				<h3 className="text-xs font-bold text-text-primary uppercase tracking-wider">
					Financial Summary
				</h3>
				<div className="text-right">
					<span className="text-[10px] text-text-muted uppercase font-semibold block leading-none">
						Subtotal
					</span>
					<span className="text-sm font-semibold text-text-secondary font-mono tabular-nums">
						{formatCurrency(displaySubtotal)}
					</span>
				</div>
			</div>

			{/* Body */}
			<div className="p-2 space-y-2">
				{/* ── Discount Row ────────────────────────────────────────────── */}
				<div
					className={`group relative flex items-center justify-between p-2 rounded-md transition-all ${
						discountRowDirty
							? "bg-primary/5 border-l-2 border-l-primary"
							: "hover:bg-surface/30"
					}`}
				>
					<div className="flex items-center gap-3 flex-1">
						{!isSnapshotDisplay && (
							<div className="flex items-center bg-canvas rounded border border-border focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/20 transition-all h-7">
								<button
									type="button"
									onClick={() =>
										onDiscountTypeChange(
											discountType === "amount"
												? "percent"
												: "amount"
										)
									}
									className="h-full px-2 text-[10px] font-bold text-text-tertiary hover:text-text-primary hover:bg-surface rounded-l transition-colors border-r border-border-subtle"
									disabled={isLoading}
								>
									{discountType === "amount" ? "$" : "%"}
								</button>
								<input
									type="number"
									step="0.01"
									min="0"
									value={discountDisplay}
									onChange={handleDiscountChange}
									onBlur={() => {
										if (
											discountDisplay === "" ||
											isNaN(parseFloat(discountDisplay))
										) {
											setDiscountDisplay(String(discountValue));
										}
									}}
									className="w-16 bg-transparent border-none text-text-primary text-xs pl-2 pr-2 font-mono outline-none disabled:opacity-50"
									disabled={isLoading}
								/>
							</div>
						)}
						<div className="flex flex-col">
							<span className="text-xs font-medium text-text-secondary">
								Discount
							</span>
							{discountRowDirty && (
								<span className="text-[10px] text-primary-text font-medium">
									Modified
								</span>
							)}
						</div>
					</div>
					<div className="flex items-center gap-3">
						<span className="text-sm font-mono text-success-text/90 tabular-nums w-20 text-right">
							-{formatCurrency(displayDiscountAmount)}
						</span>
						{discountRowDirty && onDiscountUndo && (
							<button
								type="button"
								onClick={onDiscountUndo}
								className="p-1.5 rounded-full hover:bg-surface-raised text-text-muted hover:text-primary-text transition-colors"
								title="Revert Discount"
							>
								<RotateCcw size={12} />
							</button>
						)}
					</div>
				</div>

				{/* ── Tax Section ────────────────────────────────────────────── */}
				{clientExempt ? (
					/* Client exempt badge */
					<div className="flex items-center justify-between p-2 rounded-md">
						<span className="text-xs font-medium text-text-secondary">Tax</span>
						<span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-success/15 text-success-text border border-success/25">
							Exempt
						</span>
					</div>
				) : useLegacyTaxRow ? (
					/* Legacy editable single-rate tax row */
					<div
						className={`group relative flex items-center justify-between p-2 rounded-md transition-all ${
							taxRowDirty
								? "bg-primary/5 border-l-2 border-l-primary"
								: "hover:bg-surface/30"
						}`}
					>
						<div className="flex items-center gap-3 flex-1">
							<div className="relative flex items-center">
								<input
									type="number"
									step="0.01"
									min="0"
									max="100"
									value={taxDisplay}
									onChange={handleTaxChange}
									onBlur={() => {
										if (
											taxDisplay === "" ||
											isNaN(parseFloat(taxDisplay))
										) {
											setTaxDisplay(String(taxRate));
										}
									}}
									className="w-20 h-7 bg-canvas border border-border rounded text-text-primary text-xs pl-2 pr-6 font-mono focus:border-primary focus:ring-1 focus:ring-primary/20 outline-none transition-all disabled:opacity-50"
									disabled={isLoading}
								/>
								<span className="absolute right-2 text-text-muted text-[10px] font-medium">
									%
								</span>
							</div>
							<div className="flex flex-col">
								<span className="text-xs font-medium text-text-secondary">
									Tax Rate
								</span>
								{taxRowDirty && (
									<span className="text-[10px] text-primary-text font-medium">
										Modified
									</span>
								)}
							</div>
						</div>
						<div className="flex items-center gap-3">
							<span className="text-sm font-mono text-text-secondary tabular-nums w-20 text-right">
								{formatCurrency(taxAmount)}
							</span>
							{taxRowDirty && onTaxUndo && (
								<button
									type="button"
									onClick={onTaxUndo}
									className="p-1.5 rounded-full hover:bg-surface-raised text-text-muted hover:text-primary-text transition-colors"
									title="Revert Tax Rate"
								>
									<RotateCcw size={12} />
								</button>
							)}
						</div>
					</div>
				) : taxRows.length > 0 ? (
					/* Multi-group / snapshot tax rows */
					<div className="space-y-1">
						{taxRows.map((row) => (
							<div
								key={row.key}
								className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-surface/30 transition-colors"
							>
								<span className="text-xs font-medium text-text-secondary">
									{row.label}
								</span>
								<span className="text-sm font-mono text-text-secondary tabular-nums w-20 text-right">
									{formatCurrency(row.amount)}
								</span>
							</div>
						))}
						{taxRows.length > 1 && (
							<div className="flex items-center justify-between px-2 py-1 border-t border-border-subtle mt-1">
								<span className="text-[10px] font-semibold text-text-muted uppercase tracking-wide">
									Total Tax
								</span>
								<span className="text-xs font-mono text-text-muted tabular-nums w-20 text-right">
									{formatCurrency(displayTotalTax)}
								</span>
							</div>
						)}
					</div>
				) : autoRowActive ? null : (
					/* No tax groups, no legacy rate — show zero tax row */
					<div className="flex items-center justify-between px-2 py-1.5 rounded-md">
						<span className="text-xs font-medium text-text-secondary">Tax</span>
						<span className="text-sm font-mono text-text-secondary tabular-nums w-20 text-right">
							{formatCurrency(0)}
						</span>
					</div>
				)}

				{chosen && (
					<div className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-surface/30 transition-colors">
						<span className="text-xs font-medium text-text-secondary">
							{chosen === "pending" ? (
								<>
									Tax <span className="text-text-muted">Choose a tax above</span>
								</>
							) : (
								`Tax — ${chosen.label}`
							)}
						</span>
						<span className="text-sm font-mono text-text-secondary tabular-nums w-20 text-right">
							{chosen === "pending" ? "—" : formatCurrency(autoTaxAmount)}
						</span>
					</div>
				)}

				{autoRowActive && !chosen && (
					<div className="flex items-center justify-between px-2 py-1.5 rounded-md hover:bg-surface/30 transition-colors">
						<span className="text-xs font-medium text-text-secondary">
							{autoEstimate
								? keptActive
									? "Tax — Address rate (kept)"
									: "Tax — Auto"
								: "Tax"}{" "}
							<span className="text-text-muted">
								{autoEstimate
									? `(${keptActive ? "" : "est. "}${formatDocRatePercent(autoEstimate.rate)} · ${autoEstimate.place})`
									: keptRate
										? "Calculated on save"
										: "Auto — calculated on save"}
							</span>
						</span>
						<span className="text-sm font-mono text-text-secondary tabular-nums w-20 text-right">
							{autoEstimate
								? `${keptActive ? "" : "≈ "}${formatCurrency(autoTaxAmount)}`
								: "—"}
						</span>
					</div>
				)}
			</div>

			{/* Footer / Total */}
			<div className="bg-surface/80 px-4 py-2 border-t border-border flex items-center justify-between">
				<span className="text-xs font-bold text-text-tertiary uppercase tracking-wider">
					{autoRowActive
						? chosen === "pending"
							? `${totalLabel} (before tax)`
							: chosen
								? totalLabel
								: autoEstimate
									? keptActive
										? totalLabel
										: `Est. ${totalLabel}`
									: `${totalLabel} (before ${keptRate ? "" : "auto "}tax)`
						: totalLabel}
				</span>
				<span className="text-lg font-bold text-text-primary font-mono tabular-nums tracking-tight">
					{formatCurrency(
						autoMode
							? subtotal - discountAmount + overrideTax + autoTaxAmount
							: displayTotal,
					)}
				</span>
			</div>
		</div>
	);
};

export default FinancialSummary;
