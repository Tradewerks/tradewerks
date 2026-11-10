/**
 * Per-jurisdiction half-up tax rounding. Pure and dependency-free so the
 * frontend can mirror it line for line.
 */

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
	// `+ 0` turns -0 into 0: a -0.3 credit's tax is plain zero, not a negative zero.
	return (v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5)) + 0;
}

function truncate(value: number): number {
	return (value < 0 ? -Math.floor(-value) : Math.floor(value)) + 0;
}

/**
 * Tax one rate on the aggregate of `bases` (integer cents, any sign), then split the rounded
 * total back over the lines by largest remainder. The split always sums to `total`.
 */
export function allocateHalfUp(
	bases: readonly number[],
	rate: number,
): { total: number; perLine: number[] } {
	const base = bases.reduce((sum, b) => sum + b, 0);
	const total = roundHalfUpSymmetric(base * rate);
	const shares = bases.map((b) => stripFloatNoise(b * rate));
	const perLine = shares.map(truncate);
	let leftover = total - perLine.reduce((sum, n) => sum + n, 0);
	if (leftover === 0 || perLine.length === 0) return { total, perLine };

	// Ranked by signed remainder, not magnitude: in a mixed-sign group a +1 cent must go to the
	// line whose share sits furthest above its truncation, never to a credit line (which would
	// be pushed across zero). For a single-sign group the two orders coincide.
	const step = leftover > 0 ? 1 : -1;
	const order = shares
		.map((s, i) => ({ i, rem: s - perLine[i] }))
		.sort((a, b) => step * (b.rem - a.rem) || a.i - b.i)
		.map((r) => r.i);
	for (let k = 0; leftover !== 0; k++) {
		perLine[order[k % order.length]] += step;
		leftover -= step;
	}
	return { total, perLine };
}
