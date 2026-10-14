import { useMemo, useState } from "react";
import {
	AreaChart,
	Area,
	XAxis,
	YAxis,
	CartesianGrid,
	ReferenceArea,
	ReferenceLine,
	Tooltip,
	ResponsiveContainer,
} from "recharts";
import { Gauge, Scale } from "lucide-react";
import { useItemValueHistoryQuery } from "../../../hooks/useInventory";
import { formatCurrency, formatDate } from "../../../util/util";
import { unitLabel } from "../../../lib/units";
import Card from "../../ui/Card";
import EmptyState from "../../ui/EmptyState";
import SegmentedToggle from "../../ui/SegmentedToggle";
import { ChartChip, ChartTooltipShell, QueryErrorState } from "./chartShared";
import { CHART_BODY_H, CHART_GRID, CHART_TICK, resolveTimeDomain, timeXAxis } from "./chartAxis";
import { useChartNotes, unitBreakNote, UNIT_BREAK_DETAIL } from "./chartNotes";
import LoadSvg from "../../../assets/icons/loading.svg?react";

type Mode = "units" | "value";

interface ChartPoint {
	// Epoch millis so this chart and ConsumptionTrendChart can share one numeric
	// x-domain and line up period-for-period.
	ts: number;
	date: string;
	quantity: number;
	value: number | null;
}

const formatValueAxis = (value: number) => {
	if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
	return `$${value}`;
};

function StockTooltip({
	active,
	payload,
	unit,
	mode,
}: {
	active?: boolean;
	payload?: { payload: ChartPoint }[];
	unit: string;
	mode: Mode;
}) {
	if (!active || !payload?.length) return null;
	const d = payload[0].payload;

	return (
		<ChartTooltipShell title={formatDate(d.date)}>
			{mode === "value" && d.value != null ? (
				<>
					<p className="text-sm font-semibold text-primary">~{formatCurrency(d.value)}</p>
					<p className="text-xs text-text-secondary">
						{d.quantity} {unitLabel(unit, d.quantity)} on hand
					</p>
				</>
			) : (
				<p className="text-sm font-semibold text-primary">
					{d.quantity} {unitLabel(unit, d.quantity)} on hand
				</p>
			)}
		</ChartTooltipShell>
	);
}

// Warehouse on-hand over time from GET /inventory/:id/value-history, with a
// Units / Value toggle over one series (value = quantity × current cost).
//
// The "Approximate" chip belongs to Value mode ONLY: quantity is real recorded
// stock, while value uses the CURRENT cost (stock_movement carries no
// per-receipt historical cost) — labelling the units series approximate too
// would be wrong in the other direction.
export default function StockLevelChart({
	itemId,
	unit,
	lowStockThreshold,
	createdAfter,
	xDomain,
}: {
	itemId: string;
	unit: string;
	lowStockThreshold: number | null;
	// Range from the tab-level control; undefined = the item's whole ledger.
	createdAfter?: string;
	// Shared with the adjacent consumption chart so a spike there sits directly
	// above the corresponding drop here.
	xDomain?: [number, number];
}) {
	const [mode, setMode] = useState<Mode>("units");
	const { data, isLoading, isError, refetch } = useItemValueHistoryQuery(itemId, {
		createdAfter,
	});

	// On a unit break the server returns NO points (a running balance is
	// cumulative, so no subset of it survives). Without this branch the card
	// would fall through to a false "No history yet".
	const unitBreak = unitBreakNote(data?.unitBasis, "on-hand over time");

	// A range-limited series starts at the first movement INSIDE the range, but
	// stock was already on hand before it — `openingQuantity` (the level just
	// before the window) anchors the step at the range start, so the plot shows
	// the level held from the start of the range rather than beginning at its
	// first change. Only when a range is active: an "All"/truncated window has
	// no earlier x to anchor at (windowStart IS the first point).
	const points: ChartPoint[] = useMemo(() => {
		const series = (data?.points ?? []).map((p) => ({
			ts: new Date(p.date).getTime(),
			date: p.date,
			quantity: p.quantity,
			value: p.value,
		}));
		const opening = data?.openingQuantity;
		const anchorTs = xDomain?.[0] ?? (createdAfter ? Date.parse(createdAfter) : NaN);
		if (series.length === 0 || opening == null || !Number.isFinite(anchorTs)) return series;
		if (anchorTs >= series[0].ts) return series;
		const costUsed = data?.costUsed ?? null;
		return [
			{
				ts: anchorTs,
				date: new Date(anchorTs).toISOString(),
				quantity: opening,
				value: costUsed != null ? costUsed * opening : null,
			},
			...series,
		];
	}, [data, xDomain, createdAfter]);

	// Either kind of cost can price the series; costBasis says which one did.
	const hasCost = data?.costUsed != null;
	const pricedAtPaidCost = data?.costBasis === "paid";
	// Value mode stays visible but disabled when there's no cost to price with,
	// rather than silently falling back to the quantity series under a
	// dollar-labelled axis.
	const effectiveMode: Mode = mode === "value" && hasCost ? "value" : "units";
	const dataKey = effectiveMode === "value" ? "value" : "quantity";

	// A threshold far above the item's history would set the y-domain by itself
	// and collapse the real series onto the zero line. Past 3× the observed
	// peak the overlay is dropped and the notes state why, instead.
	const observedPeak = points.reduce((max, p) => Math.max(max, p.quantity), 0);
	const thresholdOffScale =
		lowStockThreshold != null && lowStockThreshold > Math.max(observedPeak * 3, 10);
	const overlayThreshold = thresholdOffScale ? null : lowStockThreshold;

	const timeDomain = resolveTimeDomain(points, xDomain);

	const modeToggle = (
		<SegmentedToggle<Mode>
			ariaLabel="Chart mode"
			value={effectiveMode}
			onChange={setMode}
			options={[
				{ id: "units", label: "Units" },
				{
					id: "value",
					label: "Value",
					disabled: !hasCost,
					title: hasCost
						? undefined
						: "Set a cost on this item, or record one when receiving stock, to chart its value on hand",
				},
			]}
		/>
	);

	// Built before the early returns so the hook order never changes.
	const { trigger: notesTrigger, caveat, panel } = useChartNotes({
		primary:
			unitBreak ?? "Warehouse stock only — quantity held on vehicles isn't part of this series.",
		details: [
			unitBreak ? UNIT_BREAK_DETAIL : null,
			effectiveMode === "value"
				? pricedAtPaidCost
					? "Priced at the weighted-average cost actually PAID across recorded receipts — see the cost & pricing chart for the per-receipt detail."
					: "Every point is priced at the item's CURRENT configured cost — a directional value trend, not realized COGS. Record a unit cost when receiving stock to price this at what was actually paid."
				: thresholdOffScale
					? `The reorder threshold (${lowStockThreshold?.toLocaleString()}) sits far above every level this item has held, so it isn't drawn — plotting it would flatten this series against the axis.`
					: overlayThreshold != null
						? "The dashed line is the configured reorder threshold; the shaded band below it is the low-stock zone."
						: "Set a low-stock threshold on this item to overlay a reorder line here.",
			"Drawn as steps, not a curve: on-hand holds flat between movements, so a smooth line would show quantities this item never actually held.",
			// Server-side row cap: name the window AND the level it started from,
			// so the first step isn't read as "stock appeared from nothing".
			data?.truncated &&
				`Showing the most recent ${data.points.length} movements${data.windowStart ? `, from ${formatDate(data.windowStart)}` : ""}${data.openingQuantity != null ? ` — ${data.openingQuantity} ${unitLabel(unit, data.openingQuantity)} were on hand before that` : ""}.`,
			data?.hasNegative &&
				"Dips below zero mean this item's ledger predates full stock-movement coverage — consumption was recorded without a matching receipt.",
		],
	});

	if (isLoading) {
		return (
			<Card title="Stock Level Over Time" headerAction={modeToggle}>
				<div className={`${CHART_BODY_H} flex justify-center items-center`}>
					<LoadSvg className="w-7 h-7" />
				</div>
			</Card>
		);
	}

	if (isError) {
		return (
			<Card title="Stock Level Over Time" headerAction={modeToggle}>
				<div className={`${CHART_BODY_H} flex flex-col justify-center`}>
					<QueryErrorState what="stock level history" onRetry={() => refetch()} />
				</div>
			</Card>
		);
	}

	if (unitBreak) {
		return (
			<Card title="Stock Level Over Time" headerAction={notesTrigger}>
				<div className={`${CHART_BODY_H} flex flex-col justify-center`}>
					<EmptyState
						icon={<Scale size={26} />}
						title="Totals unavailable — mixed units"
						description={unitBreak}
					/>
				</div>
				{panel}
			</Card>
		);
	}

	// Two different facts: nothing has EVER moved, vs nothing moved in the
	// chosen range (the series is server-filtered, so an empty response under a
	// range is "quiet range", not "no history").
	if (points.length === 0) {
		return (
			<Card title="Stock Level Over Time" headerAction={modeToggle}>
				<div className={`${CHART_BODY_H} flex flex-col justify-center`}>
					<EmptyState
						icon={<Gauge size={26} />}
						title={createdAfter ? "No movements in this range" : "No history yet"}
						description={
							createdAfter
								? "Warehouse stock didn't change in this range. Widen the range above to see how it got to where it is."
								: "Once stock moves in or out of the warehouse, its on-hand quantity over time will chart here."
						}
					/>
				</div>
			</Card>
		);
	}

	return (
		<Card
			title="Stock Level Over Time"
			headerAction={
				<div className="flex items-center gap-2">
					{/* The threshold chip is gone: the reference line already carries
					    a label and the band already shades the zone — three
					    statements of one number. This chip stays because the plot
					    can't say what priced it. */}
					{effectiveMode === "value" && (
						<ChartChip>{pricedAtPaidCost ? "At paid cost" : "Approximate"}</ChartChip>
					)}
					{modeToggle}
					{notesTrigger}
				</div>
			}
		>
			{/* Everything at rest lives in this fixed-height block so this card and
			    the consumption card beside it match WITHOUT `h-full` tying them to
			    a shared grid row — the notes panel below is then free to grow this
			    card alone. The plot is flex-1, so a caption or caveat that wraps
			    eats into the plot rather than changing the card's height. */}
			<div className={`${CHART_BODY_H} flex flex-col`}>
				{/* Axis caption, horizontal. Says what the y numbers are without a
				    rotated label fighting the tick values for the same gutter. */}
				<p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
					{/* An axis describes a series, not one value, so the unit word is
					    always plural here — unitLabel with no quantity. */}
					{effectiveMode === "value"
						? "Value on hand ($)"
						: `On hand (${unitLabel(unit)})`}
				</p>

				<div className="flex-1 min-h-[240px]">
					<ResponsiveContainer width="100%" height="100%" minHeight={240}>
						<AreaChart
							data={points}
							margin={{ top: 10, right: 10, left: 4, bottom: 0 }}
						>
							<defs>
								<linearGradient id="stockLevelFill" x1="0" y1="0" x2="0" y2="1">
									<stop
										offset="5%"
										stopColor="var(--color-chart-info)"
										stopOpacity={0.3}
									/>
									<stop
										offset="95%"
										stopColor="var(--color-chart-info)"
										stopOpacity={0}
									/>
								</linearGradient>
							</defs>
							<CartesianGrid {...CHART_GRID} />
							<XAxis
								{...timeXAxis(timeDomain)}
								tickFormatter={(v: number) => formatDate(new Date(v))}
							/>
							{/* No rotated axis label: it renders in the same gutter as
							    the tick values and collides with them. The caption
							    above the plot says what these numbers are instead. */}
							<YAxis
								axisLine={false}
								tickLine={false}
								tick={CHART_TICK}
								allowDecimals={effectiveMode === "value"}
								width={effectiveMode === "value" ? 56 : 40}
								tickFormatter={
									effectiveMode === "value" ? formatValueAxis : undefined
								}
								// Floor at min(0, dataMin) rather than a hard 0: a
								// negative series is real data (incomplete ledger
								// coverage), and pinning the domain at 0 clipped it
								// out of view entirely.
								domain={[
									(dataMin: number) => Math.min(0, dataMin),
									(dataMax: number) =>
										effectiveMode === "value"
											? dataMax
											: Math.max(dataMax, overlayThreshold ?? 0),
								]}
							/>
							<Tooltip
								content={<StockTooltip unit={unit} mode={effectiveMode} />}
								cursor={false}
							/>
							{overlayThreshold != null && effectiveMode === "units" && (
								<ReferenceArea
									y1={0}
									y2={overlayThreshold}
									fill="var(--color-chart-warning)"
									fillOpacity={0.08}
									ifOverflow="extendDomain"
								/>
							)}
							{overlayThreshold != null && effectiveMode === "units" && (
								<ReferenceLine
									y={overlayThreshold}
									stroke="var(--color-chart-warning)"
									strokeDasharray="4 4"
									ifOverflow="extendDomain"
									label={{
										value: "Reorder threshold",
										position: "insideTopRight",
										fill: "var(--color-chart-warning)",
										fontSize: 11,
									}}
								/>
							)}
							{/* Zero line only matters when the series actually crosses it */}
							{data?.hasNegative && (
								<ReferenceLine y={0} stroke="var(--color-border)" />
							)}
							{/* stepAfter, never a spline: on-hand is a STEP function — it
							    holds at a value until the next movement. A curve drew
							    quantities this item never actually held, the same reason
							    the cost chart steps its configured series. */}
							<Area
								type="stepAfter"
								dataKey={dataKey}
								name={effectiveMode === "value" ? "Value on hand" : "On hand"}
								stroke="var(--color-chart-info)"
								strokeWidth={2}
								fill="url(#stockLevelFill)"
								dot={false}
								connectNulls
								// Recharts' 1500ms default is far past the ≤200ms the
								// rest of the UI moves in.
								isAnimationActive={false}
							/>
						</AreaChart>
					</ResponsiveContainer>
				</div>

				{caveat}
			</div>

			{/* Outside the fixed block on purpose: opening the disclosure grows THIS
			    card only, instead of dragging the paired card's height with it. */}
			{panel}
		</Card>
	);
}
