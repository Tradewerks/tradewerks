import { useMemo, useState } from "react";
import { HardHat, UserRound } from "lucide-react";
import { Link, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import AdaptableTable from "../../components/AdaptableTable";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import Dropdown from "../../components/ui/Dropdown";
import StatCard from "../../components/ui/StatCard";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import TechRevenueChart from "../../components/reports/TechRevenueChart";
import { NAV_BUTTON } from "../../components/technicians/detail/navButtons";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import { usePermission } from "../../hooks/usePermission";
import {
	buildHeaderLabels,
	useColumnVisibility,
	type ColumnOption,
} from "../../hooks/useColumnVisibility";
import {
	formatTriggerLabel,
	parseDateRangeFromParams,
	resolveDateRange,
} from "../../util/dateRangeUtils";
import { formatCurrency, formatDate } from "../../util/util";
import { useTechnicianScorecardQuery } from "../../hooks/useReports";
import { exportReport } from "../../api/reports";
import { datedFilename } from "../../util/download";
import type { SortDir } from "../../util/sortUtil";
import type { TechScorecardVisitRow } from "../../types/reports";

const BASE_PATH = "/dispatch/reporting/technician-scorecard";

const fmtHours = (h: number) => h.toFixed(1);

const SUMMARY_COLS: ColumnOption[] = [
	{ key: "technician", label: "Technician" },
	{ key: "visits", label: "Visits" },
	{ key: "jobs", label: "Jobs" },
	{ key: "hours", label: "Hours" },
	{ key: "revenue", label: "Revenue" },
	{ key: "revenuePerHour", label: "Revenue / Hr" },
	{ key: "onTimeRate", label: "On-time Rate" },
];

const DETAIL_COLS: ColumnOption[] = [
	{ key: "date", label: "Date" },
	{ key: "job", label: "Job" },
	{ key: "client", label: "Client" },
	{ key: "arrival", label: "Arrival" },
	{ key: "hours", label: "Hours" },
	{ key: "revenueShare", label: "Revenue Share" },
];

const SUMMARY_HEADER_LABELS = buildHeaderLabels(SUMMARY_COLS);
const DETAIL_HEADER_LABELS = buildHeaderLabels(DETAIL_COLS);

type SummarySortKey =
	| "technician"
	| "visits"
	| "jobs"
	| "hours"
	| "revenue"
	| "revenuePerHour"
	| "onTimeRate";

const SUMMARY_SORT_KEYS: readonly SummarySortKey[] = [
	"technician",
	"visits",
	"jobs",
	"hours",
	"revenue",
	"revenuePerHour",
	"onTimeRate",
];

const SUMMARY_SORTABLE = Object.fromEntries(SUMMARY_SORT_KEYS.map((k) => [k, true]));

const SUMMARY_ALIGN: Record<string, "left" | "right"> = {
	visits: "right",
	jobs: "right",
	hours: "right",
	revenue: "right",
	revenuePerHour: "right",
	onTimeRate: "right",
};

const ARRIVAL_PILL: Record<string, string> = {
	Early: "bg-info/10 text-info-text border-info/20",
	"On Time": "bg-success/10 text-success-text border-success/20",
	Late: "bg-error/10 text-error-text border-error/20",
};

interface TechRollup {
	techId: string;
	techName: string;
	visits: number;
	jobs: number;
	hours: number;
	revenue: number;
	timedRevenue: number;
	arrivalsTracked: number;
	arrivalsOnTime: number;
}

// Revenue per hour counts only visits that logged time: dividing all revenue by
// hours would credit untimed visits' revenue to someone else's hours.
const ratePerHour = (timedRevenue: number, hours: number) =>
	hours > 0 ? timedRevenue / hours : null;
const formatRate = (rate: number | null) => (rate === null ? "—" : formatCurrency(rate));

function rollupByTech(records: TechScorecardVisitRow[]): TechRollup[] {
	const map = new Map<string, TechRollup>();
	for (const r of records) {
		const cur = map.get(r.techId) ?? {
			techId: r.techId,
			techName: r.techName,
			visits: 0,
			jobs: 0,
			hours: 0,
			revenue: 0,
			timedRevenue: 0,
			arrivalsTracked: 0,
			arrivalsOnTime: 0,
		};
		cur.visits++;
		cur.hours += r.hoursWorked;
		cur.revenue += r.revenueShare;
		if (r.hoursWorked > 0) cur.timedRevenue += r.revenueShare;
		if (r.arrival) {
			cur.arrivalsTracked++;
			if (r.arrival !== "Late") cur.arrivalsOnTime++;
		}
		map.set(r.techId, cur);
	}
	const jobSets = new Map<string, Set<string>>();
	for (const r of records) {
		const set = jobSets.get(r.techId) ?? new Set<string>();
		set.add(r.jobId);
		jobSets.set(r.techId, set);
	}
	return [...map.values()].map((t) => ({ ...t, jobs: jobSets.get(t.techId)?.size ?? 0 }));
}

const onTimeLabel = (tracked: number, onTime: number) =>
	tracked > 0 ? `${Math.round((onTime / tracked) * 100)}%` : "—";

// Older links double-encoded the name (`encodeURIComponent` before URLSearchParams.set).
function decodeLegacyName(raw: string | null): string | null {
	if (!raw) return null;
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

export default function TechnicianScorecardPage() {
	const navigate = useNavigate();
	const location = useLocation();
	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, duplicateTerm } = useMultiSearch("search");
	const VIEW_TECHNICIANS = usePermission("view_technicians");
	const VIEW_JOBS = usePermission("view_jobs");
	const VIEW_VISITS = usePermission("view_visits");
	const canOpenVisits = VIEW_JOBS || VIEW_VISITS;

	const [searchParams] = useSearchParams();
	const dateRange = parseDateRangeFromParams(searchParams, "period");
	const resolved = resolveDateRange(dateRange);
	const startDate = resolved?.start.toISOString();
	const endDate = resolved?.end.toISOString();

	const { data, isLoading, error } = useTechnicianScorecardQuery(startDate, endDate);
	const records = useMemo(() => data ?? [], [data]);
	const rollups = useMemo(() => rollupByTech(records), [records]);

	// `techId` identifies; `tech` (name) survives only as a display fallback for a tech
	// with no visits in the period, and as the key for legacy name-only links.
	const techIdParam = searchParams.get("techId");
	const techNameParam = decodeLegacyName(searchParams.get("tech"));
	const selectedTechId =
		techIdParam ??
		(techNameParam ? (rollups.find((t) => t.techName === techNameParam)?.techId ?? null) : null);
	const selectedRollup = rollups.find((t) => t.techId === selectedTechId) ?? null;
	const selectedName = selectedRollup?.techName ?? techNameParam;
	const isSummaryView = selectedTechId === null && techNameParam === null;

	const techOptions = useMemo(() => {
		const opts = rollups
			.map((t) => ({ id: t.techId, name: t.techName }))
			.sort((a, b) => a.name.localeCompare(b.name));
		if (selectedTechId && !opts.some((o) => o.id === selectedTechId)) {
			opts.unshift({ id: selectedTechId, name: selectedName ?? "Selected technician" });
		}
		return opts;
	}, [rollups, selectedTechId, selectedName]);

	const sortParam = searchParams.get("sort");
	const sortKey: SummarySortKey = SUMMARY_SORT_KEYS.includes(sortParam as SummarySortKey)
		? (sortParam as SummarySortKey)
		: "revenue";
	const sortDir: SortDir = searchParams.get("dir") === "asc" ? "asc" : "desc";

	// ── Summary ──────────────────────────────────────────────────────────
	const { summaryRows, summaryStats, chartData } = useMemo(() => {
		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		const surviving = rollups.filter((t) =>
			activeTerms.every((term) => t.techName.toLowerCase().includes(term.toLowerCase())),
		);

		const metric = (t: TechRollup): number | string | null => {
			switch (sortKey) {
				case "technician":
					return t.techName;
				case "revenuePerHour":
					return ratePerHour(t.timedRevenue, t.hours);
				case "onTimeRate":
					return t.arrivalsTracked > 0 ? t.arrivalsOnTime / t.arrivalsTracked : null;
				default:
					return t[sortKey];
			}
		};
		// Techs with no measurable value sink to the bottom in either direction.
		const sorted = [...surviving].sort((a, b) => {
			const va = metric(a);
			const vb = metric(b);
			if (va === null || vb === null) return va === vb ? 0 : va === null ? 1 : -1;
			const cmp =
				typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
			return sortDir === "asc" ? cmp : -cmp;
		});

		const totalRevenue = surviving.reduce((s, t) => s + t.revenue, 0);
		const totalTimedRevenue = surviving.reduce((s, t) => s + t.timedRevenue, 0);
		const totalHours = surviving.reduce((s, t) => s + t.hours, 0);
		// Records are one row per technician per visit, so a two-tech visit appears twice;
		// team-level counts must dedupe by visit or they overstate volume.
		const survivingIds = new Set(surviving.map((t) => t.techId));
		const uniqueVisits = new Map<string, TechScorecardVisitRow["arrival"]>();
		for (const r of records) {
			if (survivingIds.has(r.techId)) uniqueVisits.set(r.visitId, r.arrival);
		}
		const totalVisits = uniqueVisits.size;
		const arrivals = [...uniqueVisits.values()].filter((a) => a !== null);
		const tracked = arrivals.length;
		const onTime = arrivals.filter((a) => a !== "Late").length;

		return {
			summaryRows: sorted.map((t) => ({
				id: t.techId,
				technician: t.techName,
				visits: t.visits,
				jobs: t.jobs,
				hours: fmtHours(t.hours),
				revenue: formatCurrency(t.revenue),
				revenuePerHour: formatRate(ratePerHour(t.timedRevenue, t.hours)),
				onTimeRate: onTimeLabel(t.arrivalsTracked, t.arrivalsOnTime),
			})),
			summaryStats: [
				{
					label: "Revenue",
					value: formatCurrency(totalRevenue),
					hint: `Across ${surviving.length} ${surviving.length === 1 ? "technician" : "technicians"}`,
				},
				{
					label: "Visits Completed",
					value: String(totalVisits),
					hint: "Shared visits count once",
				},
				{
					label: "Revenue / Hr",
					value: formatRate(ratePerHour(totalTimedRevenue, totalHours)),
					hint: `Across ${fmtHours(totalHours)} logged hours`,
				},
				{
					label: "On-time Rate",
					value: onTimeLabel(tracked, onTime),
					hint:
						tracked > 0
							? `${onTime} of ${tracked} ${tracked === 1 ? "arrival" : "arrivals"}`
							: "No arrivals recorded",
				},
			],
			chartData: surviving.map((t) => ({
				techId: t.techId,
				techName: t.techName,
				revenue: t.revenue,
				timedRevenue: t.timedRevenue,
				hours: t.hours,
				visits: t.visits,
			})),
		};
	}, [rollups, records, searchInput, terms, sortKey, sortDir]);

	// ── Detail ───────────────────────────────────────────────────────────
	const { detailRows, detailStats } = useMemo(() => {
		if (isSummaryView) return { detailRows: [], detailStats: [] };

		const activeTerms = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		const filtered = records
			.filter((r) => r.techId === selectedTechId)
			.filter((r) =>
				activeTerms.every((term) => {
					const t = term.toLowerCase();
					return (
						r.jobName.toLowerCase().includes(t) ||
						r.clientName.toLowerCase().includes(t) ||
						formatDate(r.scheduledStartAt).toLowerCase().includes(t)
					);
				}),
			)
			.sort(
				(a, b) =>
					new Date(b.scheduledStartAt).getTime() - new Date(a.scheduledStartAt).getTime(),
			);

		const revenue = filtered.reduce((s, r) => s + r.revenueShare, 0);
		const timedRevenue = filtered.reduce(
			(s, r) => s + (r.hoursWorked > 0 ? r.revenueShare : 0),
			0,
		);
		const hours = filtered.reduce((s, r) => s + r.hoursWorked, 0);
		const tracked = filtered.filter((r) => r.arrival).length;
		const onTime = filtered.filter((r) => r.arrival && r.arrival !== "Late").length;

		return {
			detailRows: filtered.map((r) => ({
				id: r.visitId,
				_jobId: r.jobId,
				date: formatDate(r.scheduledStartAt),
				job: r.jobName,
				client: r.clientName,
				arrival: r.arrival ?? "—",
				hours: fmtHours(r.hoursWorked),
				revenueShare: formatCurrency(r.revenueShare),
			})),
			detailStats: [
				{
					label: "Revenue",
					value: formatCurrency(revenue),
					hint: "Their share of each visit's total",
				},
				{
					label: "Hours Worked",
					value: fmtHours(hours),
					hint: `${filtered.length} ${filtered.length === 1 ? "visit" : "visits"}`,
				},
				{
					label: "Revenue / Hr",
					value: formatRate(ratePerHour(timedRevenue, hours)),
					hint:
						timedRevenue !== revenue
							? `Excludes ${formatCurrency(revenue - timedRevenue)} with no logged time`
							: undefined,
				},
				{
					label: "On-time Rate",
					value: onTimeLabel(tracked, onTime),
					hint:
						tracked > 0
							? `${onTime} of ${tracked} ${tracked === 1 ? "arrival" : "arrivals"}`
							: "No arrivals recorded",
				},
			],
		};
	}, [records, isSummaryView, selectedTechId, searchInput, terms]);

	const columnDefs = isSummaryView ? SUMMARY_COLS : DETAIL_COLS;
	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		`tech-scorecard:${isSummaryView ? "summary" : "detail"}`,
		columnDefs,
	);

	const headerLabels = isSummaryView ? SUMMARY_HEADER_LABELS : DETAIL_HEADER_LABELS;

	const selectTech = (techId: string | null) => {
		setSearchInput("");
		const next = new URLSearchParams(location.search);
		next.delete("search");
		next.delete("tech");
		next.delete("techId");
		next.delete("sort");
		next.delete("dir");
		if (techId) next.set("techId", techId);
		const qs = next.toString();
		navigate(`${BASE_PATH}${qs ? `?${qs}` : ""}`);
	};

	// Metrics open highest-first (a leaderboard); only the name column opens A→Z.
	const handleSortChange = (col: string) => {
		if (!SUMMARY_SORT_KEYS.includes(col as SummarySortKey)) return;
		const next = new URLSearchParams(location.search);
		if (col === sortKey) next.set("dir", sortDir === "asc" ? "desc" : "asc");
		else next.set("dir", col === "technician" ? "asc" : "desc");
		next.set("sort", col);
		navigate(`${BASE_PATH}?${next.toString()}`, { replace: true });
	};

	const clearAllFilters = () => {
		setSearchInput("");
		navigate(BASE_PATH);
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all";
	const rows = isSummaryView ? summaryRows : detailRows;
	const stats = isSummaryView ? summaryStats : detailStats;
	const showEmpty = rows.length === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			{/* Name and profile button sit on the title line, not under it: the
			    selected technician is the page's subject, and a lone muted line
			    below the title read as a caption. */}
			<div className="mb-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
				<h2 className="text-2xl font-semibold">Technician Scorecard</h2>
				{!isSummaryView && selectedName && (
					<>
						<span aria-hidden className="h-6 w-px bg-border" />
						<span className="min-w-0 truncate text-lg font-medium text-text-secondary">
							{selectedName}
						</span>
						{VIEW_TECHNICIANS && selectedTechId && (
							<Link
								to={`/dispatch/technicians/${selectedTechId}`}
								className={NAV_BUTTON}
							>
								<UserRound size={14} aria-hidden /> Open Profile
							</Link>
						)}
					</>
				)}
			</div>

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						key={isSummaryView ? "summary-search" : "detail-search"}
						paramKey="search"
						placeholder={
							isSummaryView
								? "Search by technician..."
								: "Search by job, client, or date..."
						}
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				middle={
					<div className="flex flex-wrap items-center gap-2">
						<div className="w-48">
							<Dropdown
								aria-label="Technician"
								value={selectedTechId ?? ""}
								onChange={(v) => selectTech(v || null)}
								entries={[
									<option key="all" value="">
										All technicians
									</option>,
									...techOptions.map((t) => (
										<option key={t.id} value={t.id}>
											{t.name}
										</option>
									)),
								]}
							/>
						</div>
						<DateRangeFilter paramKey="period" />
					</div>
				}
				right={
					<>
						<ExportExcelButton
							onExport={() =>
								exportReport({
									filename: datedFilename(
										isSummaryView
											? "technician-scorecard"
											: `technician-scorecard-${selectedName ?? "technician"}`,
									),
									sheetName: "Scorecard",
									columns: visibleColumns,
									rows,
								})
							}
							disabled={rows.length === 0}
						/>
						<ColumnsButton
							columns={columnDefs}
							hidden={hidden}
							onToggle={toggle}
							onReset={reset}
						/>
						<RefreshReportsButton />
					</>
				}
			/>

			<FilterChips
				filters={[
					!isSummaryView
						? {
								label: `Technician: ${selectedName ?? "Selected"}`,
								color: "blue" as const,
								onRemove: () => selectTech(null),
							}
						: null,
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
				]}
				resultCount={rows.length}
				onClearAll={clearAllFilters}
			/>

			{/* Filters sit above everything they filter: tiles, chart and table all follow them. */}
			<div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
				{stats.map((card) => (
					<StatCard key={card.label} {...card} />
				))}
			</div>

			{isSummaryView && !isLoading && !error && chartData.length > 0 && (
				<div className="mb-4">
					<TechRevenueChart
						data={chartData}
						periodLabel={
							dateRange.option === "all" ? "All time" : formatTriggerLabel(dateRange)
						}
						onSelectTech={selectTech}
					/>
				</div>
			)}

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<HardHat size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No completed visits found
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters || !isSummaryView
								? "Try adjusting your filters"
								: "Completed visits with assigned technicians appear here"}
						</p>
					</div>
				) : (
					<AdaptableTable
						data={rows}
						loadListener={isLoading}
						errListener={error}
						formatNums={false}
						columnVisibility={columnVisibility}
						headerLabels={headerLabels}
						columnAlign={isSummaryView ? SUMMARY_ALIGN : undefined}
						sortableColumns={isSummaryView ? SUMMARY_SORTABLE : undefined}
						sortKey={isSummaryView ? sortKey : undefined}
						sortDir={isSummaryView ? sortDir : undefined}
						onSortChange={isSummaryView ? handleSortChange : undefined}
						cellRenderers={
							isSummaryView
								? undefined
								: {
										arrival: (row) => {
											const value = row.arrival as string;
											const pill = ARRIVAL_PILL[value];
											if (!pill) return <span className="text-text-muted">{value}</span>;
											return (
												<span
													className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${pill}`}
												>
													{value}
												</span>
											);
										},
									}
						}
						onRowClick={
							isSummaryView
								? (row) => selectTech(row.id as string)
								: canOpenVisits
									? (row) =>
											navigate(
												`/dispatch/jobs/${row._jobId as string}/visits/${row.id as string}`,
											)
									: undefined
						}
					/>
				)}
			</div>
		</div>
	);
}
