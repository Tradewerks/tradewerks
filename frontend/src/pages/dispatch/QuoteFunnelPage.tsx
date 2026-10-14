import { useEffect, useMemo, useState } from "react";
import { Filter } from "lucide-react";
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
import QuoteFunnelChart from "../../components/reports/QuoteFunnelChart";
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
import { useQuoteFunnelQuery } from "../../hooks/useReports";
import type { QuoteFunnelResponse, ReportFetchParams } from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "quoteNumber", label: "Quote #" },
	{ key: "title", label: "Title" },
	{ key: "clientName", label: "Client" },
	{ key: "status", label: "Status" },
	{ key: "source", label: "Source" },
	{ key: "total", label: "Total" },
	{ key: "createdAt", label: "Created" },
	{ key: "sentAt", label: "Sent" },
	{ key: "viewedAt", label: "Viewed" },
	{ key: "approvedAt", label: "Approved" },
	{ key: "daysToApprove", label: "Days to Approve" },
];

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, ["total", "daysToApprove"]);

type QuoteSummary = Pick<
	QuoteFunnelResponse,
	"funnel" | "winRate" | "avgDaysToApprove" | "valueWon" | "valueLost" | "bySource"
>;

export default function QuoteFunnelPage() {
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

	const { data, isLoading, isFetching, error } = useQuoteFunnelQuery(queryParams);
	const rows = useMemo(() => data?.rows ?? [], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = data?.summary as QuoteSummary | undefined;

	const filterKey = JSON.stringify([startDate, endDate, searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const stats = useMemo(
		() => [
			{
				label: "Win Rate",
				value: summary?.winRate != null ? `${summary.winRate}%` : "—",
				hint: "of completed quotes",
			},
			{
				label: "Avg Days to Approve",
				value: summary?.avgDaysToApprove != null ? String(summary.avgDaysToApprove) : "—",
			},
			{ label: "Value Won", value: formatCurrency(summary?.valueWon ?? 0) },
			{ label: "Value Lost", value: formatCurrency(summary?.valueLost ?? 0) },
		],
		[summary],
	);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"quote-funnel",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				quoteNumber: r.quoteNumber,
				title: r.title,
				clientName: r.clientName,
				status: r.status,
				source: r.source,
				total: formatCurrency(Number(r.total)),
				createdAt: r.createdAt,
				sentAt: r.sentAt,
				viewedAt: r.viewedAt,
				approvedAt: r.approvedAt,
				daysToApprove: typeof r.daysToApprove === "number" ? String(r.daysToApprove) : "—",
			})),
		[rows],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all";
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Quote Conversion" />

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
						<QuoteFunnelChart funnel={summary.funnel} />
					</div>
					<div className="h-80">
						<Card className="h-full" title="Conversion by Source">
							{summary.bySource.length === 0 ? (
								<div className="flex-1 min-h-0 flex items-center justify-center">
									<p className="text-sm text-text-muted">No quotes in this period</p>
								</div>
							) : (
								<div className="flex-1 min-h-0 overflow-y-auto">
									<table className="w-full text-sm">
										<thead>
											<tr className="text-text-tertiary font-semibold border-b border-border-subtle">
												<th className="text-left p-2">Source</th>
												<th className="text-right p-2">Quotes</th>
												<th className="text-right p-2">Approved</th>
												<th className="text-right p-2">Rate</th>
											</tr>
										</thead>
										<tbody>
											{summary.bySource.map((s) => (
												<tr key={s.source} className="border-t border-border-subtle">
													<td className="p-2 capitalize">{s.source}</td>
													<td className="p-2 text-right tabular-nums">{s.quotes}</td>
													<td className="p-2 text-right tabular-nums">{s.approved}</td>
													<td className="p-2 text-right tabular-nums">{s.rate}%</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							)}
						</Card>
					</div>
				</div>
			)}

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by quote, client, status, or source..."
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
									report: "quotes",
									filename: datedFilename("quote-funnel"),
									sheetName: "Quotes",
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
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No quotes found</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Quotes appear here as they move through the pipeline"}
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
