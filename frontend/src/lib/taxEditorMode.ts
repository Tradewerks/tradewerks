import { formatDocRatePercent } from "./formatTax";
import { isV2Snapshot, type TaxSnapshot, type TaxSnapshotGroup, type TaxSource } from "../types/tax";
import type { Job } from "../types/jobs";
import {
	roundHalfUpSymmetric,
	roundingFor,
	truncateTowardZero,
	type TaxRounding,
} from "./taxRounding";

/**
 * Default group to stamp on new lines: none in auto, none until the mode is known.
 * The server reads a stamped group as a manual override, so stamping in auto (or while the
 * mode is still loading) would stop address-based resolution from ever running.
 */
export function defaultGroupForMode(
	autoMode: boolean | undefined,
	defaultGroupId: string | null | undefined,
): string | null {
	if (autoMode !== false) return null;
	return defaultGroupId ?? null;
}

/**
 * Line tax fields for an update payload. The server only writes `tax_group_id` when the key is
 * present, so an ungrouped line must send null or a line reverted to Auto keeps its old group.
 */
export function lineTaxPayload(item: { taxable?: boolean; tax_group_id?: string | null }): {
	taxable: boolean | undefined;
	tax_group_id: string | null;
} {
	return { taxable: item.taxable, tax_group_id: item.tax_group_id ?? null };
}

/**
 * The group the server taxes a line with: its own, else the client's (spec §4.3). Only an
 * ungrouped line on a client with no group reaches the org default or the address rate.
 */
export function effectiveLineGroupId(
	lineGroupId: string | null | undefined,
	clientGroupId: string | null | undefined,
): string | null {
	return lineGroupId ?? clientGroupId ?? null;
}

/**
 * Saved-document twin of effectiveLineGroupId, for a taxable line with no group of its own and
 * a non-address source. The snapshot does not record which group taxed such a line, but it is
 * the one group no line names. Null when untaxed (no source) or undecidable.
 */
export function ungroupedLineGroup(
	snapshot: TaxSnapshot | null | undefined,
	source: TaxSource | null | undefined,
	lineGroupNames: Iterable<string>,
): TaxSnapshotGroup | null {
	if (!snapshot || snapshot.client_exempt || !source) return null;
	const named = new Set(lineGroupNames);
	const unnamed = snapshot.groups.filter((g) => !named.has(g.name));
	if (unnamed.length === 1) return unnamed[0];
	return unnamed.length === 0 && snapshot.groups.length === 1 ? snapshot.groups[0] : null;
}

export interface AutoTaxEstimate {
	rate: number;
	rates: number[];
	place: string;
	rounding: TaxRounding;
}

export interface AutoTaxState {
	/** Pre-tax amount on taxable lines with no group (dollars, after pro-rated discount). */
	autoTaxableAmount: number;
	estimate: AutoTaxEstimate | null;
	/** Per-line taxable cents behind autoTaxableAmount; line_floor floors each line and rate. */
	lineBasesCents?: number[];
}

/** A v2 snapshot with a rate set from an address source (kept_from_auto or not). */
export function isKeptAddressRate(snapshot: TaxSnapshot | null | undefined): boolean {
	if (!isV2Snapshot(snapshot) || !snapshot.rate_set_id) return false;
	return (
		snapshot.source === "provider" ||
		snapshot.source === "cached_stale" ||
		snapshot.source === "qb_ast"
	);
}

/** Estimate for a manual-mode document that still holds its address rate; null otherwise. */
export function keptRateEstimate(
	snapshot: TaxSnapshot | null | undefined,
	autoMode: boolean | undefined,
	addressChanged: boolean,
): AutoTaxEstimate | null {
	if (autoMode !== false || !isKeptAddressRate(snapshot)) return null;
	return autoTaxEstimate(snapshot, addressChanged);
}

/**
 * Kept-rate estimate for an editor, as backend docKeptRate finds it: the document's own snapshot,
 * else (none of its own; callers pass no parent for an adjustment) the parent's it was made from.
 * Rounding stays the document's own, so an inherited rate rounds as roundingFor(null).
 */
export function docKeptEstimate(
	own: TaxSnapshot | null | undefined,
	parent: TaxSnapshot | null | undefined,
	autoMode: boolean | undefined,
): AutoTaxEstimate | null {
	const estimate = keptRateEstimate(own ?? parent, autoMode, false);
	return estimate && { ...estimate, rounding: roundingFor(own) };
}

/** The snapshot a job hands its visits a kept rate from, as the backend visit loader reads it. */
export function jobKeptSource(
	job: Pick<Job, "tax_snapshot" | "quote"> | null | undefined,
): TaxSnapshot | null {
	return job?.tax_snapshot ?? job?.quote?.tax_snapshot ?? null;
}

export function keptRateOptionLabel(e: AutoTaxEstimate): string {
	return `Address rate · ${e.place} ${formatDocRatePercent(e.rate)}`;
}

/** Estimate from the saved v2 snapshot's resolved group; null if address changed or none resolved. */
export function autoTaxEstimate(
	snapshot: TaxSnapshot | null | undefined,
	addressChanged: boolean,
): AutoTaxEstimate | null {
	if (addressChanged || !isV2Snapshot(snapshot) || !snapshot.rate_set_id) return null;
	const group = snapshot.groups.find((g) => g.id === snapshot.rate_set_id);
	if (!group) return null;
	return {
		rate: group.rates.reduce((sum, r) => sum + r.rate, 0),
		rates: group.rates.map((r) => r.rate),
		place: group.name.replace(/ \(auto\)$/, ""),
		rounding: roundingFor(snapshot),
	};
}

/**
 * Estimated tax (dollars) on the ungrouped taxable amount. Half-up rounds each rate once on the
 * aggregate base, as the engine does for the one address group those lines all share.
 */
export function autoEstimateTax(
	autoTaxableAmount: number,
	estimate: AutoTaxEstimate,
	lineBasesCents?: number[],
): number {
	if (estimate.rounding !== "jurisdiction_half_up" && lineBasesCents) {
		// Engine parity: floor toward zero per line, per rate.
		let cents = 0;
		for (const base of lineBasesCents) {
			for (const r of estimate.rates) cents += truncateTowardZero(base * r);
		}
		return cents / 100;
	}
	if (estimate.rounding === "jurisdiction_half_up") {
		const base = Math.round(autoTaxableAmount * 100);
		return estimate.rates.reduce((sum, r) => sum + roundHalfUpSymmetric(base * r), 0) / 100;
	}
	return Math.floor(Math.round(autoTaxableAmount * 100 * estimate.rate * 1e6) / 1e6) / 100;
}

/** Mirrors calculateMultiGroupTax's cent-level pro-rated discount, for ungrouped taxable lines. */
export function autoTaxableLineCents(
	lines: { total: number; taxable: boolean; tax_group_id: string | null }[],
	discountAmount: number,
): number[] {
	const cents = lines.map((l) => Math.round(l.total * 100));
	const subtotalCents = cents.reduce((a, b) => a + b, 0);
	const discountCents = Math.round(discountAmount * 100);
	const bases: number[] = [];
	lines.forEach((l, i) => {
		if (!l.taxable || l.tax_group_id) return;
		const share = subtotalCents > 0 ? Math.floor((cents[i] / subtotalCents) * discountCents) : 0;
		bases.push(cents[i] - share);
	});
	return bases;
}

export function autoTaxableAmount(
	lines: { total: number; taxable: boolean; tax_group_id: string | null }[],
	discountAmount: number,
): number {
	return autoTaxableLineCents(lines, discountAmount).reduce((a, b) => a + b, 0) / 100;
}

/** FinancialSummary's `autoTax` prop: null outside auto mode. */
export function editorAutoTax(
	autoMode: boolean,
	lines: { total: number; taxable: boolean; tax_group_id: string | null }[],
	discountAmount: number,
	snapshot: TaxSnapshot | null | undefined = null,
	addressChanged = false,
	kept = false,
	/** Overrides the snapshot's rounding, for a rate inherited from a parent document. */
	rounding?: TaxRounding,
): AutoTaxState | null {
	if (!autoMode && !kept) return null;
	const estimate = autoTaxEstimate(snapshot, addressChanged);
	return {
		autoTaxableAmount: autoTaxableAmount(lines, discountAmount),
		lineBasesCents: autoTaxableLineCents(lines, discountAmount),
		estimate: estimate && rounding ? { ...estimate, rounding } : estimate,
	};
}

/** The flat-rate handler, withheld when auto mode or a tax group decides the rate. */
export function flatRateHandler(
	autoMode: boolean,
	groupCount: number,
	handler: (rate: number) => void,
): ((rate: number) => void) | undefined {
	return autoMode || groupCount > 0 ? undefined : handler;
}

/** A tax `<select>` value ("auto", "none" or a group id) as the line's group and taxable flag. */
export function parseTaxChoice(value: string): [groupId: string | null, taxable: boolean] {
	if (value === "none") return [null, false];
	if (value === "auto") return [null, true];
	return [value, true];
}
