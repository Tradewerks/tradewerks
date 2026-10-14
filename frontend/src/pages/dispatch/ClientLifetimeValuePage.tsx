import { useEffect, useMemo, useState } from "react";
import { TrendingUp } from "lucide-react";
import { useNavigate } from "react-router-dom";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import StatCard from "../../components/ui/StatCard";
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
import { useClientLifetimeValueQuery } from "../../hooks/useReports";
import type {
	ClientLifetimeValueRow,
	ClientLifetimeValueSummary,
	ReportFetchParams,
} from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "name", label: "Client" },
	{ key: "primaryContact", label: "Primary Contact" },
	{ key: "firstPurchaseAt", label: "First Invoice" },
	{ key: "tenureMonths", label: "Client Age (mo)" },
	{ key: "jobCount", label: "Jobs" },
	{ key: "invoiceCount", label: "Invoices" },
	{ key: "avgInvoiceValue", label: "Avg Invoice" },
	{ key: "lifetimeRevenue", label: "Lifetime Revenue" },
];

const NUMERIC_KEYS = [
	"tenureMonths",
	"jobCount",
	"invoiceCount",
	"lifetimeRevenue",
	"avgInvoiceValue",
] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

export default function ClientLifetimeValuePage() {
	const navigate = useNavigate();
	const [searchInput, setSearchInput] = useState("");
	const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

	const [page, setPage] = useState(0);
	const [pageSize, setPageSize] = useState(50);

	const searchTerms = useMemo(() => {
		const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
		return t.length ? t : undefined;
	}, [terms, searchInput]);

	const queryParams = useMemo<ReportFetchParams>(
		() => ({ searchTerms, page, limit: pageSize }),
		[searchTerms, page, pageSize],
	);

	const { data, isLoading, isFetching, error } = useClientLifetimeValueQuery(queryParams);
	const rows = useMemo(() => (data?.rows ?? []) as unknown as ClientLifetimeValueRow[], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = data?.summary as ClientLifetimeValueSummary | undefined;

	const filterKey = JSON.stringify([searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const stats = useMemo(
		() => [
			{
				label: "Total Lifetime Revenue",
				value: summary ? formatCurrency(summary.totalLifetimeRevenue) : "—",
			},
			{ label: "Average Client Value", value: summary ? formatCurrency(summary.avgClv) : "—" },
			{ label: "Clients", value: summary ? String(summary.clientCount) : "—" },
		],
		[summary],
	);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"client-ltv",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				name: r.name,
				primaryContact: r.primaryContact,
				firstPurchaseAt: r.firstPurchaseAt,
				tenureMonths: r.tenureMonths,
				jobCount: r.jobCount,
				invoiceCount: r.invoiceCount,
				avgInvoiceValue: formatCurrency(Number(r.avgInvoiceValue)),
				lifetimeRevenue: formatCurrency(Number(r.lifetimeRevenue)),
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
			<PageHeader title="Client Lifetime Value" />

			<div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
				{stats.map((card) => (
					<StatCard key={card.label} {...card} />
				))}
			</div>

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by client or contact..."
						onValueChange={setSearchInput}
						onSubmit={addTerm}
					/>
				}
				right={
					<>
						<ExportExcelButton
							onExport={() =>
								exportReportServer({
									report: "client-lifetime-value",
									filename: datedFilename("client-lifetime-value"),
									sheetName: "Client Lifetime Value",
									columns: visibleColumns,
									params: { searchTerms },
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
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No client revenue yet</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "No active client has a recorded payment yet"}
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
