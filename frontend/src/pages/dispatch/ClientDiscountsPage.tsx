import { useEffect, useMemo, useState } from "react";
import { BadgePercent } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
import { useClientDiscountsQuery } from "../../hooks/useReports";
import type {
	ClientDiscountRow,
	ClientDiscountSummary,
	ReportFetchParams,
} from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "clientName", label: "Client" },
	{ key: "invoiceCount", label: "Discounted Invoices" },
	{ key: "totalBilled", label: "Total Billed" },
	{ key: "avgDiscount", label: "Avg Discount" },
	{ key: "discountRate", label: "Discount Rate" },
	{ key: "totalDiscount", label: "Total Discount" },
];

const NUMERIC_KEYS = [
	"invoiceCount",
	"totalBilled",
	"totalDiscount",
	"discountRate",
	"avgDiscount",
] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

export default function ClientDiscountsPage() {
	const navigate = useNavigate();
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

	const { data, isLoading, isFetching, error } = useClientDiscountsQuery(queryParams);
	const rows = useMemo(() => (data?.rows ?? []) as unknown as ClientDiscountRow[], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = data?.summary as ClientDiscountSummary | undefined;

	const filterKey = JSON.stringify([searchTerms, startDate, endDate, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const stats = useMemo(
		() => [
			{
				label: "Total Discount",
				value: summary ? formatCurrency(summary.totalDiscount) : "—",
			},
			{
				label: "Total Billed",
				value: summary ? formatCurrency(summary.totalBilled) : "—",
			},
			{
				label: "Avg Discount Rate",
				value: summary ? `${summary.avgDiscountRate}%` : "—",
			},
			{ label: "Clients", value: summary ? String(summary.clientCount) : "—" },
		],
		[summary],
	);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"client-discounts",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				clientName: r.clientName,
				invoiceCount: r.invoiceCount,
				totalBilled: formatCurrency(Number(r.totalBilled)),
				avgDiscount: formatCurrency(Number(r.avgDiscount)),
				discountRate: `${r.discountRate}%`,
				totalDiscount: formatCurrency(Number(r.totalDiscount)),
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
			<PageHeader title="Client Discounts" />

			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				{stats.map((card) => (
					<StatCard key={card.label} {...card} />
				))}
			</div>

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by client..."
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
									report: "client-discounts",
									filename: datedFilename("client-discounts"),
									sheetName: "Client Discounts",
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
						<BadgePercent size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No discounts recorded</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Discounts applied to created invoices appear here"}
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
							onRowClick={(row) => navigate(`/dispatch/clients/${row.id as string}`)}
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
