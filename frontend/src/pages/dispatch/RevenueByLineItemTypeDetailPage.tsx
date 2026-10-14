import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Receipt } from "lucide-react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { formatCurrency } from "../../util/util";
import { useMultiSearch } from "../../hooks/useMultiSearch";
import {
	buildColumnAlign,
	buildHeaderLabels,
	useColumnVisibility,
	type ColumnOption,
} from "../../hooks/useColumnVisibility";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import { useRevenueLineItemsQuery } from "../../hooks/useReports";
import type { FilterCondition } from "../../reports/reportSources";
import type { RevenueLineItemRow, ReportFetchParams } from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "invoiceNumber", label: "Invoice #" },
	{ key: "clientName", label: "Client" },
	{ key: "issueDate", label: "Created Date" },
	{ key: "name", label: "Item" },
	{ key: "description", label: "Description" },
	{ key: "quantity", label: "Qty" },
	{ key: "unitPrice", label: "Unit Price" },
	{ key: "total", label: "Total" },
];

const NUMERIC_KEYS = ["quantity", "unitPrice", "total"] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

const TYPE_LABELS: Record<string, string> = {
	labor: "Labor",
	material: "Material",
	equipment: "Equipment",
	other: "Other",
};

export default function RevenueByLineItemTypeDetailPage() {
	const navigate = useNavigate();
	const { itemType = "other" } = useParams();
	const [searchParams] = useSearchParams();

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

	// The type filter rides the standard `conditions` grammar; the backend column
	// COALESCE(item_type,'other') means value 'other' also captures untyped items.
	const conditions = useMemo<FilterCondition[]>(
		() => [{ id: "itemType", columnKey: "itemType", operator: "equals", value: itemType }],
		[itemType],
	);

	const queryParams = useMemo<ReportFetchParams>(
		() => ({ startDate, endDate, searchTerms, conditions, page, limit: pageSize }),
		[startDate, endDate, searchTerms, conditions, page, pageSize],
	);

	const { data, isLoading, isFetching, error } = useRevenueLineItemsQuery(queryParams);
	const rows = useMemo(() => (data?.rows ?? []) as unknown as RevenueLineItemRow[], [data]);
	const total = data?.total ?? 0;
	const hasMore = data?.hasMore ?? false;
	// Set only by the in-memory fallback path when the backend row cap was hit.
	const truncated = data?.summary?.truncated === true;

	const filterKey = JSON.stringify([startDate, endDate, searchTerms, itemType, pageSize]);
	useEffect(() => {
		setPage(0);
	}, [filterKey]);

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"revenue-line-items",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				_invoiceId: r._invoiceId,
				invoiceNumber: r.invoiceNumber,
				clientName: r.clientName,
				issueDate: r.issueDate,
				name: r.name,
				description: r.description,
				quantity: r.quantity,
				unitPrice: formatCurrency(Number(r.unitPrice)),
				total: formatCurrency(Number(r.total)),
			})),
		[rows],
	);

	const clearAllFilters = () => {
		setSearchInput("");
		clearAll();
	};

	const label = TYPE_LABELS[itemType] ?? "Other";
	const hasActiveFilters = terms.length > 0;
	const showEmpty = total === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader
				title={`Revenue — ${label}`}
				subtitle={
					<Link
						to={`/dispatch/reporting/revenue-by-line-item-type?${searchParams.toString()}`}
						className="inline-flex items-center gap-1 text-sm text-text-tertiary hover:text-primary"
					>
						<ArrowLeft size={14} />
						Back to Revenue by Line Item Type
					</Link>
				}
			/>

			{truncated && (
				<div className="mb-4 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-text">
					Showing the newest line items only — the report row cap was reached, so
					this list is incomplete. Narrow the date range for a complete picture.
				</div>
			)}

			<PageControls
				className="mb-4"
				left={
					<SearchBar
						paramKey="search"
						placeholder="Search by invoice, client, or item..."
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
									report: "revenue-line-items",
									filename: datedFilename(`revenue-${itemType}`),
									sheetName: `Revenue — ${label}`,
									columns: visibleColumns,
									params: { startDate, endDate, searchTerms, conditions },
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
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							No {label.toLowerCase()} line items
						</h3>
						<p className="text-text-muted text-sm">
							{hasActiveFilters
								? "Try adjusting your filters"
								: "Billed line items of this type appear here"}
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
							onRowClick={(row) => navigate(`/dispatch/invoices/${row._invoiceId as string}`)}
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
