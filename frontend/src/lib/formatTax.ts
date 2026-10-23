/**
 * Shared tax formatting utilities.
 * Single source of truth — replaces fmtRate / rateToPercent / formatCombinedRate
 * spread across TaxSettingsSection, FinancialSummary, and tax.ts.
 */

/**
 * Format a decimal rate (0–1) as a compact percentage string.
 * Trailing zeros are stripped.
 *
 * @example
 * formatRatePercent(0.085)  // "8.5"
 * formatRatePercent(0.1)    // "10"
 * formatRatePercent(0.0825) // "8.25"
 */
export function formatRatePercent(rate: number): string {
	return (rate * 100).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Format a decimal rate as a percentage string with a trailing % sign.
 *
 * @example
 * formatRatePercentLabel(0.085) // "8.5%"
 */
export function formatRatePercentLabel(rate: number): string {
	return `${formatRatePercent(rate)}%`;
}

/**
 * Document rates are stored to 6 dp since Phase 1a (resolved district rates); show at most 3.
 *
 * @example formatDocRatePercent(0.054948) // "5.495%"
 */
export function formatDocRatePercent(rate: number | string): string {
	return `${rateToPercentInput(rate)}%`;
}

/** 0–1 rate → percent for editor state, rounded to 3 dp so 0.054948 doesn't surface as 5.4948. */
export function rateToPercentInput(rate: number | string | null | undefined): number {
	if (rate == null || rate === "") return 0;
	return Math.round(Number(rate) * 100 * 1000) / 1000;
}
