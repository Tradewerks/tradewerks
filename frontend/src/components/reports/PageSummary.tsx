import { useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	PieChart,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
	Pie,
} from "recharts";
import type { PageSummaryResponse } from "../../types/reports";
import { InvoiceStatusLabels, type InvoiceStatus } from "../../types/invoices";
import { QuoteStatusLabels, type QuoteStatus } from "../../types/quotes";
import { formatStat, STAT_DESCRIPTIONS } from "./pageSummaryFormat";

interface PageSummaryProps {
	data: PageSummaryResponse;
	onBarClick?: (label: string) => void;
	fill?: boolean;
	chart?: "donut" | "bar";
}

function CustomTooltip({
	active,
	payload,
}: {
	active?: boolean;
	payload?: { name: string; value: number }[];
}) {
	if (!active || !payload?.length) return null;
	const { name, value } = payload[0];
	return (
		<div className="rounded-lg px-3 py-2 bg-base/80 backdrop-blur-md shadow-lg">
			<p className="text-xs text-text-tertiary">{name}</p>
			<p className="text-sm font-semibold text-primary">
				{formatStat(value, "number")}
			</p>
		</div>
	);
}


// Shrinks its text on one line until it fits the parent width 
function FitText({ children }: { children: string }) {
	const ref = useRef<HTMLDivElement>(null);
	const [scale, setScale] = useState(1);

	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setScale(1); // reset before measuring at full size
		requestAnimationFrame(() => {
			const parent = el.parentElement;
			if (!parent) return;
			const avail = parent.clientWidth;
			const needed = el.scrollWidth;
			if (needed > avail && avail > 0) {
				setScale(Math.max(0.45, avail / needed));
			}
		});
	}, [children]);

	return (
		<div
			ref={ref}
			className="origin-left whitespace-nowrap"
			style={{ fontSize: `${scale}em` }}
		>
			{children}
		</div>
	);
}

const BG_COLOR = "var(--color-chart-hole-bg)";

const CHART_PALETTE = [
	"var(--color-chart-primary)",
	"var(--color-chart-success)",
	"var(--color-chart-info)",
	"var(--color-chart-warning)",
	"var(--color-chart-error)",
];

const HEALTH_COLORS: Record<string, string> = {
	Sufficient: "var(--color-chart-success)",
	Low: "var(--color-chart-warning)",
	"Out of Stock": "var(--color-chart-error)",
};

const DONUT_MAX_SLICES = 3;

function sliceColor(page: string, label: string, index: number): string {
	if (page === "inventory" && HEALTH_COLORS[label]) return HEALTH_COLORS[label];
	return CHART_PALETTE[index % CHART_PALETTE.length];
}


// The design system caps motion at 200ms; recharts' default pie waits 400ms then
// sweeps for 1.5s, long enough to read as a broken ring.
const CHART_MOTION_MS = 200;

function DonutLegend({
	label,
	entries,
	onPick,
}: {
	label: string;
	entries: { label: string; display: string; value: number; color: string }[];
	onPick?: (label: string) => void;
}) {
	const total = entries.reduce((sum, e) => sum + e.value, 0);
	return (
		<ul aria-label={label} className="flex min-w-0 flex-col gap-0.5">
			{entries.map((e) => {
				const share = total ? Math.round((e.value / total) * 100) : 0;
				const row = (
					<>
						<span
							className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
							style={{ backgroundColor: e.color }}
						/>
						<span className="truncate text-sm text-text-secondary">{e.display}</span>
						<span className="ml-auto whitespace-nowrap pl-4 text-sm tabular-nums text-text-faint">
							<span className="font-medium text-text-primary">{e.value.toLocaleString()}</span>
							{` · ${share}%`}
						</span>
					</>
				);
				const base = "flex w-full items-center gap-2 rounded px-2 py-1";
				return (
					<li key={e.label}>
						{onPick ? (
							<button
								type="button"
								onClick={() => onPick(e.label)}
								className={`${base} cursor-pointer text-left transition-colors hover:bg-surface-raised`}
							>
								{row}
							</button>
						) : (
							<div className={base}>{row}</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}

function SingleGroup({
	entry,
	color,
	onClick,
}: {
	entry: { display: string; value: number };
	color: string;
	onClick?: () => void;
}) {
	const base = "flex w-full items-center gap-2 rounded-md border border-border-subtle px-3 py-2";
	const body = (
		<>
			<span
				className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
				style={{ backgroundColor: color }}
			/>
			<span className="text-sm text-text-secondary">{entry.display}</span>
			<span className="text-sm text-text-faint">all {entry.value.toLocaleString()}</span>
		</>
	);
	if (!onClick) return <div className={base}>{body}</div>;
	return (
		<button
			type="button"
			onClick={onClick}
			className={`${base} cursor-pointer text-left transition-colors hover:bg-surface-raised`}
		>
			{body}
			<ChevronRight size={14} className="ml-auto shrink-0 text-text-faint" />
		</button>
	);
}

export default function PageSummary({ data, onBarClick, fill, chart }: PageSummaryProps) {
	// Callers that know the grouping say which chart fits it; otherwise few slices
	// → donut (composition), else bars.
	const useDonut = chart
		? chart === "donut"
		: data.breakdown.length > 0 && data.breakdown.length <= DONUT_MAX_SLICES;

	// A breakdown label doubles as the drill-through filter value, so the stored
	// status stays on `label` and only the printed name is swapped. Invoices and
	// quotes are the pages whose badge text differs from the value: Issued shows
	// as "Created", and an invoice's Paid as "Fully Paid".
	const statusLabel = (label: string): string => {
		if (data.breakdownLabel !== "By Status") return label;
		if (data.page === "invoices")
			return InvoiceStatusLabels[label as InvoiceStatus] ?? label;
		if (data.page === "quotes")
			return QuoteStatusLabels[label as QuoteStatus] ?? label;
		return label;
	};
	const breakdown = data.breakdown.map((entry) => ({
		...entry,
		display: statusLabel(entry.label),
	}));
	// The bar chart reports the clicked slice by its printed name; the filter
	// needs the stored one back.
	const rawLabelFor = new Map(breakdown.map((e) => [e.display, e.label]));
	// One non-zero group isn't a breakdown: a 100% donut says nothing, and its lone
	// ring wouldn't take a click.
	const nonZero = breakdown.filter((e) => e.value > 0);
	const single = nonZero.length === 1 ? nonZero[0] : null;

	return (
		<div className={`flex flex-col gap-4${fill ? " min-h-0 flex-1" : ""}`}>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-3">
				{data.stats.map((stat) => {
					const description = STAT_DESCRIPTIONS[data.page]?.[stat.label];
					return (
						<div
							key={stat.label}
							className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface p-3"
						>
							<div
								className={`truncate text-xs text-text-faint${description ? " cursor-help" : ""}`}
								title={description ? `${stat.label} — ${description}` : stat.label}
							>
								{stat.label}
							</div>
							<div
								className="mt-1 text-lg font-semibold text-text-primary"
								title={stat.format === "currency" ? formatStat(stat.value, stat.format) : undefined}
							>
								<FitText>{formatStat(stat.value, stat.format, { wholeDollars: true })}</FitText>
							</div>
							{stat.note && (
								<div className="mt-0.5 truncate text-xs text-warning-text" title={stat.note}>
									{stat.note}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{data.breakdown.length > 0 && (
				<div className={fill ? "flex min-h-0 flex-1 flex-col" : undefined}>
					<div className="mb-2 text-xs font-medium text-text-secondary">
						{data.breakdownLabel}
					</div>
					{single ? (
						<SingleGroup
							entry={single}
							color={sliceColor(data.page, single.label, 0)}
							onClick={onBarClick ? () => onBarClick(single.label) : undefined}
						/>
					) : useDonut ? (
						<div className={`flex items-center justify-center gap-8${fill ? " min-h-0 flex-1" : ""}`}>
							<div className={fill ? "aspect-square h-full max-h-56 min-h-0" : "h-40 w-40 shrink-0"}>
								<ResponsiveContainer width="100%" height="100%">
									<PieChart>
										<Pie
											data={breakdown}
											dataKey="value"
											nameKey="display"
											outerRadius="95%"
											innerRadius="72%"
											paddingAngle={3}
											stroke={BG_COLOR}
											strokeWidth={3}
											label={false}
											animationBegin={0}
											animationDuration={CHART_MOTION_MS}
											animationEasing="ease-out"
											onClick={(entry) => {
												const l = entry?.label ?? entry?.payload?.label;
												if (l != null && onBarClick) onBarClick(String(l));
											}}
											className={onBarClick ? "cursor-pointer" : undefined}
										>
											{breakdown.map((entry, i) => (
												<Cell key={entry.label} fill={sliceColor(data.page, entry.label, i)} />
											))}
										</Pie>
										<Tooltip content={<CustomTooltip />} cursor={false} />
									</PieChart>
								</ResponsiveContainer>
							</div>
							<DonutLegend
								label={data.breakdownLabel}
								entries={breakdown.map((e, i) => ({ ...e, color: sliceColor(data.page, e.label, i) }))}
								onPick={onBarClick}
							/>
						</div>
					) : (
						<div className={fill ? "min-h-0 flex-1" : undefined}>
							<ResponsiveContainer width="100%" height={fill ? "100%" : 220}>
								<BarChart
									data={breakdown}
									onClick={(s) => {
										const l = s?.activeLabel;
										if (l != null && onBarClick) {
											onBarClick(rawLabelFor.get(String(l)) ?? String(l));
										}
									}}
								>
									<CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
									<XAxis dataKey="display" tick={{ fontSize: 11, fill: "var(--color-text-faint)" }} />
									<YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--color-text-faint)" }} />
									<Tooltip
										contentStyle={{
											background: "var(--color-surface)",
											border: "1px solid var(--color-border)",
											borderRadius: 8,
											fontSize: 12,
										}}
									/>
									<Bar
										dataKey="value"
										fill="var(--color-primary)"
										radius={[4, 4, 0, 0]}
										animationDuration={CHART_MOTION_MS}
										animationEasing="ease-out"
										className={onBarClick ? "cursor-pointer" : undefined}
									/>
								</BarChart>
							</ResponsiveContainer>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
