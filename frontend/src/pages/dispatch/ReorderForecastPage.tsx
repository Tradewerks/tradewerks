import { useEffect, useMemo, useState } from "react";
import { Check, Package } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import AdaptableTable, { type ColumnClamp } from "../../components/AdaptableTable";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import ReorderPriorityChart from "../../components/reports/ReorderPriorityChart";
import ReportPagination from "../../components/reports/ReportPagination";
import { hasReorderChartContent } from "../../lib/reorderChart";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { useColumnVisibility, type ColumnOption } from "../../hooks/useColumnVisibility";
import { camelCaseToRegular } from "../../util/util";
import { useReorderForecastQuery } from "../../hooks/useReports";
import { exportReportServer } from "../../api/reports";
import { datedFilename } from "../../util/download";
import {
	REORDER_FORECAST_WINDOW_DAYS,
	type ReorderForecastRow,
	type ReorderSeverity,
	type ReportFetchParams,
} from "../../types/reports";

/** Build column options (label derived from the key) in display order. */
const cols = (...keys: string[]): ColumnOption[] =>
	keys.map((key) => ({ key, label: camelCaseToRegular(key) }));

const COLS = cols(
	"item",
	"sku",
	"category",
	"onHand",
	"warehouse",
	"vehicles",
	"reorderPoint",
	"avgDailyUsage",
	// The runway is the chart's x-axis and the number this whole report ranks on,
	// but the table only ever showed the date derived from it. Placed next to the
	// rate it comes from and before the date it produces.
	"daysOfStock",
	"projectedStockout",
	"health",
	// The report always said "buy this much, by then" with no answer to "from
	// whom". A leading "~" means the vendor was inferred from the last purchase
	// rather than chosen by anyone.
	"buyFrom",
);

const SEVERITY_ORDER: ReorderSeverity[] = ["critical", "warning", "healthy", "unknown"];

// Context the spreadsheet needs and the table doesn't: the unit the quantities
// are in, how many days of history the rate was measured over, and the raw
// consumption behind it. Appended after whatever columns are visible.
const EXPORT_ONLY_COLS: ColumnOption[] = [
	{ key: "unit", label: "Unit" },
	{ key: "observedDays", label: "Days Observed" },
	{ key: "qtyConsumed", label: `Qty Consumed (${REORDER_FORECAST_WINDOW_DAYS}d)` },
	// Whoever works the export is the one placing the order: they need the
	// vendor's own part number and what closing the gap costs.
	{ key: "vendorSku", label: "Vendor Part #" },
	{ key: "estimatedCost", label: "Est. Cost to Reorder" },
];

// Label + tone for the server-computed reorder verdict. The row already CARRIES
// the label — reportRegistry.forecastRow shapes it, so the table, the export and
// the health filter all read the same words — but the tiles and the filter chips
// are keyed by severity, so the map still lives here.
const HEALTH_LABEL: Record<ReorderSeverity, string> = {
	critical: "Reorder now",
	warning: "Watch",
	healthy: "Healthy",
	unknown: "No signal",
};

// Keyed by the rendered label, not by severity: AdaptableTable derives its
// columns from the row object's keys, so carrying a raw `severity` field on the
// row would show up as an extra column.
const HEALTH_CELL_CLASS: Record<string, string> = {
	[HEALTH_LABEL.critical]: "text-error-text font-semibold",
	[HEALTH_LABEL.warning]: "text-warning-text font-medium",
	[HEALTH_LABEL.healthy]: "text-success-text",
	[HEALTH_LABEL.unknown]: "text-text-muted",
};

// The band rule, in the reader's terms. The tile is the only place the report
// says what puts an item in a band, and the band is what the tile counts — so it
// takes the hint slot every other report stat card uses. Tracks reorderSeverity()
// on the server: critical is ≤7 days or below the reorder point, warning is ≤21
// days or within 1.25x of the point, healthy is above that, unknown is no signal.
// Kept short enough to hold one line at four-up — the rule is the tile's second
// line, and a rule that wraps puts the strip back to three lines tall.
const SEVERITY_RULE: Record<ReorderSeverity, string> = {
	// `d` for days, the same shorthand the Days Of Stock column uses.
	critical: "≤7d or below reorder point",
	warning: "8–21d or near reorder point",
	healthy: "More than 21d of stock",
	unknown: "No usage measured",
};

// Three of these columns hold text a person typed, and all three are capped far
// above what fits a column: a 255-character item name, a 100-character SKU with
// no break opportunity in it, a 100-character category. The table lays out
// `auto`, so one verbose part sizes the column and pushes the quantities this
// report ranks on out past the right edge.
//
// The rule is that free text truncates and computed values don't. A cut part
// name still identifies the row — two lines, because the half of a part name
// that distinguishes it from its siblings is usually at the end, and the full
// string is on hover and one click away on the item page. A cut quantity is a
// wrong number, so everything the forecast computes gets one line and no cap:
// the panel scrolls before a figure is allowed to wrap or be clipped.
const COLUMN_CLAMP: Record<string, ColumnClamp> = {
	item: { maxWidth: "22rem", lines: 2 },
	sku: { maxWidth: "11rem" },
	category: { maxWidth: "11rem" },
	onHand: { lines: 1 },
	warehouse: { lines: 1 },
	vehicles: { lines: 1 },
	reorderPoint: { lines: 1 },
	avgDailyUsage: { lines: 1 },
	daysOfStock: { lines: 1 },
	projectedStockout: { lines: 1 },
	health: { lines: 1 },
};

// Selected fill, checkbox fill, and count tone per band. Selection is carried by
// a checkbox and a tinted panel, not by border colour alone: four counts that
// only shift their edge when active read as decoration rather than as the filter
// they are.
const SEVERITY_TILE: Record<ReorderSeverity, { selected: string; box: string; count: string }> = {
	critical: {
		selected: "border-error/60 bg-error-bg",
		box: "border-error bg-error",
		count: "text-error-text",
	},
	warning: {
		selected: "border-warning/60 bg-warning-bg",
		box: "border-warning bg-warning",
		count: "text-warning-text",
	},
	healthy: {
		selected: "border-success/60 bg-success-bg",
		box: "border-success bg-success",
		count: "text-success-text",
	},
	unknown: {
		selected: "border-border-strong bg-surface-raised",
		box: "border-border-strong bg-border-strong",
		count: "text-text-tertiary",
	},
};

export default function ReorderForecastPage() {
	const navigate = useNavigate();

	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");

	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(50);

	// Severity lives in the URL alongside `search` so a dispatcher can hand
	// someone "the critical list" as a link. Comma-separated; unknown values are
	// dropped rather than filtering everything out.
	const [searchParams, setSearchParams] = useSearchParams();
	const selectedSeverities = useMemo<ReorderSeverity[]>(() => {
		const raw = searchParams.get("health");
		if (!raw) return [];
		return raw
			.split(",")
			.filter((v): v is ReorderSeverity => SEVERITY_ORDER.includes(v as ReorderSeverity));
	}, [searchParams]);

	const toggleSeverity = (severity: ReorderSeverity) => {
		const next = selectedSeverities.includes(severity)
			? selectedSeverities.filter((s) => s !== severity)
			: [...selectedSeverities, severity];
		const params = new URLSearchParams(searchParams);
		if (next.length === 0) params.delete("health");
		// Written back in SEVERITY_ORDER, not click order, so the same filter
		// always produces the same URL.
		else params.set("health", SEVERITY_ORDER.filter((s) => next.includes(s)).join(","));
		setSearchParams(params, { replace: true });
	};

	const searchTerms = useMemo(() => {
		const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		return t.length ? t : undefined;
	}, [terms, searchInput]);

	// The health filter is pushed to the SERVER rather than applied to the fetched
	// page: a client-side pass would only narrow the page in hand, leaving the
	// pagination footer and the export both describing a different set than the
	// table. It composes because "reorder-forecast" has no loadPage — every
	// request already runs through the in-memory filterRows, whose `in` operator
	// lowercases and matches text columns, and `health` is exactly these labels.
	const conditions = useMemo(
		() =>
			selectedSeverities.length
				? [
						{
							id: "health",
							columnKey: "health",
							operator: "in" as const,
							value: selectedSeverities.map((s) => HEALTH_LABEL[s]).join(","),
							columnType: "text" as const,
						},
					]
				: undefined,
		[selectedSeverities],
	);

	const queryParams = useMemo<ReportFetchParams>(
		() => ({ searchTerms, conditions, page, limit: pageSize }),
		[searchTerms, conditions, page, pageSize],
	);

	const { data, isLoading, isFetching, error } = useReorderForecastQuery(queryParams);
	// The current page, already display-shaped by the server's forecastRow().
	const rows = useMemo(() => data?.rows ?? [], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	// The full, UNFILTERED set, shipped alongside every page. The tiles and the
	// chart are org-wide statements, so they can't be rebuilt from whichever page
	// happens to be on screen.
	const records = useMemo(() => (data?.summary?.chartRows ?? []) as ReorderForecastRow[], [data]);
	const truncated = data?.summary?.truncated === true;

	const filterKey = JSON.stringify([searchTerms, conditions, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	// Counts come from the unfiltered set: the strip is the org-wide picture and
	// the filter control at once, so filtering to "critical" must not zero out
	// the other three tiles and hide the way back.
	const severityCounts = useMemo(() => {
		const counts: Record<ReorderSeverity, number> = {
			critical: 0,
			warning: 0,
			healthy: 0,
			unknown: 0,
		};
		for (const r of records) counts[r.severity]++;
		return counts;
	}, [records]);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"reorder-forecast",
		COLS,
	);

	const clearAllFilters = () => {
		setSearchInput("");
		// Bare path — drops `search` and `health` together.
		navigate("/dispatch/inventory/reorder-forecast");
	};

	const hasActiveFilters = terms.length > 0 || selectedSeverities.length > 0;
	const showEmpty = total === 0 && !isLoading && !error;
	// Skip the whole block rather than framing an empty panel: with no plottable
	// rows and nothing at risk off-chart, the chart has nothing to say.
	const showChart = records.length > 0 && hasReorderChartContent(records);

	return (
		<div className="text-text-primary">
			<PageHeader title="Reorder Forecast" />

			{/* Every number on this page is an estimate off a fixed window, and the
			    window is not obvious from any column — so it's stated once, up top,
			    in the same words ReorderHealthCard uses. */}
			<p className="mb-3 text-sm text-text-muted">
				Estimated from consumption in the last {REORDER_FORECAST_WINDOW_DAYS} days. On
				hand counts warehouse + vehicle stock; the reorder point is a warehouse
				threshold.
			</p>

			{truncated && (
				<div className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-text">
					Showing the most urgent {records.length.toLocaleString()} items — the
					report row cap was reached, so this ranking is incomplete.
				</div>
			)}

			{/* Tall enough for a full page of RUNWAY_PAGE_SIZE bars plus the x-axis
			    band and the chart's footer — sizing a card so the axis band doesn't
			    fit is what produced the clipped footer. */}
			{showChart && (
				<div className="mb-4 h-[26rem]">
					<ReorderPriorityChart data={records} />
				</div>
			)}

			{/* Summary strip and severity filter in one control. Counts are of the
			    whole report, so filtering to one band never hides the others or
			    the way back to them. Sits below the chart, grouped with the search
			    and the table it filters — above the chart it read as a chart
			    control, which it isn't: the chart always plots the whole report. */}
			{records.length > 0 && (
				<div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
					{SEVERITY_ORDER.map((severity) => {
						const selected = selectedSeverities.includes(severity);
						const count = severityCounts[severity];
						const tile = SEVERITY_TILE[severity];
						// An empty band has nothing to filter to, so it isn't
						// offered — but it stays live while selected, or the
						// filter it set couldn't be cleared from the tile that
						// set it.
						const disabled = count === 0 && !selected;
						return (
							<button
								key={severity}
								type="button"
								disabled={disabled}
								aria-pressed={selected}
								onClick={() => toggleSeverity(severity)}
								// Same shell as every other report stat card
								// (StatCard, the timesheets strip) — this strip
								// is a stat strip first and a filter second.
								// py-3 px-4 is OverviewCard's padding, the other
								// two-line card in reporting; StatCard's p-4 is
								// sized for three.
								className={`rounded-lg border px-4 py-3 text-left transition-colors ${
									selected
										? tile.selected
										: disabled
											? "border-border-subtle bg-base cursor-not-allowed"
											: "border-border-subtle bg-base hover:border-border cursor-pointer"
								}`}
							>
								{/* Count and band name share a baseline so the tile
								    is two lines tall, not three: this strip sits
								    between a 26rem chart and the table, and four
								    numbers shouldn't cost that much of the fold. */}
								<div className="flex items-center justify-between gap-2">
									<span className="flex items-baseline gap-2 min-w-0">
										<span
											className={`text-xl font-bold tabular-nums ${
												count === 0
													? "text-text-faint"
													: tile.count
											}`}
										>
											{count.toLocaleString()}
										</span>
										<span className="truncate text-xs uppercase tracking-wide font-semibold text-text-muted">
											{HEALTH_LABEL[severity]}
										</span>
									</span>
									{/* Multi-select, so a checkbox and not a
									    radio or a lit border: two bands can be
									    on at once. */}
									<span
										aria-hidden="true"
										className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border transition-colors ${
											selected
												? tile.box
												: disabled
													? "border-border-subtle bg-surface"
													: "border-border bg-surface"
										}`}
									>
										{selected && (
											<Check
												size={10}
												className="text-white"
												strokeWidth={3}
											/>
										)}
									</span>
								</div>
								<p className="mt-0.5 text-xs text-text-muted">
									{SEVERITY_RULE[severity]}
								</p>
							</button>
						);
					})}
				</div>
			)}

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by item, SKU, or category..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				right={
					<>
						<ExportExcelButton
							onExport={() =>
								exportReportServer({
									report: "reorder-forecast",
									filename: datedFilename("reorder-forecast"),
									sheetName: "Reorder Forecast",
									columns: [...visibleColumns, ...EXPORT_ONLY_COLS],
									// The same filters the table is under: the
									// server regenerates the full filtered set
									// rather than exporting the visible page.
									params: { searchTerms, conditions },
								})
							}
							disabled={total === 0}
						/>
						<ColumnsButton columns={COLS} hidden={hidden} onToggle={toggle} onReset={reset} />
						<RefreshReportsButton />
					</>
				}
			/>

			<FilterChips
				filters={[
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
					// The strip above already shows the selection, but an active
					// filter that only lives in a tile's border state is easy to
					// carry off a page and forget. Every other filter on this
					// surface is removable from here.
					...selectedSeverities.map((severity) => ({
						label: `Health: ${HEALTH_LABEL[severity]}`,
						color: "blue" as const,
						onRemove: () => toggleSeverity(severity),
					})),
				]}
				resultCount={total}
				onClearAll={clearAllFilters}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<Package size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							{hasActiveFilters ? "No matching items" : "No active inventory items"}
						</h3>
						{/* Every active item gets a row whether or not it has usage — so
						    "no rows" means no active items, not "no consumption yet". */}
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Every active item is forecast here once one exists"}
						</p>
					</div>
				) : (
					<>
						<AdaptableTable
							data={rows}
							loadListener={isLoading}
							errListener={error}
							columnVisibility={columnVisibility}
							columnClamp={COLUMN_CLAMP}
							cellClass={{
								health: (row) => HEALTH_CELL_CLASS[row.health as string] ?? "",
							}}
							// Straight to the item's own History tab, not back to the list.
							onRowClick={(row) =>
								navigate(
									`/dispatch/inventory/items/${row.id as string}?tab=history`,
								)
							}
						/>
						<ReportPagination
							page={page}
							pageSize={pageSize}
							total={total}
							hasMore={hasMore}
							onPageChange={setPage}
							onPageSizeChange={setPageSize}
							isFetching={isFetching}
						/>
					</>
				)}
			</div>
		</div>
	);
}
