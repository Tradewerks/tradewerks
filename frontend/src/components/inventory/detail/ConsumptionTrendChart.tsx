import { useMemo } from "react";
import {
	BarChart,
	Bar,
	XAxis,
	YAxis,
	CartesianGrid,
	Tooltip,
	ResponsiveContainer,
} from "recharts";
import { BarChart3, Scale } from "lucide-react";
import { format } from "date-fns";
import { useItemConsumptionTrendQuery } from "../../../hooks/useInventory";
import { unitLabel } from "../../../lib/units";
import Card from "../../ui/Card";
import EmptyState from "../../ui/EmptyState";
import { ChartTooltipShell, QueryErrorState } from "./chartShared";
import { CHART_BODY_H, CHART_GRID, CHART_TICK, resolveTimeDomain, timeXAxis } from "./chartAxis";
import { useChartNotes, unitBreakNote, UNIT_BREAK_DETAIL } from "./chartNotes";
import LoadSvg from "../../../assets/icons/loading.svg?react";

type Bucket = "week" | "month";

interface ChartDatum {
	// Epoch millis so this chart can share an x-domain with StockLevelChart.
	ts: number;
	periodStart: string;
	// null ONLY on a unit break, where the server withholds the total. A real
	// zero-consumption bucket is 0 — the whole point of zero-filling this series.
	qtyConsumed: number | null;
}

// A bar covers a whole week or month, so its label has to read as a SPAN. A bare
// date said "consumption happened on Jun 3", which is not what the bucket means.
const periodLabel = (ts: number, bucket: Bucket) =>
	bucket === "week"
		? `Week of ${format(new Date(ts), "MMM d")}`
		: format(new Date(ts), "MMMM yyyy");

const tickLabel = (ts: number, bucket: Bucket) =>
	format(new Date(ts), bucket === "week" ? "MMM d" : "MMM yyyy");

function ConsumptionTooltip({
	active,
	payload,
	bucket,
	unit,
}: {
	active?: boolean;
	payload?: { payload: ChartDatum }[];
	bucket: Bucket;
	unit: string;
}) {
	if (!active || !payload?.length) return null;
	const d = payload[0].payload;
	if (d.qtyConsumed == null) return null;

	return (
		<ChartTooltipShell title={periodLabel(d.ts, bucket)}>
			<p className="text-sm font-semibold text-primary">
				{d.qtyConsumed} {unitLabel(unit, d.qtyConsumed)} consumed
			</p>
		</ChartTooltipShell>
	);
}

// Bucketed consumption totals (GET /inventory/:id/consumption-trend) — counts
// only parts_used + direct_consumption movements, same as ItemUsage / the
// reorder forecast. Zero-filled server-side, so a flat bar is a real
// zero-consumption period, never a missing point. Range/bucket both come
// from the tab-level control since bucket is a consequence of range, not an
// independent choice.
export default function ConsumptionTrendChart({
	itemId,
	unit,
	bucket,
	range,
	xDomain,
}: {
	itemId: string;
	unit: string;
	bucket: Bucket;
	// Bucket count, resolved by the caller from the tab range.
	range?: number;
	xDomain?: [number, number];
}) {
	const { data, isLoading, isError, refetch } = useItemConsumptionTrendQuery(itemId, {
		bucket,
		range,
	});

	const points: ChartDatum[] = useMemo(
		() =>
			(data?.points ?? []).map((p) => ({
				ts: new Date(p.periodStart).getTime(),
				periodStart: p.periodStart,
				qtyConsumed: p.qtyConsumed,
			})),
		[data],
	);

	// Checked ahead of the zero/too-few branches: a unit break still arrives
	// zero-filled, so without this the card would falsely claim "no consumption".
	const unitBreak = unitBreakNote(data?.unitBasis, "per-period totals");

	const totalConsumed = points.reduce((sum, p) => sum + (p.qtyConsumed ?? 0), 0);
	// Two distinct facts: too few buckets is "no trend to show yet", while a
	// full series of zeroes is a real answer ("wasn't consumed in this range").
	const tooFewPoints = points.length < 2;
	const noConsumption = !tooFewPoints && totalConsumed === 0;

	const timeDomain = resolveTimeDomain(points, xDomain);

	const { trigger: notesTrigger, caveat, panel } = useChartNotes({
		primary: unitBreak
			? unitBreak
			: noConsumption
			? `No consumption recorded in this range — every ${bucket}ly total is zero.`
			: `Parts used and direct consumption only, totalled by ${bucket}.`,
		details: [
			unitBreak ? UNIT_BREAK_DETAIL : null,
			"Periods with no activity are zero-filled, so a bar sitting on the axis is a real zero rather than a gap in the data.",
			`The ${bucket}ly grain follows the range control above — it isn't a separate setting.`,
			"Stock moved to a vehicle isn't consumption; it counts when a technician uses it on a visit.",
		],
	});

	if (isLoading) {
		return (
			<Card title="Consumption Trend">
				<div className={`${CHART_BODY_H} flex justify-center items-center`}>
					<LoadSvg className="w-7 h-7" />
				</div>
			</Card>
		);
	}

	// Checked before the zero/too-few branches: an errored query has no points,
	// and falling through would claim "not enough history" over a failed read.
	if (isError) {
		return (
			<Card title="Consumption Trend">
				<div className={`${CHART_BODY_H} flex flex-col justify-center`}>
					<QueryErrorState what="the consumption trend" onRetry={() => refetch()} />
				</div>
			</Card>
		);
	}

	// Same shape as "not enough history" below — a unit break is informational,
	// not an error, so no red and no alarm icon.
	if (unitBreak) {
		return (
			<Card title="Consumption Trend" headerAction={notesTrigger}>
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

	if (tooFewPoints) {
		return (
			<Card title="Consumption Trend">
				<div className={`${CHART_BODY_H} flex flex-col justify-center`}>
					<EmptyState
						icon={<BarChart3 size={26} />}
						title="Not enough history yet"
						description="Once parts are used on visits or consumed directly, per-period totals will chart here."
					/>
				</div>
			</Card>
		);
	}

	return (
		<Card title="Consumption Trend" headerAction={notesTrigger}>
			{/* Fixed-height at-rest block, matching StockLevelChart's, so the two
			    cards line up without `h-full` binding them to one grid row. */}
			<div className={`${CHART_BODY_H} flex flex-col`}>
				{/* Matches the stock chart's caption so the paired cards read the same
				    way — and so the unit never has to be inferred from the tooltip. */}
				<p className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">
					Consumed ({unitLabel(unit)})
				</p>

				<div className="flex-1 min-h-[240px]">
					<ResponsiveContainer width="100%" height="100%" minHeight={240}>
						<BarChart
							data={points}
							margin={{ top: 10, right: 10, left: 4, bottom: 0 }}
						>
							<CartesianGrid {...CHART_GRID} />
							{/* Numeric time axis, shared with StockLevelChart so a
							    consumption spike sits directly above the stock drop it
							    caused. Bars need an explicit width once the axis is
							    numeric — categorical spacing no longer applies. */}
							<XAxis
								{...timeXAxis(timeDomain)}
								tickFormatter={(v: number) => tickLabel(v, bucket)}
							/>
							{/* No rotated axis label: it shares the tick gutter and
							    collides with the values. The caption above the plot
							    carries the unit instead. */}
							<YAxis
								axisLine={false}
								tickLine={false}
								tick={CHART_TICK}
								allowDecimals={false}
								width={40}
								// An all-zero series would otherwise collapse to a
								// degenerate domain and render no usable axis.
								domain={noConsumption ? [0, 1] : undefined}
							/>
							<Tooltip
								content={<ConsumptionTooltip bucket={bucket} unit={unit} />}
								cursor={false}
							/>
							<Bar
								dataKey="qtyConsumed"
								name="Consumed"
								fill="var(--color-chart-primary)"
								radius={[3, 3, 0, 0]}
								// Explicit width: on a numeric x-axis Recharts has no
								// category band to derive bar width from, so without
								// this the bars render hairline-thin.
								barSize={bucket === "week" ? 10 : 20}
								maxBarSize={40}
								// Recharts' 1500ms default grow is far past the ≤200ms
								// the rest of the UI moves in.
								isAnimationActive={false}
							/>
						</BarChart>
					</ResponsiveContainer>
				</div>

				{caveat}
			</div>

			{/* Outside the fixed block: disclosure grows this card alone. */}
			{panel}
		</Card>
	);
}
