import type { ReactNode } from "react";
import {
	AlertTriangle,
	ChevronRight,
	Gauge,
	PauseCircle,
	Timer,
	TrendingDown,
	Warehouse,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useItemForecastQuery } from "../../../hooks/useInventory";
import type { ReorderSeverity } from "../../../types/reports";
import { PLOT_WINDOW_DAYS, REORDER_BAND_DAYS } from "../../../lib/reorderChart";
import { bandPct, runwayMeter } from "../../../lib/reorderMeter";
import { formatDate } from "../../../util/util";
import { unitLabel } from "../../../lib/units";
import Card from "../../ui/Card";
import EmptyState from "../../ui/EmptyState";
import { useChartNotes, unitBreakNote, unitBreakShort, UNIT_BREAK_DETAIL } from "./chartNotes";
import LoadSvg from "../../../assets/icons/loading.svg?react";

type Tone = "success" | "warning" | "error" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
	success: "text-success-text",
	warning: "text-warning-text",
	error: "text-error-text",
	neutral: "text-text-tertiary",
};

const TONE_BADGE: Record<Tone, string> = {
	success: "bg-success/15 text-success-text border border-success/30",
	warning: "bg-warning/15 text-warning-text border border-warning/30",
	error: "bg-error/15 text-error-text border border-error/30",
	neutral: "bg-surface text-text-tertiary border border-border",
};

const TONE_FILL: Record<Tone, string> = {
	success: "bg-success",
	warning: "bg-warning",
	error: "bg-error",
	neutral: "bg-text-tertiary",
};

// The verdict is computed server-side (reportsController.reorderSeverity) and
// shared with the org-wide reorder report, so this card and the priority chart
// can't disagree about the same item. These maps are presentation only.
const SEVERITY_TONE: Record<ReorderSeverity, Tone> = {
	critical: "error",
	warning: "warning",
	healthy: "success",
	unknown: "neutral",
};

// Same words the org-wide report's Health column and priority legend use — one
// item shouldn't read "Reorder now" there and something else here.
const SEVERITY_LABEL: Record<ReorderSeverity, string> = {
	critical: "Reorder now",
	warning: "Watch",
	healthy: "Healthy",
	unknown: "No signal",
};

// The forecast window is FIXED at 90 days — the same window the org-wide reorder
// report uses — and deliberately does NOT follow the tab's range control.
// Stating it on the card is the point: a dispatcher comparing this against the
// charts beside it needs to know the spans differ.
const FORECAST_WINDOW_LABEL = "Last 90 days";

// Ticks on the days track. The end tick says "30d+" because the fill caps there:
// a 90-day runway and a 31-day runway both fill the bar, and the headline number
// is what separates them.
const METER_TICKS = [
	{ days: 0, label: "0" },
	{ days: REORDER_BAND_DAYS.critical, label: `${REORDER_BAND_DAYS.critical}d` },
	{ days: REORDER_BAND_DAYS.warning, label: `${REORDER_BAND_DAYS.warning}d` },
	{ days: PLOT_WINDOW_DAYS, label: `${PLOT_WINDOW_DAYS}d+` },
];

function Figure({
	icon,
	label,
	value,
	sub,
}: {
	icon: ReactNode;
	label: string;
	value: ReactNode;
	sub?: ReactNode;
}) {
	return (
		<div className="flex-1 min-w-[140px] bg-base border border-border-subtle rounded-lg px-3 py-2">
			<div className="flex items-center gap-1.5 text-text-muted">
				{icon}
				<span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
			</div>
			<div className="mt-0.5 text-lg font-bold tabular-nums leading-tight text-text-primary">
				{value}
			</div>
			{sub && <div className="text-xs text-text-muted">{sub}</div>}
		</div>
	);
}

const LOADING_FIGURES: { label: string; icon: ReactNode }[] = [
	{ label: "On Hand (org-wide)", icon: <Warehouse size={13} /> },
	{ label: "Avg Daily Usage", icon: <Gauge size={13} /> },
	{ label: "Days of Stock", icon: <Timer size={13} /> },
	{ label: "Consumed", icon: <TrendingDown size={13} /> },
];

// Mirrors the "View all →" affordance on TrackingSummaryBlock: a dispatcher who
// finds this one item critical reaches the ranked org-wide list in one click.
const orgForecastLink = (
	<Link
		to="/dispatch/inventory/reorder-forecast"
		className="inline-flex items-center gap-0.5 text-xs font-medium text-primary hover:underline"
	>
		View org-wide forecast
		<ChevronRight size={13} />
	</Link>
);

// The single reorder-health read on the History tab.
//
// The headline is DAYS OF STOCK on a 0→30d+ meter marked at the same band
// days the org-wide priority bars use, so one item reads the same way on
// both surfaces. Warehouse-vs-reorder-point is stated in words underneath,
// where each number can name its own scope.
export default function ReorderHealthCard({ itemId }: { itemId: string }) {
	const { data, isLoading } = useItemForecastQuery(itemId);
	const forecast = data?.forecast ?? null;
	const reason = data?.reason ?? null;

	const hasThreshold = forecast?.lowStockThreshold != null;
	// A unit break withholds the rate server-side, so `avgDailyUsage` is null —
	// not the same fact as a measured zero. `?? 0` would collapse the two.
	const hasUsage = forecast?.avgDailyUsage != null && forecast.avgDailyUsage > 0;
	// The rate-derived figures (runway meter, avg use, days of stock, consumed
	// total) are withheld together; cached quantity columns and the severity
	// verdict still render, so the card keeps its shape instead of going empty.
	const unitBreak = unitBreakNote(forecast?.consumptionBasis, "a usage rate or a runway");
	const mixedShort = unitBreakShort(forecast?.consumptionBasis);
	const { trigger: notesTrigger, notes } = useChartNotes({
		primary:
			unitBreak ??
			`Runway = org-wide on hand ÷ average daily use over the ${FORECAST_WINDOW_LABEL.toLowerCase()} — a fixed window that does not follow the range control above.`,
		details: [
			unitBreak ? UNIT_BREAK_DETAIL : null,
			"The meter caps at 30 days so the urgent end of the scale stays readable; past the cap the headline number is the measurement, not the bar.",
			`Bands mark ${REORDER_BAND_DAYS.critical} and ${REORDER_BAND_DAYS.warning} days, the same thresholds the org-wide reorder report ranks on.`,
			"The reorder point is a WAREHOUSE threshold, while the runway divides org-wide on hand — a van-heavy item can sit below its reorder point with weeks of runway.",
			forecast &&
				!hasThreshold &&
				"No reorder point is set on this item — add a low-stock threshold to compare warehouse stock against it here.",
			forecast &&
				!unitBreak &&
				!hasUsage &&
				`No consumption in the ${FORECAST_WINDOW_LABEL.toLowerCase()}, so no stockout can be projected.`,
		],
	});

	if (isLoading) {
		return (
			<Card title="Reorder Health" headerAction={orgForecastLink}>
				<div className="flex flex-wrap gap-3 pt-1">
					{LOADING_FIGURES.map((f) => (
						<Figure key={f.label} icon={f.icon} label={f.label} value="…" />
					))}
				</div>
				<div className="flex justify-center py-6">
					<LoadSvg className="w-7 h-7" />
				</div>
			</Card>
		);
	}

	// Two unrelated causes for a null forecast, and naming the wrong one is
	// worse than saying nothing: `inactive` means forecasting was skipped on
	// purpose, `no_forecast_row` means the item is live but has no recorded
	// usage to project from.
	if (!forecast) {
		return (
			<Card title="Reorder Health" headerAction={orgForecastLink}>
				<EmptyState
					icon={<PauseCircle size={26} />}
					title={
						reason === "inactive"
							? "Not forecast for inactive items"
							: "No usage to forecast yet"
					}
					description={
						reason === "inactive"
							? "Reorder forecasting only runs for active items. Reactivate this item to see its runway again."
							: `This item has no recorded consumption in the ${FORECAST_WINDOW_LABEL.toLowerCase()}, so a runway can't be projected yet.`
					}
				/>
			</Card>
		);
	}

	const {
		unit,
		currentQuantity,
		warehouseQuantity,
		vehicleQuantity,
		lowStockThreshold,
		avgDailyUsage,
		observedDays,
		daysOfStock,
		qtyConsumed,
		consumptionBasis,
		projectedStockoutDate,
		belowReorderPoint,
		severity,
	} = forecast;
	const tone = SEVERITY_TONE[severity];
	const meter = runwayMeter(daysOfStock);
	const roundedDays = daysOfStock != null ? Math.round(daysOfStock) : null;

	// Warehouse stock against its own threshold, in words. Both numbers name their
	// scope, so nothing has to be inferred from a marker's position.
	const stockLine = hasThreshold
		// Thousands separators: a 10-digit reorder point is a legal value, and as a
		// bare digit run it reads as noise in the middle of a sentence.
		? `Warehouse ${warehouseQuantity} ${unitLabel(unit, warehouseQuantity)} · reorder point ${lowStockThreshold?.toLocaleString()} ${unitLabel(unit, lowStockThreshold ?? undefined)}`
		: `Warehouse ${warehouseQuantity} ${unitLabel(unit, warehouseQuantity)} · no reorder point set`;

	return (
		<Card
			title="Reorder Health"
			headerAction={
				<div className="flex items-center gap-2">
					{orgForecastLink}
					{notesTrigger}
				</div>
			}
		>
			{/* Headline first: the runway in days, its verdict, and when it runs
			    out — no line-tracing required. Proportional figures, not tabular:
			    equal-width digits read loose at display size. */}
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<span className="text-2xl font-bold leading-none text-text-primary">
					{roundedDays != null ? `${roundedDays} days` : "No runway"}
				</span>
				<span className="text-sm text-text-muted">
					{roundedDays != null
							? "of stock left"
							: mixedShort
								? "— units differ over this window"
								: "measurable yet"}
				</span>
				<span
					className={`ml-auto px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${TONE_BADGE[tone]}`}
				>
					{SEVERITY_LABEL[severity]}
				</span>
			</div>

			{meter ? (
				<div className="mt-3">
					<div className="relative h-2.5 rounded-full bg-surface-raised border border-border-subtle overflow-hidden">
						<div
							className={`absolute inset-y-0 left-0 ${TONE_FILL[tone]} transition-[width] duration-200 ease-out`}
							style={{ width: `${meter.pct}%` }}
						/>
						{/* Band marks sit ON the track so the fill's end reads
						    against them directly. */}
						{[REORDER_BAND_DAYS.critical, REORDER_BAND_DAYS.warning].map((days) => (
							<div
								key={days}
								className="absolute inset-y-0 w-px bg-border-strong"
								style={{ left: `${bandPct(days)}%` }}
							/>
						))}
					</div>

					{/* Axis ticks: the thing the old quantity track never had. */}
					<div className="relative mt-1 h-4 text-[10px] text-text-muted">
						{METER_TICKS.map((t, i) => (
							<span
								key={t.days}
								className="absolute tabular-nums"
								style={{
									left: `${bandPct(t.days)}%`,
									transform:
										i === 0
											? "none"
											: i === METER_TICKS.length - 1
												? "translateX(-100%)"
												: "translateX(-50%)",
								}}
							>
								{t.label}
							</span>
						))}
					</div>

					<p className="mt-1 text-[11px] text-text-secondary">
						{projectedStockoutDate ? (
							<>
								Est. out{" "}
								<span className="font-semibold">
									~{formatDate(projectedStockoutDate)}
								</span>
								{meter.clamped && " · beyond the 30-day view"}
							</>
						) : (
							"No stockout projected in this window"
						)}
					</p>
				</div>
			) : unitBreak ? (
				// Same slot, different fact. "No consumption" would be a false claim
				// about an item that was consumed plenty — just not in one unit.
				<p className="mt-2 text-[11px] text-text-secondary">{unitBreak}</p>
			) : (
				<p className="mt-2 text-[11px] text-text-secondary">
					No consumption in the {FORECAST_WINDOW_LABEL.toLowerCase()}, so no runway
					can be projected — the stock position below is all this item can be judged
					on.
				</p>
			)}

			{/* Warehouse stock vs its own threshold, in words rather than as a
			    second axis. */}
			<p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
				<span>{stockLine}</span>
				{belowReorderPoint && (
					<span
						className={`inline-flex items-center gap-1 font-semibold ${TONE_TEXT.error}`}
					>
						<AlertTriangle size={12} />
						below
					</span>
				)}
			</p>

			{/* Supporting figures — what the meter can't show on its own */}
			<div className="mt-3 flex flex-wrap gap-3">
				<Figure
					icon={<Warehouse size={13} />}
					label="On Hand (org-wide)"
					value={`${currentQuantity} ${unitLabel(unit, currentQuantity)}`}
					sub={`${warehouseQuantity} warehouse · ${vehicleQuantity} on vehicles`}
				/>
				{/* Rate-derived figures read "—" on a unit break, never a number — a
				    withheld rate rendered as `0.00 / day` would look like a real idle
				    item. The sub-line carries the reason. */}
				<Figure
					icon={<Gauge size={13} />}
					label="Avg Daily Usage"
					value={avgDailyUsage != null ? `${avgDailyUsage.toFixed(2)} / day` : "—"}
					sub={
						avgDailyUsage == null
							? mixedShort
							: hasUsage
								? // Naming the measured span matters: a rate off 6 days
									// of history is not the 90-day average the chip
									// implies.
									`~${(avgDailyUsage * 7).toFixed(1)} / week · over ${Math.round(observedDays)}d`
								: "No recent usage"
					}
				/>
				<Figure
					icon={<Timer size={13} />}
					label="Days of Stock"
					// Unit on the value: a bare integer beside three unit-carrying
					// figures reads as a quantity.
					value={roundedDays != null ? `${roundedDays}d` : "—"}
					sub={
						projectedStockoutDate
							? `Out ~${formatDate(projectedStockoutDate)}`
							: mixedShort
								? mixedShort
								: hasUsage
									? "No projection"
									: "No recent usage"
					}
				/>
				<Figure
					icon={<TrendingDown size={13} />}
					label="Consumed"
					// Labelled from the STAMPED consumption unit, falling back to the
					// item's unit only when the window held no movements at all.
					value={
						qtyConsumed != null
							? `${qtyConsumed} ${unitLabel(consumptionBasis.unit ?? unit, qtyConsumed)}`
							: "—"
					}
					sub={qtyConsumed == null ? mixedShort : FORECAST_WINDOW_LABEL}
				/>
			</div>

			{notes}
		</Card>
	);
}
