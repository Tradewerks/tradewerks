import { useState } from "react";
import { Calendar, ChevronDown } from "lucide-react";
import {
	BarChart,
	Bar,
	LabelList,
	ReferenceLine,
	XAxis,
	YAxis,
	Tooltip,
	ResponsiveContainer,
} from "recharts";
import Card from "../ui/Card";
import SegmentedToggle from "../ui/SegmentedToggle";
import { ChartTooltipShell } from "../inventory/detail/chartShared";
import { formatCurrency } from "../../util/util";

export interface TechRevenueDatum {
	techId: string;
	techName: string;
	revenue: number;
	// Revenue from visits that logged time — the only revenue an hourly rate can honestly divide.
	timedRevenue: number;
	hours: number;
	visits: number;
}

type Metric = "revenue" | "perHour";

interface TechRevenueChartProps {
	data: TechRevenueDatum[];
	periodLabel: string;
	onSelectTech?: (techId: string) => void;
}

interface BarDatum {
	techId: string;
	techName: string;
	value: number;
	source: TechRevenueDatum;
}

const ROW_PX = 36;
const COLLAPSED_ROWS = 8;

const METRIC_COPY: Record<Metric, { title: string; definition: string }> = {
	revenue: {
		title: "Revenue by technician",
		definition: "Each completed visit's total, split evenly between the technicians assigned to it.",
	},
	perHour: {
		title: "Revenue per hour by technician",
		definition: "Revenue from visits with logged time, divided by the hours logged on them.",
	},
};

// Shown on demand: the full method, with a worked example, so the numbers can be
// reproduced by hand instead of taken on trust.
const METHOD_STEPS = [
	"Only completed visits count, dated by their scheduled start and limited to the selected period.",
	"A visit's total is its amount after discounts, including tax.",
	"When several technicians share a visit, its total is split evenly. A $900 visit with 3 technicians credits each $300.",
	"Revenue / Hr uses only visits where that technician logged time, divided by the hours they logged. Visits with no logged time still count toward Revenue.",
	"The dashed line is the average revenue per technician, or for Revenue / Hr, the team rate: all revenue from timed visits divided by all logged hours.",
];

const formatValue = (metric: Metric, v: number) =>
	metric === "perHour" ? `${formatCurrency(v)}/hr` : formatCurrency(v);

function BarTooltip({
	active,
	payload,
	metric,
}: {
	active?: boolean;
	payload?: { payload: BarDatum }[];
	metric: Metric;
}) {
	if (!active || !payload?.length) return null;
	const { source, value, techName } = payload[0].payload;
	return (
		<ChartTooltipShell title={techName}>
			<p className="text-sm font-semibold text-text-primary tabular-nums">
				{metric === "perHour" ? `${formatCurrency(value)} per hour` : formatCurrency(value)}
			</p>
			<p className="text-xs text-text-tertiary tabular-nums">
				{source.visits} {source.visits === 1 ? "visit" : "visits"} ·{" "}
				{source.hours.toFixed(1)} logged hours
			</p>
			{metric === "perHour" && source.timedRevenue !== source.revenue && (
				<p className="text-xs text-text-tertiary tabular-nums">
					Excludes {formatCurrency(source.revenue - source.timedRevenue)} from visits with no
					logged time
				</p>
			)}
			<p className="mt-1 text-[11px] text-text-muted">Click to see this technician's visits</p>
		</ChartTooltipShell>
	);
}

export default function TechRevenueChart({ data, periodLabel, onSelectTech }: TechRevenueChartProps) {
	const [metric, setMetric] = useState<Metric>("revenue");
	const [expanded, setExpanded] = useState(false);
	const [showMethod, setShowMethod] = useState(false);
	// Name column + value-label margin are fixed px; on a phone they'd leave the bars a sliver.
	const [plotWidth, setPlotWidth] = useState(0);
	const narrow = plotWidth > 0 && plotWidth < 480;

	const eligible = metric === "perHour" ? data.filter((d) => d.hours > 0) : data;
	const excluded = metric === "perHour" ? data.filter((d) => d.hours <= 0) : [];

	const bars: BarDatum[] = eligible
		.map((d) => ({
			techId: d.techId,
			techName: d.techName,
			value: metric === "perHour" ? d.timedRevenue / d.hours : d.revenue,
			source: d,
		}))
		.sort((a, b) => b.value - a.value);
	const visible = expanded ? bars : bars.slice(0, COLLAPSED_ROWS);

	// Per-hour reference is the pooled team rate (total ÷ total), not a mean of rates,
	// so a tech with 0.5 hrs can't swing it.
	let reference: { value: number; label: string } | null = null;
	if (metric === "perHour") {
		const hours = eligible.reduce((s, d) => s + d.hours, 0);
		const timed = eligible.reduce((s, d) => s + d.timedRevenue, 0);
		if (hours > 0) {
			reference = {
				value: timed / hours,
				label: `Team rate ${formatValue(metric, timed / hours)}`,
			};
		}
	} else if (bars.length > 1) {
		const mean = bars.reduce((s, b) => s + b.value, 0) / bars.length;
		reference = { value: mean, label: `Avg per technician ${formatValue(metric, mean)}` };
	}

	const copy = METRIC_COPY[metric];

	return (
		<Card
			title={copy.title}
			headerAction={
				// items-stretch: the period label takes the toggle's exact height rather than a guessed one.
				<div className="flex items-stretch gap-2">
					<span
						title="Change the period with the Date filter above"
						className="flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border-subtle bg-surface px-2.5 text-xs font-medium text-text-secondary"
					>
						<Calendar size={13} aria-hidden className="shrink-0 text-text-muted" />
						{periodLabel}
					</span>
					<SegmentedToggle<Metric>
						ariaLabel="Chart metric"
						value={metric}
						onChange={setMetric}
						options={[
							{ id: "revenue", label: "Revenue" },
							{ id: "perHour", label: "Revenue / Hr" },
						]}
					/>
				</div>
			}
		>
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
				<p className="text-xs text-text-muted">{copy.definition}</p>
				<button
					type="button"
					onClick={() => setShowMethod((v) => !v)}
					aria-expanded={showMethod}
					aria-controls="tech-revenue-method"
					className="flex shrink-0 items-center gap-1 rounded text-xs font-medium text-text-secondary transition-colors duration-150 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
				>
					How this is calculated
					<ChevronDown
						size={14}
						aria-hidden
						className={`transition-transform duration-150 ease-out ${showMethod ? "rotate-180" : ""}`}
					/>
				</button>
			</div>
			{showMethod && (
				<ol
					id="tech-revenue-method"
					className="mb-4 list-decimal space-y-1 rounded-md border border-border-subtle bg-surface py-2.5 pl-8 pr-3 text-xs leading-relaxed text-text-secondary"
				>
					{METHOD_STEPS.map((step) => (
						<li key={step}>{step}</li>
					))}
				</ol>
			)}

			{bars.length === 0 ? (
				<p className="py-6 text-center text-sm text-text-muted">
					{metric === "perHour"
						? "No technician has logged time in this period."
						: "No completed visits in this period."}
				</p>
			) : (
				<div style={{ height: visible.length * ROW_PX + 28 }}>
					<ResponsiveContainer
						width="100%"
						height="100%"
						minWidth={0}
						onResize={(width) => setPlotWidth(width)}
					>
						<BarChart
							data={visible}
							layout="vertical"
							margin={{ top: 20, right: narrow ? 76 : 96, bottom: 0, left: 0 }}
							barCategoryGap={10}
						>
							<XAxis type="number" hide domain={[0, "dataMax"]} />
							<YAxis
								type="category"
								dataKey="techName"
								axisLine={false}
								tickLine={false}
								width={narrow ? 92 : 140}
								tickFormatter={(name: string) =>
									narrow && name.length > 13 ? `${name.slice(0, 12)}…` : name
								}
								tick={{
									fill: "var(--color-text-secondary)",
									fontSize: narrow ? 12 : 13,
								}}
							/>
							<Tooltip
								content={<BarTooltip metric={metric} />}
								cursor={{ fill: "var(--color-surface)" }}
								offset={24}
								isAnimationActive={false}
							/>
							{reference && (
								<ReferenceLine
									x={reference.value}
									stroke="var(--color-text-muted)"
									strokeDasharray="4 4"
									ifOverflow="extendDomain"
									label={{
										value: reference.label,
										position: "top",
										fill: "var(--color-text-muted)",
										fontSize: 11,
									}}
								/>
							)}
							<Bar
								dataKey="value"
								fill="var(--color-chart-primary)"
								radius={[0, 4, 4, 0]}
								maxBarSize={18}
								cursor={onSelectTech ? "pointer" : undefined}
								onClick={(_, index) => onSelectTech?.(visible[index].techId)}
								isAnimationActive={false}
							>
								<LabelList
									dataKey="value"
									position="right"
									formatter={(v: unknown) => formatValue(metric, Number(v))}
									style={{ fill: "var(--color-text-primary)", fontSize: 12 }}
								/>
							</Bar>
						</BarChart>
					</ResponsiveContainer>
				</div>
			)}

			{(excluded.length > 0 || bars.length > COLLAPSED_ROWS) && (
				<div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-text-muted">
					<span>
						{excluded.length > 0 &&
							`Not shown (no logged time): ${excluded.map((d) => d.techName).join(", ")}`}
					</span>
					{bars.length > COLLAPSED_ROWS && (
						<button
							type="button"
							onClick={() => setExpanded((e) => !e)}
							className="font-medium text-text-secondary transition-colors hover:text-text-primary"
						>
							{expanded ? `Show top ${COLLAPSED_ROWS}` : `Show all ${bars.length} technicians`}
						</button>
					)}
				</div>
			)}
		</Card>
	);
}
