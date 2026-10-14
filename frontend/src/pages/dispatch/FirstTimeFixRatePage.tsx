import { useEffect, useMemo, useState } from "react";
import { Filter } from "lucide-react";
import { useSearchParams } from "react-router-dom";
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
import FirstTimeFixChart from "../../components/reports/FirstTimeFixChart";
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
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import { useFirstTimeFixQuery } from "../../hooks/useReports";
import type { FirstTimeFixSummary, ReportFetchParams } from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "jobNumber", label: "Job #" },
	{ key: "name", label: "Name" },
	{ key: "clientName", label: "Client" },
	{ key: "completedAt", label: "Completed" },
	{ key: "visitCount", label: "Visits" },
	{ key: "firstTimeFix", label: "First-Time Fix" },
];

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, ["visitCount"]);

export default function FirstTimeFixRatePage() {
	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

	const [searchParams] = useSearchParams();
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

	const { data, isLoading, isFetching, error } = useFirstTimeFixQuery(queryParams);
	const rows = useMemo(() => data?.rows ?? [], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = data?.summary as FirstTimeFixSummary | undefined;

	const filterKey = JSON.stringify([startDate, endDate, searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const stats = useMemo(
		() => [
			{
				label: "First-Time Fix Rate",
				value: summary ? `${summary.ftfrPercent}%` : "—",
				hint: "of completed jobs",
			},
			{ label: "Completed Jobs", value: summary ? String(summary.completedJobs) : "—" },
			{ label: "First-Time Fixes", value: summary ? String(summary.firstTimeFix) : "—" },
			{ label: "Repeat-Visit Jobs", value: summary ? String(summary.repeatVisit) : "—" },
		],
		[summary],
	);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"first-time-fix",
		COLS,
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all";
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="First-Time Fix Rate" />

			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				{stats.map((card) => (
					<StatCard key={card.label} {...card} />
				))}
			</div>

			{summary && !isLoading && !error && (
				<div className="h-80 mb-4">
					<FirstTimeFixChart
						firstTimeFix={summary.firstTimeFix}
						repeatVisit={summary.repeatVisit}
					/>
				</div>
			)}

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by job, client, or number..."
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
									report: "first-time-fix",
									filename: datedFilename("first-time-fix"),
									sheetName: "First-Time Fix",
									columns: visibleColumns,
									params: { startDate, endDate, searchTerms },
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
						<Filter size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No completed jobs found
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Completed jobs appear here as visits wrap up"}
						</p>
					</div>
				) : (
					<>
						<AdaptableTable
							data={rows}
							loadListener={isLoading}
							errListener={error}
							formatNums={false}
							columnVisibility={columnVisibility}
							headerLabels={HEADER_LABELS}
							columnAlign={COLUMN_ALIGN}
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
