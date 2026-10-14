import { useEffect, useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import StatCard from "../../components/ui/StatCard";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import AdaptableTable from "../../components/AdaptableTable";
import ReportPagination from "../../components/reports/ReportPagination";
import FieldAddedRevenueTrendChart from "../../components/reports/FieldAddedRevenueTrendChart";
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
import { useFieldAddedRevenueQuery } from "../../hooks/useReports";
import type {
	FieldAddedRevenueRow,
	FieldAddedRevenueSummary,
	ReportFetchParams,
} from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "technician", label: "Technician" },
	{ key: "itemCount", label: "Field-Added Items" },
	{ key: "jobCount", label: "Jobs w/ Upsell" },
	{ key: "avgPerItem", label: "Avg per Item" },
	{ key: "fieldAddedRevenue", label: "Field-Added Revenue" },
];

const NUMERIC_KEYS = ["itemCount", "jobCount", "avgPerItem", "fieldAddedRevenue"] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

export default function FieldAddedRevenuePage() {
	const [searchParams] = useSearchParams();
	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(50);

	const dateRange = parseDateRangeFromParams(searchParams, "period");
	const resolved = resolveDateRange(dateRange);
	const startDate = resolved?.start.toISOString();
	const endDate = resolved?.end.toISOString();

	const searchTerms = useMemo(() => {
		const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		return t.length ? t : undefined;
	}, [terms, searchInput]);

	const queryParams = useMemo<ReportFetchParams>(
		() => ({ searchTerms, startDate, endDate, page, limit: pageSize }),
		[searchTerms, startDate, endDate, page, pageSize],
	);

	const { data, isLoading, isFetching, error } = useFieldAddedRevenueQuery(queryParams);
	const rows = useMemo(() => (data?.rows ?? []) as unknown as FieldAddedRevenueRow[], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = data?.summary as FieldAddedRevenueSummary | undefined;

	const filterKey = JSON.stringify([searchTerms, startDate, endDate, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const stats = useMemo(
		() => [
			{
				label: "Field-Added Revenue",
				value: summary ? formatCurrency(summary.totalFieldAddedRevenue) : "—",
			},
			{ label: "Field-Added Items", value: summary ? String(summary.fieldAddedItems) : "—" },
			{ label: "Top Technician", value: summary ? summary.topTechnician : "—" },
		],
		[summary],
	);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"field-added-revenue",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				technician: r.technician,
				itemCount: r.itemCount,
				jobCount: r.jobCount,
				avgPerItem: formatCurrency(Number(r.avgPerItem)),
				fieldAddedRevenue: formatCurrency(Number(r.fieldAddedRevenue)),
			})),
		[rows],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0;
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Field-Added Revenue" />

			<div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
				{stats.map((card) => (
					<StatCard key={card.label} {...card} />
				))}
			</div>

			{summary?.truncated && (
				<div className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-text">
					Only the newest field-added items were counted — the report row cap was
					reached, so these totals are partial. Narrow the date range for a complete
					picture.
				</div>
			)}

			{!isLoading && !error && (summary?.trend?.points.length ?? 0) > 0 && (
				<div className="h-80 mb-4">
					<FieldAddedRevenueTrendChart
						trend={summary?.trend ?? { techs: [], points: [] }}
					/>
				</div>
			)}

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by technician..."
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
									report: "field-added-revenue",
									filename: datedFilename("field-added-revenue"),
									sheetName: "Field-Added Revenue",
									columns: visibleColumns,
									params: { searchTerms, startDate, endDate },
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
						<TrendingUp size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No field-added revenue</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Line items technicians add on visits appear here"}
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
