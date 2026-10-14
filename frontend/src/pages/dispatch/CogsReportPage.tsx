import { useEffect, useMemo, useState } from "react";
import { Filter, PackageSearch } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
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
import { useCogsByJobReportQuery, useCogsByItemReportQuery } from "../../hooks/useReports";
import type { CogsTrendPoint, ReportFetchParams } from "../../types/reports";
import CogsTrendChart from "../../components/reports/CogsTrendChart";

type CogsView = "job" | "item";

const JOB_COLS: ColumnOption[] = [
	{ key: "jobNumber", label: "Job #" },
	{ key: "name", label: "Name" },
	{ key: "clientName", label: "Client" },
	{ key: "status", label: "Status" },
	{ key: "totalCogs", label: "Total COGS" },
	{ key: "costCoverage", label: "Cost Coverage" },
	{ key: "itemCount", label: "Distinct Items" },
	{ key: "qtyConsumed", label: "Qty Consumed" },
	{ key: "lastConsumedAt", label: "Last Consumed" },
];

const ITEM_COLS: ColumnOption[] = [
	{ key: "itemName", label: "Name" },
	{ key: "sku", label: "SKU" },
	{ key: "category", label: "Category" },
	{ key: "unit", label: "Unit" },
	{ key: "totalCogs", label: "Total COGS" },
	{ key: "avgUnitCost", label: "Avg Unit Cost" },
	{ key: "costCoverage", label: "Cost Coverage" },
	{ key: "qtyConsumed", label: "Qty Consumed" },
	{ key: "jobCount", label: "Jobs" },
	{ key: "lastConsumedAt", label: "Last Consumed" },
];

const JOB_HEADER_LABELS = buildHeaderLabels(JOB_COLS);
const JOB_COLUMN_ALIGN = buildColumnAlign(JOB_COLS, ["totalCogs", "itemCount", "qtyConsumed"]);
const ITEM_HEADER_LABELS = buildHeaderLabels(ITEM_COLS);
const ITEM_COLUMN_ALIGN = buildColumnAlign(ITEM_COLS, [
	"totalCogs",
	"avgUnitCost",
	"qtyConsumed",
	"jobCount",
]);

interface CogsSummary {
	totalCogs?: number;
	jobCount?: number;
	jobsMissingCostData?: number;
	itemCount?: number;
	itemsMissingCostData?: number;
	trend?: CogsTrendPoint[];
}

const currencyOrDash = (v: unknown) => (typeof v === "number" ? formatCurrency(v) : "—");

const MISSING_COST_CONDITION = {
	id: "missing-cost-coverage",
	columnKey: "costCoverage",
	operator: "in" as const,
	value: "Estimated,Partial,No Cost Data",
};

export default function CogsReportPage() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const view: CogsView = searchParams.get("view") === "item" ? "item" : "job";
	const missingOnly = searchParams.get("cost") === "missing";

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
		() => ({
			startDate,
			endDate,
			searchTerms,
			page,
			limit: pageSize,
			conditions: missingOnly ? [MISSING_COST_CONDITION] : undefined,
		}),
		[startDate, endDate, searchTerms, page, pageSize, missingOnly],
	);

	const jobQuery = useCogsByJobReportQuery(queryParams, view === "job");
	const itemQuery = useCogsByItemReportQuery(queryParams, view === "item");
	const { data, isLoading, isFetching, error } = view === "job" ? jobQuery : itemQuery;

	const rows = useMemo(() => data?.rows ?? [], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = useMemo(() => (data?.summary ?? {}) as CogsSummary, [data]);

	const filterKey = JSON.stringify([view, missingOnly, startDate, endDate, searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const setView = (next: CogsView) => {
		const params = new URLSearchParams(searchParams);
		if (next === "job") params.delete("view");
		else params.set("view", next);
		setSearchParams(params, { replace: true });
	};

	const toggleMissingOnly = () => {
		const params = new URLSearchParams(searchParams);
		if (missingOnly) params.delete("cost");
		else params.set("cost", "missing");
		setSearchParams(params, { replace: true });
	};

	const stats = useMemo(() => {
		if (view === "job") {
			return [
				{ label: "Total COGS", value: currencyOrDash(summary.totalCogs) },
				{ label: "Jobs", value: String(summary.jobCount ?? 0) },
				{ label: "Missing Full Cost Data", value: String(summary.jobsMissingCostData ?? 0) },
			];
		}
		return [
			{ label: "Total COGS", value: currencyOrDash(summary.totalCogs) },
			{ label: "Items", value: String(summary.itemCount ?? 0) },
			{ label: "Missing Full Cost Data", value: String(summary.itemsMissingCostData ?? 0) },
		];
	}, [view, summary]);

	const cols = view === "job" ? JOB_COLS : ITEM_COLS;
	const headerLabels = view === "job" ? JOB_HEADER_LABELS : ITEM_HEADER_LABELS;
	const columnAlign = view === "job" ? JOB_COLUMN_ALIGN : ITEM_COLUMN_ALIGN;

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		`cogs-report-${view}`,
		cols,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => {
				const row = { ...r, totalCogs: currencyOrDash(r.totalCogs) };
				if ("avgUnitCost" in row) row.avgUnitCost = currencyOrDash(row.avgUnitCost);
				return row;
			}),
		[rows],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
		if (missingOnly) toggleMissingOnly();
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all" || missingOnly;
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Cost of Goods Sold" />

			<div className="flex items-center gap-1 mb-4 w-fit rounded-md border border-border p-0.5">
				<button
					onClick={() => setView("job")}
					aria-pressed={view === "job"}
					className={`h-8 px-3 rounded text-sm font-medium transition-colors ${
						view === "job"
							? "bg-primary-bg text-primary-text"
							: "text-text-tertiary hover:text-text-primary"
					}`}
				>
					By Job
				</button>
				<button
					onClick={() => setView("item")}
					aria-pressed={view === "item"}
					className={`h-8 px-3 rounded text-sm font-medium transition-colors ${
						view === "item"
							? "bg-primary-bg text-primary-text"
							: "text-text-tertiary hover:text-text-primary"
					}`}
				>
					By Item
				</button>
			</div>

			<div className="grid grid-cols-3 gap-3 mb-4">
				{stats.map((card) => {
					const isMissingCard = card.label === "Missing Full Cost Data";
					const Wrapper = isMissingCard ? "button" : "div";
					return (
						<Wrapper
							key={card.label}
							{...(isMissingCard
								? { onClick: toggleMissingOnly, "aria-pressed": missingOnly, type: "button" as const }
								: {})}
							className={`p-4 bg-base border rounded-lg text-left transition-colors ${
								isMissingCard && missingOnly
									? "border-primary bg-primary-bg"
									: "border-border-subtle"
							} ${isMissingCard ? "hover:bg-surface cursor-pointer" : ""}`}
						>
							<p className="flex items-center gap-1 text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
								{card.label}
								{isMissingCard && (
									<Filter
										size={12}
										className={missingOnly ? "text-primary-text" : "text-text-faint"}
									/>
								)}
							</p>
							<p className="text-xl font-bold text-text-primary tabular-nums">{card.value}</p>
						</Wrapper>
					);
				})}
			</div>
			{!isLoading && !error && (summary.trend?.length ?? 0) > 0 && (
				<div className="h-80 mb-4">
						<CogsTrendChart trend={summary.trend ?? []} />
				</div>
			)}
			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder={view === "job" ? "Search by job or client..." : "Search by item or SKU..."}
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
									report: view === "job" ? "cogs-by-job" : "cogs-by-item",
									filename: datedFilename(view === "job" ? "cogs-by-job" : "cogs-by-item"),
									sheetName: view === "job" ? "COGS by Job" : "COGS by Item",
									columns: visibleColumns,
									params: { startDate, endDate, searchTerms, conditions: queryParams.conditions },
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
				filters={[
					...terms.map((term) => ({
						label: `Search: "${term}"`,
						color: "purple" as const,
						onRemove: () => removeTerm(term),
						highlighted: duplicateTerm === term,
					})),
					missingOnly
						? {
								label: "Missing full cost data",
								color: "orange" as const,
								onRemove: toggleMissingOnly,
							}
						: null,
				]}
				resultCount={total}
				onClearAll={clearAllFilters}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<PackageSearch size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No {view === "job" ? "jobs" : "items"} found
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Inventory cost consumed against jobs appears here"}
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
							onRowClick={(row) =>
								navigate(
									view === "job"
										? `/dispatch/jobs/${row.id as string}`
										: `/dispatch/inventory/items/${row.id as string}`,
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
