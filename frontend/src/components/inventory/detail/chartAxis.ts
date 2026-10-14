// Recharts prop objects shared by the History tab's charts. Kept out of
// chartShared.tsx (which exports components) so Fast Refresh isn't broken.

/**
 * Fixed height for the two side-by-side chart cards' collapsed body, so they
 * match without `h-full` stretch. The expanded disclosure panel sits outside
 * it, letting one card grow without affecting its neighbour.
 */
export const CHART_BODY_H = "h-[300px]";

/** Axis tick typography — identical on every axis of every chart on this tab. */
export const CHART_TICK = { fill: "var(--color-chart-axis)", fontSize: 12 } as const;

/** Horizontal-only grid: the shared backdrop behind every plot on this tab. */
export const CHART_GRID = { stroke: "var(--color-border-subtle)", vertical: false } as const;

/** Below this width, a domain gets padded — see `resolveTimeDomain`. */
const MIN_DOMAIN_SPAN_MS = 12 * 60 * 60 * 1000;

/**
 * Resolves the numeric domain for `timeXAxis`, computing it from the series'
 * own timestamps when the caller has no shared range to hand down.
 *
 * A domain whose min and max collapse to the same value — one data point, or
 * several sharing a timestamp — makes Recharts render duplicate, fully
 * overlapping tick labels: `getTicksEnd`'s collision avoidance derives its
 * sweep direction from `sign(tick1.coordinate - tick0.coordinate)`, and two
 * ticks at the same coordinate zero that out, which disables `minTickGap`
 * entirely instead of hiding the duplicate. Padding a near-zero span keeps
 * the domain (and therefore every tick coordinate) non-degenerate.
 */
export const resolveTimeDomain = (
	points: { ts: number }[],
	xDomain?: [number, number],
): [number, number] => {
	if (xDomain) return xDomain;
	if (points.length === 0) return [0, 1];
	const min = Math.min(...points.map((p) => p.ts));
	const max = Math.max(...points.map((p) => p.ts));
	return max - min < MIN_DOMAIN_SPAN_MS
		? [min - MIN_DOMAIN_SPAN_MS, max + MIN_DOMAIN_SPAN_MS]
		: [min, max];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TICKS = 5;

/**
 * Evenly spaced tick timestamps across the domain, replacing Recharts' own
 * `scale.ticks()` generation.
 *
 * Confirmed by inspecting the rendered SVG: for some fixed domain widths
 * (e.g. the 30-day History range) d3's time-scale ticker emits two entries
 * that resolve to the exact same pixel coordinate — verified as two
 * `<text>` nodes both at x="45.68…" both reading "Jul 20, 2026". Recharts'
 * collision avoidance (`getTicksEnd`) derives its sweep direction from
 * `sign(tick1.coordinate - tick0.coordinate)`; two ticks sharing a
 * coordinate zero that out, which disables the sweep entirely instead of
 * hiding the collision, so both duplicates render stacked on top of each
 * other. Ticks we generate ourselves are strictly increasing by
 * construction, so no pair can ever land on the same coordinate.
 *
 * Tick count is capped by the domain's day span so a sub-week domain (a
 * single point, padded by `resolveTimeDomain`) doesn't ask for 5 ticks that
 * all format down to the same day.
 */
const resolveTimeTicks = (domain: [number, number]): number[] => {
	const [start, end] = domain;
	const daySpan = (end - start) / DAY_MS;
	const count = Math.max(2, Math.min(MAX_TICKS, Math.floor(daySpan) + 1));
	const step = (end - start) / (count - 1);
	return Array.from(new Set(Array.from({ length: count }, (_, i) => Math.round(start + i * step))));
};

/**
 * Shared time X-axis config — all three charts plot the same `ts` key over
 * the same domain so they stay aligned. Returned as a plain object (not a
 * component) since Recharts only recognizes axes as direct JSX children.
 */
export const timeXAxis = (domain: [number, number]) =>
	({
		dataKey: "ts",
		type: "number",
		scale: "time",
		domain,
		ticks: resolveTimeTicks(domain),
		axisLine: false,
		tickLine: false,
		tick: CHART_TICK,
		minTickGap: 40,
	}) as const;
