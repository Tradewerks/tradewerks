/** How many leading items fit in `available` px. When not all fit, a more-row of
 *  `moreRowH` (plus one gap) is reserved so it never pushes the last card out. */
export function computeFitCount(
	heights: number[],
	gap: number,
	available: number,
	moreRowH: number
): number {
	if (heights.length === 0) return 0;
	const total = heights.reduce((sum, h, i) => sum + h + (i > 0 ? gap : 0), 0);
	if (total <= available) return heights.length;

	const budget = available - moreRowH - gap;
	let used = 0;
	let fit = 0;
	for (let i = 0; i < heights.length; i++) {
		const next = used + heights[i] + (i > 0 ? gap : 0);
		if (next > budget) break;
		used = next;
		fit = i + 1;
	}
	return fit;
}
