import { useEffect, useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import StatCard from "../../components/ui/StatCard";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import AdaptableTable from "../../components/AdaptableTable";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import ReportPagination from "../../components/reports/ReportPagination";
import { exportReportServer } from "../../api/reports";
import { datedFilename } from "../../util/download";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import {
	buildColumnAlign,
	buildHeaderLabels,
	useColumnVisibility,
	type ColumnOption,
} from "../../hooks/useColumnVisibility";
import { formatCurrency } from "../../util/util";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import { useJobProfitabilityReportQuery } from "../../hooks/useReports";
import type { ReportFetchParams } from "../../types/reports";

type ProfitView = "Gross" | "Net";

const GROSS_COLS: ColumnOption[] = [
	{ key: "jobNumber", label: "Job #" },
	{ key: "jobName", label: "Name" },
	{ key: "clientName", label: "Client" },
	{ key: "revenue", label: "Revenue" },
	{ key: "cogs", label: "Material COGS" },
	{ key: "profit", label: "Profit" },
	{ key: "margin", label: "Margin" },
];

const NET_COLS: ColumnOption[] = [
	{ key: "jobNumber", label: "Job #" },
	{ key: "jobName", label: "Name" },
	{ key: "clientName", label: "Client" },
	{ key: "revenue", label: "Revenue" },
	{ key: "cogs", label: "Materials" },
	{ key: "laborCost", label: "Labor" },
	{ key: "travelCost", label: "Travel" },
	{ key: "overheadCost", label: "Overhead" },
	{ key: "profit", label: "Profit" },
	{ key: "margin", label: "Margin" },
];

const GROSS_NUMERIC_KEYS = ["revenue", "cogs", "profit", "margin"] as const;
const NET_NUMERIC_KEYS = [
	"revenue",
	"cogs",
	"laborCost",
	"travelCost",
	"overheadCost",
	"profit",
	"margin",
] as const;

const VIEW_CONFIG = {
	Gross: {
		cols: GROSS_COLS,
		headerLabels: buildHeaderLabels(GROSS_COLS),
		columnAlign: buildColumnAlign(GROSS_COLS, GROSS_NUMERIC_KEYS),
	},
	Net: {
		cols: NET_COLS,
		headerLabels: buildHeaderLabels(NET_COLS),
		columnAlign: buildColumnAlign(NET_COLS, NET_NUMERIC_KEYS),
	},
} as const satisfies Record<ProfitView, unknown>;

interface JobProfitabilityRow {
	jobId: string;
	jobNumber: string | number | null;
	jobName: string | null;
	clientName: string | null;
	revenue: number | null;
	cogs: number | null;
	profit: number | null;
	margin: number | null;
	// Net mode only 
	laborCost?: number | null;
	travelCost?: number | null;
	overheadCost?: number | null;
}

interface ProfitSummary {
	totalProfit?: number;
	jobCount?: number;
	// Set when any of the backend's three caps was hit — consumption events,
	// invoices scanned, or report rows. Event truncation understates material
	// cost and so overstates profit, which is the case worth warning about.
	truncated?: boolean;
}

const currencyOrDash = (v: unknown) => (typeof v === "number" ? formatCurrency(v) : "—");
const percentOrDash = (v: unknown) => (typeof v === "number" ? `${v}%` : "—");

export default function JobProfitabilityPage() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const view: ProfitView = searchParams.get("view") === "Net" ? "Net" : "Gross";

	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

	const dateRange = parseDateRangeFromParams(searchParams, "period");
	const resolved = resolveDateRange(dateRange);
	const startDate = resolved?.start.toISOString();
	const endDate = resolved?.end.toISOString();

	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(50);

	const searchTerms = useMemo(() => {
		const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		return t.length ? t : undefined;
	}, [terms, searchInput]);

	const queryParams = useMemo<ReportFetchParams>(
		() => ({ startDate, endDate, searchTerms, page, limit: pageSize }),
		[startDate, endDate, searchTerms, page, pageSize],
	);

	const { data, isLoading, isFetching, error } = useJobProfitabilityReportQuery(queryParams);

	const rows = useMemo(() => (data?.rows ?? []) as unknown as JobProfitabilityRow[], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = useMemo(() => (data?.summary ?? {}) as ProfitSummary, [data]);

	const filterKey = JSON.stringify([view, startDate, endDate, searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const setView = (next: ProfitView) => {
		const params = new URLSearchParams(searchParams);
		if (next === "Gross") params.delete("view");
		else params.set("view", next);
		setSearchParams(params, { replace: true });
	};

	const stats = useMemo(
		() => [
			{
				label: "Total Profit",
				value: currencyOrDash(summary.totalProfit),
				hint: "Revenue less consumed material cost — labor is not costed",
			},
			{ label: "Jobs", value: String(summary.jobCount ?? 0) },
		],
		[summary],
	);

	const { cols, headerLabels, columnAlign } = VIEW_CONFIG[view];

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		`job-profitability-${view}`,
		cols,
	);

	const displayRows = useMemo(
		() =>
			view === "Gross"
				? rows.map((r) => ({
                    id: r.jobId,
                    jobNumber: r.jobNumber ?? "—",
                    jobName: r.jobName ?? "—",
                    clientName: r.clientName ?? "—",
                    revenue: currencyOrDash(r.revenue),
                    cogs: currencyOrDash(r.cogs),
                    profit: currencyOrDash(r.profit),
                    margin: percentOrDash(r.margin),
                }))
				: rows.map((r) => ({
                    id: r.jobId,
                    jobNumber: r.jobNumber ?? "—",
                    jobName: r.jobName ?? "—",
                    clientName: r.clientName ?? "—",
                    revenue: currencyOrDash(r.revenue),
                    cogs: currencyOrDash(r.cogs),
                    laborCost: currencyOrDash(r.laborCost),
                    travelCost: currencyOrDash(r.travelCost),
                    overheadCost: currencyOrDash(r.overheadCost),
                    profit: currencyOrDash(r.profit),
                    margin: percentOrDash(r.margin),
                    _netRaw: r.profit,
                })),
		[rows, view],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all";
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Job Profitability" />

			<div className="flex items-center gap-1 mb-4 w-fit rounded-md border border-border p-0.5">
				<button
					onClick={() => setView("Gross")}
					aria-pressed={view === "Gross"}
					className={`h-8 px-3 rounded text-sm font-medium transition-colors ${
						view === "Gross"
							? "bg-primary-bg text-primary-text"
							: "text-text-tertiary hover:text-text-primary"
					}`}
				>
					Gross Profit
				</button>
				<button
					onClick={() => setView("Net")}
					aria-pressed={view === "Net"}
					className={`h-8 px-3 rounded text-sm font-medium transition-colors ${
						view === "Net"
							? "bg-primary-bg text-primary-text"
							: "text-text-tertiary hover:text-text-primary"
					}`}
				>
					Net Profit
				</button>
			</div>

			{summary.truncated && (
				<div
					role="status"
					className="mb-4 rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-text"
				>
					This report hit an internal size limit, so these figures are incomplete —
					profit is likely overstated. Narrow the date range for accurate numbers.
				</div>
			)}

			<div className="grid grid-cols-2 gap-3 mb-4">
				{stats.map((card) => (
					<StatCard key={card.label} {...card} />
				))}
			</div>

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by job or client..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				right={
					<>
						<DateRangeFilter paramKey="period" />
						<ExportExcelButton
							onExport={() =>
								exportReportServer({
									report: "job-profitability",
									filename: datedFilename("job-profitability"),
									sheetName: "Job Profitability",
									columns: visibleColumns,
									params: { startDate, endDate, searchTerms },
								})
							}
							disabled={total === 0}
						/>
						<ColumnsButton columns={cols} hidden={hidden} onToggle={toggle} onReset={reset} />
						<RefreshReportsButton />
					</>
				}
			/>

			<FilterChips
				filters={terms.map((term) => ({
					label: `Search: "${term}"`,
					color: "purple" as const,
					onRemove: () => removeTerm(term),
					highlighted: duplicateTerm === term,
				}))}
				resultCount={total}
				onClearAll={clearAllFilters}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<TrendingUp size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No jobs found</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Jobs with billed revenue appear here"}
						</p>
					</div>
				) : (
					<>
						<AdaptableTable
							data={displayRows}
							loadListener={isLoading}
							errListener={error}
							formatNums={false}
							columnVisibility={columnVisibility}
							headerLabels={headerLabels}
							columnAlign={columnAlign}
							onRowClick={(row) => navigate(`/dispatch/jobs/${row.id as string}`)}
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
