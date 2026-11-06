import { useEffect, useMemo, useState } from "react";
import { PackageSearch } from "lucide-react";
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
import { formatCurrency, formatDate } from "../../util/util";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import { useSalesByProductQuery } from "../../hooks/useReports";
import type {
    SalesByProductRow,
    SalesByProductSummary,
    ReportFetchParams,
} from "../../types/reports";
import { useReportSort } from "../../hooks/useReportSort";

const COLS: ColumnOption[] = [
    { key: "itemName", label: "Item" },
    { key: "unitsSold", label: "Units Sold" },
    { key: "invoiceCount", label: "Invoices" },
    { key: "grossRevenue", label: "Gross Revenue" },
    { key: "discount", label: "Discount" },
    { key: "netRevenue", label: "Net Revenue" },
    { key: "cost", label: "Cost" },
    { key: "grossProfit", label: "Gross Profit" },
    { key: "marginPct", label: "Margin" },
    { key: "lastSold", label: "Last Sold" },
];

const NUMERIC_KEYS = [
    "unitsSold",
    "invoiceCount",
    "grossRevenue",
    "discount",
    "netRevenue",
    "cost",
    "grossProfit",
    "marginPct",
    "lastSold",
] as const;
const DATE_KEYS = ["lastSold"];

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

const money = (n: number | null) => (n === null ? "—" : formatCurrency(n));

export default function SalesByProductPage() {
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const [searchInput, setSearchInput] = useState("");
    const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState(50);
    const { sort, tableProps } = useReportSort(NUMERIC_KEYS, DATE_KEYS);

    const dateRange = parseDateRangeFromParams(searchParams, "period");
    const resolved = resolveDateRange(dateRange);
    const startDate = resolved?.start.toISOString();
    const endDate = resolved?.end.toISOString();

    const searchTerms = useMemo(() => {
        const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
        return t.length ? t : undefined;
    }, [terms, searchInput]);

    const queryParams = useMemo<ReportFetchParams>(
        () => ({ searchTerms, startDate, endDate, page, limit: pageSize, ...sort }),
        [searchTerms, startDate, endDate, page, pageSize, sort],
    );

    const { data, isLoading, isFetching, error } = useSalesByProductQuery(queryParams);
    const rows = useMemo(() => (data?.rows ?? []) as unknown as SalesByProductRow[], [data]);
    const total = data?.total ?? 0;
    const hasMore = data?.hasMore ?? false;
    const summary = data?.summary as SalesByProductSummary | undefined;

    const filterKey = JSON.stringify([searchTerms, startDate, endDate, pageSize, sort]);
    useEffect(() => {
        setPage(0);
    }, [filterKey]);

    const stats = useMemo(
        () => [
            {
                label: "Net Revenue",
                value: summary ? formatCurrency(summary.netRevenue) : "—",
            },
            {
                label: "Gross Profit",
                value: summary ? formatCurrency(summary.grossProfit) : "—",
            },
            {
                label: "Margin",
                value: summary?.marginPct != null ? `${summary.marginPct}%` : "—",
            },
            { label: "Products", value: summary ? String(summary.productCount) : "—" },
        ],
        [summary],
    );

    const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
        "sales-by-product",
        COLS,
    );

    const displayRows = useMemo(
        () =>
            rows.map((r) => ({
                id: r.id,
                itemName: r.itemName,
                unitsSold: r.unitsSold,
                invoiceCount: r.invoiceCount,
                grossRevenue: formatCurrency(r.grossRevenue),
                discount: formatCurrency(r.discount),
                netRevenue: formatCurrency(r.netRevenue),
                cost: money(r.cost),
                grossProfit: money(r.grossProfit),
                marginPct: r.marginPct === null ? "—" : `${r.marginPct}%`,
                lastSold: formatDate(r.lastSold),
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
            <PageHeader title="Sales By Product" />

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
                        placeholder="Search by item..."
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
                                    report: "sales-by-product",
                                    filename: datedFilename("sales-by-product"),
                                    sheetName: "Sales By Product",
                                    columns: visibleColumns,
                                    params: { searchTerms, startDate, endDate, ...sort },
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
                        <PackageSearch size={48} className="mx-auto text-text-faint mb-3" />
                        <h3 className="text-text-tertiary text-lg font-medium mb-2">No products sold</h3>
                        <p className="text-text-muted text-sm">
                            {hasActiveFilters
                                ? "Try adjusting your filters"
                                : "Inventory items billed on issued invoices appear here"}
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
                            onRowClick={(row) => navigate(`/dispatch/inventory/items/${row.id as string}`)}
                            {...tableProps}
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
