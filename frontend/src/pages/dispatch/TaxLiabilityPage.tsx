import { useEffect, useMemo, useState } from "react";
import { Receipt } from "lucide-react";
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
import { formatRatePercentLabel } from "../../lib/formatTax";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import { useTaxLiabilityReportQuery } from "../../hooks/useReports";
import type { ReportFetchParams } from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "jurisdiction", label: "Jurisdiction" },
	{ key: "rateName", label: "Rate" },
	{ key: "rate", label: "Rate %" },
	{ key: "taxableBase", label: "Taxable Base" },
	{ key: "taxCollected", label: "Tax Collected" },
	{ key: "invoiceCount", label: "Invoices" },
];

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, ["rate", "taxableBase", "taxCollected", "invoiceCount"]);

interface TaxSummary {
	taxableBase?: number;
	taxCollected?: number;
	invoiceCount?: number;
}

export default function TaxLiabilityPage() {
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

	const { data, isLoading, isFetching, error } = useTaxLiabilityReportQuery(queryParams);
	const rows = useMemo(() => data?.rows ?? [], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	const summary = useMemo(() => (data?.summary ?? {}) as TaxSummary, [data]);

	const filterKey = JSON.stringify([startDate, endDate, searchTerms, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"tax-liability",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				jurisdiction: r.jurisdiction,
				rateName: r.rateName,
				rate: formatRatePercentLabel(Number(r.rate)),
				taxableBase: formatCurrency(Number(r.taxableBase)),
				taxCollected: formatCurrency(Number(r.taxCollected)),
				invoiceCount: r.invoiceCount,
			})),
		[rows],
	);

	const footerRow = useMemo(
		() => ({
			jurisdiction: "Total",
			taxableBase: formatCurrency(summary.taxableBase ?? 0),
			taxCollected: formatCurrency(summary.taxCollected ?? 0),
			invoiceCount: (summary.invoiceCount ?? 0).toLocaleString(),
		}),
		[summary],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const hasActiveFilters = terms.length > 0 || dateRange.option !== "all";
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Tax Liability" />

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by jurisdiction or rate..."
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
									report: "tax-liability",
									filename: datedFilename("tax-liability"),
									sheetName: "Tax Liability",
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
						<Receipt size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No tax collected</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Tax collected on created invoices appears here"}
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
