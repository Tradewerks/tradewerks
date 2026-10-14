import { useEffect, useMemo, useState } from "react";
import { DollarSign } from "lucide-react";
import { useNavigate } from "react-router-dom";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import AdaptableTable from "../../components/AdaptableTable";
import AgedReceivablesColumnChart from "../../components/reports/AgedReceivablesColumnChart";
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
import {
	useAgedReceivablesQuery,
	useAgedReceivablesByClientQuery,
} from "../../hooks/useReports";
import type { ReportFetchParams } from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "clientName", label: "Client" },
	{ key: "bucket0_30", label: "0-30 days" },
	{ key: "bucket31_60", label: "31-60 days" },
	{ key: "bucket61_90", label: "61-90 days" },
	{ key: "bucket90plus", label: "90+ days" },
	{ key: "disputed", label: "In Dispute" },
	{ key: "total", label: "Total" },
];

const AMOUNT_KEYS = [
	"bucket0_30",
	"bucket31_60",
	"bucket61_90",
	"bucket90plus",
	"disputed",
	"total",
] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, AMOUNT_KEYS);

type BucketSummary = Partial<Record<(typeof AMOUNT_KEYS)[number], number>>;

export default function AgedReceivablesPage() {
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

	const summaryChart = useAgedReceivablesQuery();
	const { data, isLoading, isFetching, error } = useAgedReceivablesByClientQuery(queryParams);
	const rows = useMemo(() => data?.rows ?? [], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const totals = useMemo(() => (data?.summary ?? {}) as BucketSummary, [data]);

	const filterKey = JSON.stringify([searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"aged-receivables",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				clientName: r.clientName,
				bucket0_30: formatCurrency(Number(r.bucket0_30)),
				bucket31_60: formatCurrency(Number(r.bucket31_60)),
				bucket61_90: formatCurrency(Number(r.bucket61_90)),
				bucket90plus: formatCurrency(Number(r.bucket90plus)),
				disputed: formatCurrency(Number(r.disputed)),
				total: formatCurrency(Number(r.total)),
			})),
		[rows],
	);

	const footerRow = useMemo(
		() => ({
			clientName: "Total",
			...Object.fromEntries(AMOUNT_KEYS.map((k) => [k, formatCurrency(totals[k] ?? 0)])),
		}),
		[totals],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0;
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Aged Receivables" />

			{summaryChart.data && (
				<div className="mb-4 h-72">
					<AgedReceivablesColumnChart data={summaryChart.data} />
				</div>
			)}

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
						<ExportExcelButton
							onExport={() =>
								exportReportServer({
									report: "aged-receivables-by-client",
									filename: datedFilename("aged-receivables"),
									sheetName: "Aged Receivables",
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
						<DollarSign size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No outstanding receivables
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Past-due invoice balances appear here once invoices go unpaid"}
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
							footerRow={footerRow}
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
