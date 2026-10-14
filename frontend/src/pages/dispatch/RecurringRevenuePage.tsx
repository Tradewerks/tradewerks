import { useEffect, useMemo, useState } from "react";
import { Repeat } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import AdaptableTable from "../../components/AdaptableTable";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import RecurringRevenueTrendChart from "../../components/reports/RecurringRevenueTrendChart";
import ReportPagination from "../../components/reports/ReportPagination";
import Card from "../../components/ui/Card";
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
import { useRecurringRevenueQuery } from "../../hooks/useReports";
import type {
	RecurringRevenueRow,
	RecurringRevenueSummary,
	ReportFetchParams,
} from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "name", label: "Plan" },
	{ key: "clientName", label: "Client" },
	{ key: "status", label: "Status" },
	{ key: "perPeriodAmount", label: "Per Period" },
	{ key: "nextInvoiceAt", label: "Next Invoice" },
	{ key: "lastInvoicedAt", label: "Last Invoiced" },
	{ key: "occCompleted", label: "Completed" },
	{ key: "occSkipped", label: "Skipped" },
	{ key: "monthlyValue", label: "MRR" },
];

const NUMERIC_KEYS = ["perPeriodAmount", "monthlyValue", "occCompleted", "occSkipped"] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

export default function RecurringRevenuePage() {
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

	const { data, isLoading, isFetching, error } = useRecurringRevenueQuery(queryParams);
	const rows = useMemo(() => (data?.rows ?? []) as unknown as RecurringRevenueRow[], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = data?.summary as RecurringRevenueSummary | undefined;

	const filterKey = JSON.stringify([startDate, endDate, searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const stats = useMemo(
		() => [
			{ label: "ARR", value: formatCurrency(summary?.arr ?? 0), hint: "Annual Recurring Revenue" },
			{ label: "MRR", value: formatCurrency(summary?.mrr ?? 0), hint: "Monthly Recurring Revenue" },
			{ label: "Active Plans", value: summary ? String(summary.activePlans) : "—" },
			{
				label: "Completion Rate",
				value: summary ? `${summary.completionRate}%` : "—",
				hint: "Occurrences Completed",
			},
		],
		[summary],
	);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"recurring-revenue",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				name: r.name,
				clientName: r.clientName,
				status: r.status,
				perPeriodAmount:
					typeof r.perPeriodAmount === "number"
						? formatCurrency(r.perPeriodAmount)
						: "—",
				nextInvoiceAt: r.nextInvoiceAt,
				lastInvoicedAt: r.lastInvoicedAt,
				occCompleted: r.occCompleted,
				occSkipped: r.occSkipped,
				monthlyValue: formatCurrency(Number(r.monthlyValue)),
			})),
		[rows],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all";
	const showEmpty = total === 0 && !isLoading && !error;

	const healthRows = summary
		? [
				{ label: "Completion Rate", value: `${summary.completionRate}%` },
				{ label: "Skip Rate", value: `${summary.skipRate}%` },
				{ label: "Active / Paused", value: `${summary.activePlans} / ${summary.pausedPlans}` },
				{ label: "New (30d)", value: String(summary.newPlans) },
				{
					label: "Churned",
					value: `${summary.churnedPlans} · ${formatCurrency(summary.churnedMrr)} MRR`,
				},
			]
		: [];

	return (
		<div className="text-text-primary">
			<PageHeader title="Recurring Revenue" />

			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				{stats.map((card) => (
					<div key={card.label} className="p-4 bg-base border border-border-subtle rounded-lg">
						<p className="text-xs text-text-muted uppercase tracking-wide font-semibold mb-1">
							{card.label}
						</p>
						<p className="text-xl font-bold text-text-primary tabular-nums">{card.value}</p>
						{"hint" in card && card.hint && (
							<p className="text-xs text-text-muted mt-0.5">{card.hint}</p>
						)}
					</div>
				))}
			</div>

			{summary && !isLoading && !error && (
				<div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
					<div className="h-80">
						<RecurringRevenueTrendChart data={summary.trend} />
					</div>
					<div className="h-80">
						<Card className="h-full" title="Plan Health">
							<div className="flex-1 min-h-0 overflow-y-auto">
								<table className="w-full text-sm">
									<tbody>
										{healthRows.map((h) => (
											<tr key={h.label} className="border-t border-border-subtle first:border-t-0">
												<td className="p-2 text-text-tertiary">{h.label}</td>
												<td className="p-2 text-right tabular-nums text-text-primary">{h.value}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</Card>
					</div>
				</div>
			)}

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by plan or client..."
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
									report: "recurring-revenue",
									filename: datedFilename("recurring-revenue"),
									sheetName: "Recurring Revenue",
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
						<Repeat size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No recurring plans</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Recurring plans and their monthly value appear here"}
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
