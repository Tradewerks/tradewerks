import { useMemo, useState } from "react";
import {
	ComposedChart,
	Area,
	Line,
	Scatter,
	XAxis,
	YAxis,
	CartesianGrid,
	ReferenceLine,
	Tooltip,
	ResponsiveContainer,
	usePlotArea,
	useYAxisDomain,
} from "recharts";
import { LineChart, TrendingUp, TrendingDown, Minus } from "lucide-react";
import { useItemPriceHistoryQuery } from "../../../hooks/useInventory";
import type { RecentSale } from "../../../types/inventory";
import { formatCurrency, formatDate } from "../../../util/util";
import Card from "../../ui/Card";
import EmptyState from "../../ui/EmptyState";
import SegmentedToggle from "../../ui/SegmentedToggle";
import { stackLabels, valueToY, type LabelSlot } from "../../../lib/chartLabels";
import { unitLabel } from "../../../lib/units";
import { ChartChip, ChartTooltipShell } from "./chartShared";
import SupplierOriginStrip from "./SupplierOriginStrip";
import PurchaseHistoryTable from "./PurchaseHistoryTable";
import { supplierKey } from "../../../lib/suppliers";
import { CHART_GRID, CHART_TICK, resolveTimeDomain, timeXAxis } from "./chartAxis";
import { useChartNotes, unitBreakNote, UNIT_BREAK_DETAIL } from "./chartNotes";
import LoadSvg from "../../../assets/icons/loading.svg?react";

type Mode = "amounts" | "margin";

// One row per distinct timestamp on the merged timeline. Every field is optional
// because the four series arrive on different clocks: the step series change when
// someone edits the item, charged price lands on bucket boundaries, and receipts
// land whenever stock came in.
interface ChartRow {
	ts: number;
	setCost: number | null;
	listPrice: number | null;
	wac: number | null;
	charged: number | null;
	receiptCost: number | null;
	receiptQty: number | null;
	// The unit STAMPED on that receipt's movement, never the item's current
	// unit — labelling a two-year-old receipt with today's unit is a misread.
	receiptUnit: string | null;
	receiptBatch: string | null;
	// Display name and match key for the receipt's vendor. Both null/"" when the
	// origin was never recorded — see SupplierOriginStrip.supplierKey.
	receiptSupplier: string | null;
	receiptSupplierKey: string;
	// [low, high] of what was actually billed in the bucket. A tuple, not two
	// fields, because Recharts draws a range Area from one dataKey. Null (never
	// [x, x]) when the bucket held one sale or one price — a zero-height ribbon
	// would claim a spread nobody measured.
	chargedBand: [number, number] | null;
	chargedMedian: number | null;
	chargedSales: number | null;
	// Every individual sale in this bucket — price, client, exact date — for
	// the tooltip to list as hard numbers. Supersedes naming just the two
	// price extremes: `chargedSales` above is the count, this is the count's
	// receipts, every one of them, not only the cheapest and dearest.
	chargedSaleDetails: RecentSale[];
	listMargin: number | null;
	chargedMargin: number | null;
}

// The numeric series the headline strip can measure — not the receipt
// annotations that ride along on the same rows.
type SeriesKey = "setCost" | "listPrice" | "wac" | "charged" | "listMargin" | "chargedMargin";

// `dash` is the single source of truth for each series' stroke pattern —
// the actual <Line> elements, the end-label column, the legend, and the
// tooltip swatch all read it from here so a dash can't drift out of sync
// with what's actually drawn: setCost and wac share a colour, so the dash
// is the only thing telling configured cost from actually-paid cost apart
// on hover.
const SERIES = {
	setCost: { color: "var(--color-chart-warning)", label: "Set cost" },
	// Same hue as set cost on purpose: both are COST. Solid = configured,
	// dashed = actually paid. A fourth hue would read as a fourth kind of thing.
	// "running" front-loads the one non-obvious fact a dispatcher needs without
	// a click into the info panel: this average is over ALL history, not
	// windowed to whatever range chip is selected.
	wac: { color: "var(--color-chart-warning)", label: "Paid cost (running avg)", dash: "2 3" },
	listPrice: { color: "var(--color-chart-info)", label: "List price" },
	charged: { color: "var(--color-chart-success)", label: "Charged price", dash: "5 4" },
} as const;

const formatMoneyAxis = (value: number) => {
	const abs = Math.abs(value);
	const sign = value < 0 ? "-" : "";
	if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(1)}k`;
	return `${sign}$${abs}`;
};

const formatPercentAxis = (value: number) => `${Math.round(value)}%`;

// Dash pattern per series so the LEGEND can draw what the plot draws.
// Recharts' `legendType="plainline"` always renders a solid rule, which would
// make set cost and paid cost (same hue, differ only by dash) indistinguishable.
type LegendEntry = {
	label: string;
	color: string;
	dash?: string;
	marker?: "line" | "circle" | "band";
};

/** A series' final value plus the stroke that identifies it in the label column. */
type EndSeries = { key: string; label: string; color: string; dash?: string; value: number };

function ChartLegend({ entries }: { entries: LegendEntry[] }) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2 text-xs text-text-tertiary">
			{entries.map((e) => (
				<span key={e.label} className="inline-flex items-center gap-1.5">
					{e.marker === "band" ? (
						<svg width="16" height="8" aria-hidden>
							<rect x="0" y="1" width="16" height="6" fill={e.color} opacity={0.14} />
						</svg>
					) : e.marker === "circle" ? (
						<svg width="12" height="12" aria-hidden>
							<circle
								cx="6"
								cy="6"
								r="3.5"
								fill="var(--color-base)"
								stroke={e.color}
								strokeWidth={1.5}
							/>
						</svg>
					) : (
						<svg width="16" height="8" aria-hidden>
							<line
								x1="0"
								y1="4"
								x2="16"
								y2="4"
								stroke={e.color}
								strokeWidth={2}
								strokeDasharray={e.dash}
							/>
						</svg>
					)}
					{e.label}
				</span>
			))}
		</div>
	);
}

/**
 * All series labels in one right-margin column, stacked so they can't
 * overlap — per-series `LabelList`s collide since these lines run close
 * together by design (set cost vs paid cost, list vs charged price). A swatch
 * carries the colour/dash so a nudged label still matches its line.
 *
 * Rendered as a plain child of the chart: Recharts 3 hooks expose the plot
 * area and y scale to any descendant, and `Customized` is deprecated.
 */
function EndLabelColumn({ series }: { series: EndSeries[] }) {
	const plot = usePlotArea();
	const domain = useYAxisDomain();
	if (!plot || series.length === 0) return null;

	// The y domain arrives as the axis' own [min, max]; anything categorical (or
	// missing) means there's nothing linear to map onto.
	const numeric =
		Array.isArray(domain) && domain.length === 2 && typeof domain[0] === "number"
			? ([domain[0], domain[1]] as [number, number])
			: null;
	if (!numeric) return null;

	const anchored = series
		.map((s) => {
			const y = valueToY(s.value, numeric, plot);
			return y == null
				? null
				: ({ key: s.key, label: s.label, color: s.color, dash: s.dash, y } as LabelSlot);
		})
		.filter((s): s is LabelSlot => s !== null);
	if (anchored.length === 0) return null;

	const slots = stackLabels(anchored, {
		// 13px clears an 11px line; the column is bounded by the plot itself, so a
		// label can never sit above the top gridline or below the axis.
		minGap: 13,
		top: plot.y + 4,
		bottom: plot.y + plot.height - 4,
	});

	const x = plot.x + plot.width + 8;

	return (
		<g className="pointer-events-none">
			{slots.map((s) => (
				<g key={s.key}>
					<line
						x1={x}
						y1={s.y}
						x2={x + 12}
						y2={s.y}
						stroke={s.color}
						strokeWidth={2}
						strokeDasharray={s.dash}
					/>
					<text x={x + 17} y={s.y} dy={4} fontSize={11} fill="var(--color-chart-axis)">
						{s.label}
					</text>
				</g>
			))}
		</g>
	);
}

// Receipts are the raw evidence; the paid-cost line is the average over them.
// Hollow so a purchase never reads as a point ON the line it feeds.
//
// All one hue regardless of vendor: this chart already carries four series, and
// per-supplier colours would cost more legibility than they'd buy. Origin is
// shown by DIMMING the others while a strip row is hovered.
function ReceiptDot({
	cx,
	cy,
	payload,
	focusKey,
}: {
	cx?: number;
	cy?: number;
	payload?: ChartRow;
	focusKey?: string | null;
}) {
	if (cx == null || cy == null) return null;
	const dimmed = focusKey != null && payload?.receiptSupplierKey !== focusKey;
	return (
		<circle
			cx={cx}
			cy={cy}
			r={3.5}
			fill="var(--color-base)"
			stroke={SERIES.wac.color}
			strokeWidth={1.5}
			opacity={dimmed ? 0.25 : 1}
		/>
	);
}

// Exported (only) so its rendering logic — sort, cap, fallback — can be unit
// tested directly with a synthetic ChartRow, rather than simulating a real
// mouse hover over Recharts' internal coordinate tracking, which nothing else
// in this file attempts.
export function TrendTooltip({
	active,
	payload,
	mode,
}: {
	active?: boolean;
	payload?: { payload: ChartRow }[];
	mode: Mode;
}) {
	if (!active || !payload?.length) return null;
	const d = payload[0].payload;

	const rows: { label: string; value: string; color: string; dash?: string }[] = [];
	if (mode === "amounts") {
		if (d.setCost != null)
			rows.push({
				label: SERIES.setCost.label,
				value: formatCurrency(d.setCost),
				color: SERIES.setCost.color,
			});
		if (d.wac != null)
			rows.push({
				label: SERIES.wac.label,
				value: formatCurrency(d.wac),
				color: SERIES.wac.color,
				dash: SERIES.wac.dash,
			});
		if (d.listPrice != null)
			rows.push({
				label: SERIES.listPrice.label,
				value: formatCurrency(d.listPrice),
				color: SERIES.listPrice.color,
			});
		if (d.charged != null)
			rows.push({
				label: SERIES.charged.label,
				// The range IS the headline when there was one — a single averaged
				// figure is exactly the misread this chart exists to remove. The
				// sale count rides along so a 2-sale spread isn't read like a 20.
				value:
					d.chargedBand
						? `${formatCurrency(d.chargedBand[0])}–${formatCurrency(d.chargedBand[1])} · avg ${formatCurrency(d.charged)}`
						: formatCurrency(d.charged),
				color: SERIES.charged.color,
				dash: SERIES.charged.dash,
			});
	} else {
		if (d.listMargin != null)
			rows.push({
				label: "List margin",
				value: `${d.listMargin.toFixed(1)}%`,
				color: SERIES.listPrice.color,
			});
		if (d.chargedMargin != null)
			rows.push({
				label: "Realized margin",
				value: `${d.chargedMargin.toFixed(1)}%`,
				color: SERIES.charged.color,
				dash: SERIES.charged.dash,
			});
	}

	if (rows.length === 0 && d.receiptCost == null) return null;

	return (
		<ChartTooltipShell title={formatDate(new Date(d.ts))}>
			{rows.map((r) => (
				<p key={r.label} className="text-xs flex items-center gap-1.5">
					{/* A line swatch, not a solid dot: setCost and wac (paid cost)
					    share a colour on purpose (both are COST) and are told apart
					    by dash pattern on the chart — solid vs dotted. A plain filled
					    circle here erased that distinction and made the two rows
					    look identical. Same swatch shape ChartLegend already uses
					    for this exact reason. */}
					<svg width="12" height="8" aria-hidden className="shrink-0">
						<line
							x1="0"
							y1="4"
							x2="12"
							y2="4"
							stroke={r.color}
							strokeWidth={2}
							strokeDasharray={r.dash}
						/>
					</svg>
					<span className="text-text-secondary">{r.label}</span>
					<span className="font-semibold tabular-nums text-text-primary">{r.value}</span>
				</p>
			))}
			{mode === "amounts" &&
				(d.chargedSaleDetails.length > 0 ? (
					// The line above plots the average and the band plots the range —
					// both averages of a kind. This is neither: every sale that landed
					// in this bucket, exact price and exact client, low to high. A 3+
					// sale bucket needs its middle sales named too, or low/high alone
					// names two clients and implies everyone else averaged out.
					<div className="mt-0.5 space-y-0.5">
						{[...d.chargedSaleDetails]
							.sort((a, b) => a.unitPrice - b.unitPrice)
							.slice(0, 5)
							.map((s, i) => (
								<p key={i} className="text-[11px] text-text-faint">
									{formatCurrency(s.unitPrice)} · {s.clientName ?? "Unrecorded"} ·{" "}
									{formatDate(s.at)}
								</p>
							))}
						{d.chargedSaleDetails.length > 5 && (
							<p className="text-[11px] text-text-faint italic">
								+{d.chargedSaleDetails.length - 5} more — see ledger below
							</p>
						)}
					</div>
				) : (
					// Fallback for the rare case the raw list and the bucket count
					// disagree (a boundary edge case) — the count is still a real
					// fact even without names to attach to it.
					d.chargedSales != null && (
						<p className="text-[11px] text-text-faint">
							{d.chargedSales} {d.chargedSales === 1 ? "sale" : "sales"}
						</p>
					)
				))}
			{d.receiptCost != null && (
				<p className="text-[11px] text-text-faint mt-1">
					Received {d.receiptQty}{" "}
					{unitLabel(d.receiptUnit, d.receiptQty ?? undefined)} @{" "}
					{formatCurrency(d.receiptCost)}
					{d.receiptSupplier ? ` · ${d.receiptSupplier}` : ""}
					{d.receiptBatch ? ` · ${d.receiptBatch}` : ""}
				</p>
			)}
		</ChartTooltipShell>
	);
}

// The read a dispatcher wants without tracing a line: where a series stands now,
// and which way it moved across the window on screen.
function HeadlineStat({
	label,
	value,
	delta,
	deltaLabel,
	invertTone,
	sub,
}: {
	label: string;
	value: string;
	delta: number | null;
	deltaLabel: string | null;
	// Rising cost is bad news, rising price and margin are good. Tone follows
	// meaning, not sign.
	invertTone?: boolean;
	// Who/when behind the value — only "Last Paid" uses this, everything else
	// passes null. Sits under the value+delta line rather than crowding it.
	sub?: string | null;
}) {
	const flat = delta == null || Math.abs(delta) < 0.005;
	const good = delta != null && (invertTone ? delta < 0 : delta > 0);
	const DeltaIcon = flat ? Minus : delta! > 0 ? TrendingUp : TrendingDown;
	const toneClass = flat ? "text-text-muted" : good ? "text-success-text" : "text-error-text";

	return (
		<div>
			<div className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
				{label}
			</div>
			<div className="mt-0.5 flex items-baseline gap-2">
				<span className="text-lg font-bold tabular-nums leading-tight text-text-primary">
					{value}
				</span>
				{deltaLabel && (
					<span
						className={`inline-flex items-center gap-0.5 text-[11px] font-semibold ${toneClass}`}
					>
						<DeltaIcon size={11} />
						{flat ? "no change" : deltaLabel}
					</span>
				)}
			</div>
			{sub && <div className="mt-0.5 text-[11px] text-text-faint">{sub}</div>}
		</div>
	);
}

// Cost & pricing over time for the item History tab.
//
// FOUR distinct series, deliberately never merged into one "cost" line:
//   Set cost / List price — what the item is CONFIGURED at. Step functions
//     (type="stepAfter") since a configured amount holds flat until edited;
//     a smooth curve would draw prices that never existed.
//   Paid cost — running weighted average of per-receipt unit_cost, computed
//     over all history and only windowed for display so a past value doesn't
//     move when the range chip does.
//   Charged price — realized revenue, averaged per bucket from visit line
//     items, not a setting.
//
// Step series are forward-filled across the timeline (the value at any
// instant IS the last value it was set to). Charged price is NOT
// forward-filled — a period with no sales has no realized price.
//
// No `unit` prop: every quantity names its own denomination from the row it
// came off (ChartRow.receiptUnit) — the item's CURRENT unit would mislabel a
// two-year-old receipt.
export default function CostPriceTrendChart({
	itemId,
	createdAfter,
	bucket,
	range,
	xDomain,
}: {
	itemId: string;
	createdAfter?: string;
	bucket: "week" | "month";
	range?: number;
	// Shared with the stock/consumption charts so a cost change lines up with the
	// stock movement it arrived with.
	xDomain?: [number, number];
}) {
	const [mode, setMode] = useState<Mode>("amounts");
	// Which supplier's receipts to keep at full opacity while its strip row is
	// hovered. Null = no focus, every dot reads normally.
	const [focusKey, setFocusKey] = useState<string | null>(null);
	// Which supplier the purchase ledger below is pinned to, if any — a click,
	// not a hover, so it survives the mouse moving away. Kept separate from
	// focusKey so a hover preview never fights a pinned filter.
	const [filterKey, setFilterKey] = useState<string | null>(null);
	const toggleFilter = (key: string) => setFilterKey((prev) => (prev === key ? null : key));
	const { data, isLoading } = useItemPriceHistoryQuery(itemId, { createdAfter, bucket, range });

	const rows: ChartRow[] = useMemo(() => {
		if (!data) return [];

		const byTs = new Map<number, ChartRow>();
		const row = (at: string): ChartRow => {
			const ts = new Date(at).getTime();
			let existing = byTs.get(ts);
			if (!existing) {
				existing = {
					ts,
					setCost: null,
					listPrice: null,
					wac: null,
					charged: null,
					receiptCost: null,
					receiptQty: null,
					receiptUnit: null,
					receiptBatch: null,
					receiptSupplier: null,
					receiptSupplierKey: "",
					chargedBand: null,
					chargedMedian: null,
					chargedSales: null,
					chargedSaleDetails: [],
					listMargin: null,
					chargedMargin: null,
				};
				byTs.set(ts, existing);
			}
			return existing;
		};

		for (const p of data.cost.points) row(p.at).setCost = p.value;
		for (const p of data.price.points) row(p.at).listPrice = p.value;
		for (const p of data.wac) row(p.at).wac = p.value;
		for (const r of data.receipts) {
			const target = row(r.at);
			target.receiptCost = r.unitCost;
			target.receiptQty = r.qty;
			target.receiptUnit = r.unit;
			target.receiptBatch = r.batchNumber;
			target.receiptSupplier = r.supplierName;
			target.receiptSupplierKey = supplierKey(r.supplierId, r.supplierName);
		}
		for (const p of data.charged.points) {
			if (p.avgUnitPrice == null) continue;
			const target = row(p.periodStart);
			target.charged = p.avgUnitPrice;
			target.chargedSales = p.sales;
			target.chargedMedian = p.median;
			// The server already nulls both ends unless there's a real spread, so
			// this never has to guess whether a band is meaningful.
			target.chargedBand = p.low != null && p.high != null ? [p.low, p.high] : null;
		}

		// Every sale, matched to the same bucket boundary the server already
		// grouped `points` by — the last periodStart at or before the sale's own
		// timestamp. Points are ascending by construction (generate_series), so
		// a simple forward scan is enough; the list is bounded by the chart's
		// own bucket count (weeks/months in the window), not by sale volume.
		const chargedPeriods = data.charged.points.map((p) => ({
			ts: new Date(p.periodStart).getTime(),
			periodStart: p.periodStart,
		}));
		for (const s of data.charged.sales ?? []) {
			const saleTs = new Date(s.at).getTime();
			let bucket: { ts: number; periodStart: string } | null = null;
			for (const period of chargedPeriods) {
				if (period.ts <= saleTs) bucket = period;
				else break;
			}
			if (!bucket) continue;
			row(bucket.periodStart).chargedSaleDetails.push(s);
		}

		const ordered = [...byTs.values()].sort((a, b) => a.ts - b.ts);

		// Forward-fill so the step lines don't break between edits and a margin can
		// be computed at every point on the timeline.
		let lastCost: number | null = null;
		let lastPrice: number | null = null;
		let lastWac: number | null = null;
		for (const r of ordered) {
			if (r.setCost != null) lastCost = r.setCost;
			else r.setCost = lastCost;

			if (r.listPrice != null) lastPrice = r.listPrice;
			else r.listPrice = lastPrice;

			if (r.wac != null) lastWac = r.wac;
			else r.wac = lastWac;

			// Margin against PAID cost when it's known — that's the real basis —
			// and against the configured cost otherwise.
			const basis = r.wac ?? r.setCost;
			if (basis != null && r.listPrice != null && r.listPrice !== 0) {
				r.listMargin = ((r.listPrice - basis) / r.listPrice) * 100;
			}
			if (basis != null && r.charged != null && r.charged !== 0) {
				r.chargedMargin = ((r.charged - basis) / r.charged) * 100;
			}
		}

		return ordered;
	}, [data]);

	// First and last real value of each series inside the window — the two ends of
	// the headline delta. Forward-filled step values count: the value a step
	// series held on entering the window IS its value there.
	const edges = useMemo(() => {
		const keys: SeriesKey[] = [
			"setCost",
			"listPrice",
			"wac",
			"charged",
			"listMargin",
			"chargedMargin",
		];
		const out = {} as Record<SeriesKey, { first: number; last: number } | null>;
		for (const key of keys) {
			let first: number | null = null;
			let last: number | null = null;
			for (const r of rows) {
				const v = r[key];
				if (v == null) continue;
				if (first == null) first = v;
				last = v;
			}
			out[key] = first != null && last != null ? { first, last } : null;
		}
		return out;
	}, [rows]);

	// Most recent receipt first — the concrete "what did we last pay, from whom"
	// fact the headline stat and the itemized table below are built around.
	// Sorted client-side rather than trusting response order: `data.receipts`
	// is grouped for the chart's timeline merge, not guaranteed newest-first.
	const receiptsSorted = useMemo(
		() =>
			[...(data?.receipts ?? [])].sort(
				(a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
			),
		[data],
	);
	const lastReceipt = receiptsSorted[0] ?? null;
	const previousReceipt = receiptsSorted[1] ?? null;

	// The actual last sale, not a bucket average — server returns these
	// newest-first already. The "Charged Price (latest)" headline reads this,
	// same reasoning as lastReceipt above: "latest" means the invoice, not a
	// blended figure nobody was actually charged.
	const lastSale = data?.recentSales?.[0] ?? null;
	const previousSale = data?.recentSales?.[1] ?? null;

	// On a unit break the server returns an EMPTY `wac` series (can't average
	// across denominations). Per-receipt markers survive since each is a single
	// self-denominated fact, not an aggregate.
	const unitBreak = unitBreakNote(data?.unitBasis, "a paid-cost average");
	const hasPaidCost = (data?.costCoverage.withCost ?? 0) > 0;
	const hasAnySeries = rows.some(
		(r) => r.setCost != null || r.listPrice != null || r.charged != null || r.wac != null,
	);
	// Margin needs both a cost and a price to divide; offering the toggle without
	// them would just swap to an empty chart.
	const canShowMargin = rows.some((r) => r.listMargin != null || r.chargedMargin != null);
	// At least one bucket sold at more than one price — the whole reason the band
	// exists. Drives the legend entry and the spread footnote.
	const hasBand = rows.some((r) => r.chargedBand != null);
	const supplierCount = (data?.bySupplier ?? []).filter((s) => !s.unattributed).length;
	const hasReceiptOrigin = (data?.costCoverage.withSupplier ?? 0) > 0;
	// Guards the shared shell below: an empty rollup AND an empty ledger would
	// otherwise still render a bordered box with nothing inside it.
	const hasSupplierBreakdown = (data?.bySupplier?.length ?? 0) > 0 || receiptsSorted.length > 0;
	const effectiveMode: Mode = mode === "margin" && canShowMargin ? "margin" : "amounts";
	const timeDomain = resolveTimeDomain(rows, xDomain);

	const periodWord = bucket === "week" ? "week" : "month";

	// Hoisted above the early returns so hook order is stable.
	const { trigger: notesTrigger, notes } = useChartNotes({
		primary:
			unitBreak ??
			(hasPaidCost
				? `Paid cost is a running weighted average of supplier billing — ${data?.costCoverage.withCost ?? 0} of ${data?.costCoverage.receipts ?? 0} receipts in this window recorded a unit cost.`
				: "No receipt has recorded a unit cost yet — record one when receiving stock to chart what was actually paid, not just what's configured."),
		details: [
			unitBreak ? UNIT_BREAK_DETAIL : null,
			unitBreak
				? "Individual receipt markers are still plotted: each one is a single price on a single date, labelled with the unit it was received in, so it stays true across the break."
				: null,
			"Set cost and list price are what the item is CONFIGURED at, so they're drawn as steps: each value holds until someone edits it.",
			data?.coverageStart
				? `The edit history behind those steps only reaches back to ${formatDate(data.coverageStart)} — a flat line before then may mean the cost never changed, or just that the record doesn't go back further.`
				: null,
			`Charged price is the unit price billed on visit line items, averaged per ${periodWord} and dated to when the work happened. Cancelled visits are excluded, and a ${periodWord} with no sales has no point rather than an interpolated one.`,
			hasPaidCost && !unitBreak
				? `The average runs over all ${data?.costCoverage.wacBasisReceipts ?? 0} priced receipts and is then trimmed to this window, so changing the range never changes a past value.`
				: null,
			data?.chargedTruncated
				? `Sales before ${formatDate(data.chargedWindowStart)} aren't charted — this item's history runs past the ${periodWord} cap.`
				: null,
			canShowMargin
				? "Margin % is (price − cost) ÷ price, against paid cost where it's known and configured cost otherwise."
				: null,
			hasBand
				? `The shaded band is the lowest and highest unit price billed in each ${periodWord}, so a ${periodWord} that sold at both wholesale and retail shows both instead of one averaged figure nobody paid.`
				: null,
			// Stated even when nobody asked, because an unweighted range looks
			// exactly like a weighted one and would otherwise be read as a
			// confidence interval around the average.
			hasBand
				? "The band counts each sale once regardless of quantity: a single unit sold at an unusual price stretches it as far as a fifty-unit order would. The plotted line stays quantity-weighted, so it can sit anywhere inside the band."
				: null,
			hasReceiptOrigin
				? `${data?.costCoverage.withSupplier ?? 0} of ${data?.costCoverage.receipts ?? 0} receipts in this window name a supplier — the rest are grouped as Unrecorded rather than assigned to a likely vendor.`
				: "No receipt in this window names a supplier — record one when receiving stock to see which vendor each cost came from.",
		],
	});

	const modeToggle = (
		<SegmentedToggle<Mode>
			ariaLabel="Cost and pricing chart mode"
			value={effectiveMode}
			onChange={setMode}
			options={[
				{ id: "amounts", label: "Amounts" },
				{
					id: "margin",
					label: "Margin %",
					disabled: !canShowMargin,
					title: canShowMargin
						? undefined
						: "Set both a cost and a customer price to see margin over time",
				},
			]}
		/>
	);

	if (isLoading) {
		return (
			<Card title="Cost & Pricing Over Time" headerAction={modeToggle}>
				<div className="flex-1 min-h-0 flex justify-center items-center py-12">
					<LoadSvg className="w-7 h-7" />
				</div>
			</Card>
		);
	}

	if (!hasAnySeries) {
		return (
			<Card title="Cost & Pricing Over Time" headerAction={modeToggle}>
				<EmptyState
					icon={<LineChart size={26} />}
					title="No cost or pricing history yet"
					description="Once this item has a cost or customer price set — or has been sold on a visit — its history charts here."
				/>
			</Card>
		);
	}

	// The headline reads the actual last receipt, not the running average — a
	// manager asking "what did we pay" wants the invoice, not a blended figure
	// nobody paid. Falls back to configured cost only when no receipt exists.
	// The delta is real too: last receipt vs. the one before it, not a trend
	// line's slope.
	const costEdges =
		hasPaidCost && lastReceipt
			? { first: (previousReceipt ?? lastReceipt).unitCost, last: lastReceipt.unitCost }
			: edges.setCost;
	// Same reasoning, same shape, for the charged-price headline: the last
	// individual sale, not the bucket average `edges.charged` carries.
	const chargedEdges = lastSale
		? { first: (previousSale ?? lastSale).unitPrice, last: lastSale.unitPrice }
		: edges.charged;
	// Realized margin (latest) has the exact same defect as charged price did:
	// `edges.chargedMargin` is derived from the bucket average too. Recompute it
	// off the real last sale against the real last-known cost (costEdges.last —
	// last paid, or configured cost with no receipt yet), same basis rule
	// chargedMargin itself uses elsewhere on the chart.
	const marginBasis = costEdges?.last ?? null;
	const realizedMargin = (price: number) =>
		marginBasis != null && price !== 0 ? ((price - marginBasis) / price) * 100 : null;
	const lastRealizedMargin = lastSale ? realizedMargin(lastSale.unitPrice) : null;
	const chargedMarginEdges =
		lastRealizedMargin != null
			? {
					first:
						(previousSale && realizedMargin(previousSale.unitPrice)) ?? lastRealizedMargin,
					last: lastRealizedMargin,
				}
			: edges.chargedMargin;
	const money = (d: number) => formatCurrency(Math.abs(d));
	const percent = (v: number) => `${v.toFixed(1)}%`;

	const stats =
		effectiveMode === "amounts"
			? [
					{
						label: hasPaidCost && lastReceipt ? "Last Paid" : "Set Cost Now",
						edge: costEdges,
						format: formatCurrency,
						deltaFormat: money,
						invertTone: true,
						sub:
							hasPaidCost && lastReceipt
								? `${lastReceipt.supplierName ?? "Unrecorded"} · ${formatDate(lastReceipt.at)}`
								: null,
					},
					{
						label: "List Price Now",
						edge: edges.listPrice,
						format: formatCurrency,
						deltaFormat: money,
						invertTone: false,
						sub: null,
					},
					{
						label: lastSale ? "Last Charged" : "Charged Price (latest)",
						edge: chargedEdges,
						format: formatCurrency,
						deltaFormat: money,
						invertTone: false,
						sub: lastSale
							? `${lastSale.clientName ?? "Unrecorded"} · ${formatDate(lastSale.at)}`
							: null,
					},
				]
			: [
					{
						label: "List Margin Now",
						edge: edges.listMargin,
						format: percent,
						deltaFormat: (d: number) => `${Math.abs(d).toFixed(1)} pts`,
						invertTone: false,
						sub: null,
					},
					{
						label: lastRealizedMargin != null ? "Last Realized Margin" : "Realized Margin (latest)",
						edge: chargedMarginEdges,
						format: percent,
						deltaFormat: (d: number) => `${Math.abs(d).toFixed(1)} pts`,
						invertTone: false,
						sub:
							lastRealizedMargin != null && lastSale
								? `${lastSale.clientName ?? "Unrecorded"} · ${formatDate(lastSale.at)}`
								: null,
					},
				];

	// Each series' final value — the anchor its right-margin label stacks around.
	// `edges` already tracked these for the headline deltas.
	const endCandidates: (Omit<EndSeries, "value"> & { value: number | undefined })[] =
		effectiveMode === "amounts"
			? [
					{
						key: "setCost",
						label: SERIES.setCost.label,
						color: SERIES.setCost.color,
						value: edges.setCost?.last,
					},
					...(hasPaidCost
						? [
								{
									key: "wac",
									label: SERIES.wac.label,
									color: SERIES.wac.color,
									dash: SERIES.wac.dash,
									value: edges.wac?.last,
								},
							]
						: []),
					{
						key: "listPrice",
						label: SERIES.listPrice.label,
						color: SERIES.listPrice.color,
						value: edges.listPrice?.last,
					},
					{
						key: "charged",
						label: SERIES.charged.label,
						color: SERIES.charged.color,
						dash: SERIES.charged.dash,
						value: edges.charged?.last,
					},
				]
			: [
					{
						key: "listMargin",
						label: "List margin",
						color: SERIES.listPrice.color,
						value: edges.listMargin?.last,
					},
					{
						key: "chargedMargin",
						label: "Realized margin",
						color: SERIES.charged.color,
						dash: SERIES.charged.dash,
						value: edges.chargedMargin?.last,
					},
				];
	const endSeries: EndSeries[] = endCandidates.filter(
		(s): s is EndSeries => s.value != null,
	);

	// Only what the in-plot label column can't name: lines already label
	// themselves at the right edge, but receipt dots have no line end to label.
	const hasReceipts = (data?.receipts?.length ?? 0) > 0;
	const legendEntries: LegendEntry[] =
		effectiveMode === "amounts"
			? [
					...(hasReceipts
						? [
								{
									label: "Receipt",
									color: SERIES.wac.color,
									marker: "circle" as const,
								},
							]
						: []),
					// The band has no line end to label itself at, and an unnamed
					// shaded region invites being read as a forecast or a target.
					...(hasBand
						? [
								{
									label: "Charged range (low–high)",
									color: SERIES.charged.color,
									marker: "band" as const,
								},
							]
						: []),
				]
			: [];

	return (
		<Card
			title="Cost & Pricing Over Time"
			headerAction={
				<div className="flex items-center gap-2">
					{effectiveMode === "amounts" && !hasPaidCost && (
						<ChartChip>Configured cost only</ChartChip>
					)}
					{/* Only worth the space once buying is actually split across
					    vendors — one supplier is the unremarkable case. */}
					{effectiveMode === "amounts" && supplierCount > 1 && (
						<ChartChip>Suppliers · {supplierCount}</ChartChip>
					)}
					{modeToggle}
					{notesTrigger}
				</div>
			}
		>
			{/* Headline first, chart second: the delta answers "is my margin
			    holding?" without anyone having to trace a line. */}
			<div className="flex flex-wrap gap-x-8 gap-y-3 pb-3 mb-1 border-b border-border-subtle">
				{stats.map((s) => (
					<HeadlineStat
						key={s.label}
						label={s.label}
						value={s.edge ? s.format(s.edge.last) : "—"}
						delta={s.edge ? s.edge.last - s.edge.first : null}
						deltaLabel={s.edge ? s.deltaFormat(s.edge.last - s.edge.first) : null}
						invertTone={s.invertTone}
						sub={s.sub}
					/>
				))}
			</div>

			<div className="flex-1 min-h-[260px]">
				<ResponsiveContainer width="100%" height="100%" minHeight={260}>
					{/* Right margin holds the stacked label column: 8px gap + 12px
					    swatch + 5px + the longest label ("Paid cost (running avg)" —
					    widened from 112 to fit it when "avg" became "running avg").
					    bottom: 6, not 0 — the y-axis's $0 tick sits vertically
					    centered ON the bottom axis line, and with zero bottom
					    margin the leftmost x-axis date label (closest to the
					    y-axis) rendered flush against it. */}
					<ComposedChart data={rows} margin={{ top: 10, right: 172, left: 4, bottom: 6 }}>
						<CartesianGrid {...CHART_GRID} />
						<XAxis
							{...timeXAxis(timeDomain)}
							tickFormatter={(v: number) => formatDate(new Date(v))}
						/>
						<YAxis
							axisLine={false}
							tickLine={false}
							tick={CHART_TICK}
							width={effectiveMode === "margin" ? 44 : 56}
							tickFormatter={effectiveMode === "margin" ? formatPercentAxis : formatMoneyAxis}
						/>
						<Tooltip
							content={<TrendTooltip mode={effectiveMode} />}
							cursor={{ stroke: "var(--color-border-strong)" }}
						/>
						{/* Recharts' own Legend always draws a solid rule, so it's
						    replaced by ChartLegend below, which draws real strokes. */}

						{effectiveMode === "amounts" ? (
							<>
								{/* Rendered FIRST so it sits behind every line. Very low
								    opacity and no stroke: it's context for the charged
								    line, not a fifth series competing with it. No
								    connectNulls — a period with no sales must break the
								    band exactly as it breaks the line. */}
								<Area
									type="linear"
									dataKey="chargedBand"
									name="Charged range"
									stroke="none"
									fill={SERIES.charged.color}
									fillOpacity={0.14}
									isAnimationActive={false}
									activeDot={false}
									legendType="none"
								/>
								<Line
									type="stepAfter"
									dataKey="setCost"
									name={SERIES.setCost.label}
									stroke={SERIES.setCost.color}
									strokeWidth={2}
									dot={false}
									isAnimationActive={false}
									connectNulls
								/>
								{hasPaidCost && (
									<Line
										type="stepAfter"
										dataKey="wac"
										name={SERIES.wac.label}
										stroke={SERIES.wac.color}
										strokeWidth={2}
										strokeDasharray={SERIES.wac.dash}
										dot={false}
										isAnimationActive={false}
										connectNulls
									/>
								)}
								<Line
									type="stepAfter"
									dataKey="listPrice"
									name={SERIES.listPrice.label}
									stroke={SERIES.listPrice.color}
									strokeWidth={2}
									dot={false}
									isAnimationActive={false}
									connectNulls
								/>
								{/* Straight segments, never a spline: charged price is a
								    per-period SAMPLE, and a curve would invent prices
								    between periods. No connectNulls: a period with no
								    sales has no realized price to bridge. */}
								<Line
									type="linear"
									dataKey="charged"
									name={SERIES.charged.label}
									stroke={SERIES.charged.color}
									strokeWidth={1.5}
									strokeDasharray={SERIES.charged.dash}
									dot={{ r: 3, fill: SERIES.charged.color, strokeWidth: 0 }}
									isAnimationActive={false}
								/>
								{/* Individual receipts — the raw evidence behind the
								    paid-cost average, so one outlier purchase is
								    visible as itself and not just as a nudge. */}
								<Scatter
									dataKey="receiptCost"
									name="Receipt"
									shape={<ReceiptDot focusKey={focusKey} />}
									fill={SERIES.wac.color}
									isAnimationActive={false}
								/>
							</>
						) : (
							<>
								{/* Break-even always in view: charging below cost has to
								    read as crossing a line, not merely as lower. */}
								<ReferenceLine
									y={0}
									stroke="var(--color-border-strong)"
									ifOverflow="extendDomain"
									label={{
										value: "break-even",
										// Left, not right: the right margin is the
										// series-label column now.
										position: "insideBottomLeft",
										fill: "var(--color-chart-axis)",
										fontSize: 11,
									}}
								/>
								<Line
									type="stepAfter"
									dataKey="listMargin"
									name="List margin %"
									stroke={SERIES.listPrice.color}
									strokeWidth={2}
									dot={false}
									isAnimationActive={false}
									connectNulls
								/>
								{/* Same rule as charged price: no sales in a period means
								    no realized margin, so the line breaks instead of
								    bridging. */}
								<Line
									type="linear"
									dataKey="chargedMargin"
									name="Realized margin %"
									stroke={SERIES.charged.color}
									strokeWidth={1.5}
									strokeDasharray={SERIES.charged.dash}
									dot={{ r: 3, fill: SERIES.charged.color, strokeWidth: 0 }}
									isAnimationActive={false}
								/>
							</>
						)}
						{/* One label layer for every series, stacked so labels survive
						    the lines running close together. */}
						<EndLabelColumn series={endSeries} />
					</ComposedChart>
				</ResponsiveContainer>
			</div>

			{legendEntries.length > 0 && <ChartLegend entries={legendEntries} />}

			{/* Right under the plot, not at the very bottom of the card: every
			    line here (set cost vs. paid cost, the charged band, the margin
			    formula) describes the SERIES above, not the supplier breakdown
			    below. The old placement put a two-table section between the Info
			    toggle in the header and the text it reveals — correct content,
			    wrong neighborhood. */}
			{notes}

			{/* Amounts only: the strip explains COST origin, and margin mode plots
			    no cost line for it to explain. One shell, not two floating
			    tables — the rollup and the ledger are master and detail, not
			    independent sections, and the border now says so: it wraps both,
			    with the ledger rendering as a recessed sub-panel of the rollup
			    rather than a second equal-weight table below it. */}
			{effectiveMode === "amounts" && hasSupplierBreakdown && (
				<div className="mt-3 pt-3 border-t border-border-subtle">
					<div className="rounded-lg border border-border-subtle bg-base overflow-hidden">
						<SupplierOriginStrip
							rows={data?.bySupplier ?? []}
							unit={data?.unitBasis?.unit ?? null}
							focusKey={focusKey}
							onFocus={setFocusKey}
							filterKey={filterKey}
							onFilterToggle={toggleFilter}
						/>
						{/* Answers "what did we pay, exactly, each time" where the
						    rollup above answers "who do we mostly buy from" —
						    sharing `focusKey` so hovering a vendor row up there
						    highlights that vendor's purchases down here too, and
						    `filterKey` so CLICKING a vendor row narrows this ledger
						    to just them. Filtering is set AND cleared entirely up
						    in the strip — this panel only reads the result. */}
						<PurchaseHistoryTable
							receipts={receiptsSorted}
							focusKey={focusKey}
							filterKey={filterKey}
						/>
					</div>
				</div>
			)}
		</Card>
	);
}
