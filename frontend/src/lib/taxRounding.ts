// Mirror of backend/src/services/tax/rounding.ts (+ roundingFor from services/tax/snapshot.ts).
import type { TaxSnapshot } from "../types/tax";

export type TaxRounding = "line_floor" | "jurisdiction_half_up";

/**
 * Rates are numeric(8,6) and bases are integer cents, so every true product has at most 6
 * decimals; snapping to 6 dp recovers it exactly. Without this 200 x 0.0725 evaluates to
 * 14.499999999999998 and half-up would give 14 where the true 14.5 gives 15.
 */
export function stripFloatNoise(value: number): number {
	const snapped = Math.round(Math.abs(value) * 1e6) / 1e6;
	return value < 0 ? -snapped : snapped;
}

/** Half-up on the magnitude, so a credit rounds exactly like the matching charge: -2.5 → -3. */
export function roundHalfUpSymmetric(value: number): number {
	const v = stripFloatNoise(value);
	return (v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5)) + 0;
}

export function truncateTowardZero(value: number): number {
	return (value < 0 ? -Math.floor(-value) : Math.floor(value)) + 0;
}

/** A saved document keeps the rounding it was taxed with; a new one (no snapshot) is half-up. */
export function roundingFor(snapshot: TaxSnapshot | null | undefined): TaxRounding {
	if (snapshot == null) return "jurisdiction_half_up";
	return (snapshot as { rounding?: unknown }).rounding === "jurisdiction_half_up"
		? "jurisdiction_half_up"
		: "line_floor";
}

/**
 * Rounding for a job editor. A manual-mode job is taxed by the client unless it holds a kept
 * address rate (`kept`), so a null snapshot cannot mean "new document" there: it stays
 * line_floor. A kept job is taxed server-side with its snapshot's rounding, as in auto mode.
 * `autoMode` undefined = still loading: an existing job holds line_floor (no flip of a legacy
 * job), a new one assumes auto.
 */
export function jobRounding(
	autoMode: boolean | undefined,
	snapshot: TaxSnapshot | null | undefined,
	isNew: boolean,
	kept = false
): TaxRounding {
	if (isNew) return autoMode === false ? "line_floor" : "jurisdiction_half_up";
	return autoMode === true || kept ? roundingFor(snapshot) : "line_floor";
}

/**
 * Per-rate cents of a saved snapshot group, as backend reportsController's tax-liability split
 * derives them. Half-up groups were taxed one rate at a time on this base, so recomputing is
 * exact; line_floor groups floor each rate and put the remainder on the last so they sum to the
 * stored group total.
 */
export function snapshotRateCents(
	group: {
		rates: readonly { rate: number }[];
		taxable_amount_cents: number;
		tax_amount_cents: number;
	},
	rounding: TaxRounding
): number[] {
	const base = group.taxable_amount_cents;
	const perRate = group.rates.map((r) =>
		rounding === "jurisdiction_half_up"
			? roundHalfUpSymmetric(base * r.rate)
			: Math.floor(base * r.rate)
	);
	if (perRate.length > 0) {
		perRate[perRate.length - 1] += group.tax_amount_cents - perRate.reduce((s, n) => s + n, 0);
	}
	return perRate;
}
