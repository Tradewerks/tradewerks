import { useEffect, useMemo, useState } from "react";
import { ShoppingCart } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import SearchBar from "../../components/ui/SearchBar";
import FilterChips from "../../components/ui/FilterChips";
import { DropdownFilter } from "../../components/ui/StatusFilter";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import StatCard from "../../components/ui/StatCard";
import SegmentedToggle from "../../components/ui/SegmentedToggle";
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
import { usePurchasesBySupplierQuery } from "../../hooks/useReports";
import type {
    PurchasesBySupplierItem,
    PurchasesBySupplierRow,
    PurchasesBySupplierSummary,
    ReportFetchParams,
} from "../../types/reports";
import { useReportSort } from "../../hooks/useReportSort";
import { sortRows } from "../../util/sortUtil";

const SUPPLIER_COLS: ColumnOption[] = [
    { key: "supplierName", label: "Supplier" },
    { key: "purchaseCount", label: "Purchases" },
    { key: "orderSpend", label: "Orders" },
    { key: "fieldSpend", label: "Field" },
    { key: "tax", label: "Tax" },
    { key: "subtotal", label: "Net Spend" },
    { key: "lastPurchaseAt", label: "Last Purchase" },
];
const PURCHASE_COLS: ColumnOption[] = [
    { key: "supplierName", label: "Supplier"},
    { key: "date", label: "Date"},
    { key: "number", label: "Number"},
    { key: "source", label: "Source"},
    { key: "status", label: "Status"},
    { key: "techName", label: "Technician"},
    { key: "subtotal", label: "Subtotal"},
];

// and lastPurchaseAt so its at the right end of the table
const SUPPLIER_NUMERIC_KEYS = ["purchaseCount", "orderSpend", "fieldSpend", "tax", "subtotal", "lastPurchaseAt"] as const;
const PURCHASE_NUMERIC_KEYS = ["subtotal"] as const;
const SUPPLIER_DATE_KEYS = ["lastPurchaseAt"];
const PURCHASE_DATE_KEYS = ["date"];

const SUPPLIER_HEADER_LABELS = buildHeaderLabels(SUPPLIER_COLS);
const PURCHASE_HEADER_LABELS = buildHeaderLabels(PURCHASE_COLS);
const SUPPLIER_COLUMN_ALIGN = buildColumnAlign(SUPPLIER_COLS, SUPPLIER_NUMERIC_KEYS);
const PURCHASE_COLUMN_ALIGN = buildColumnAlign(PURCHASE_COLS, PURCHASE_NUMERIC_KEYS);


const ITEM_GRID = "grid grid-cols-[6.5rem_7rem_6.5rem_8rem_minmax(0,1fr)_7rem] items-center gap-3 px-3";

const purchaseLink = (i: { source: string; id: string }) =>
    i.source === "order"
        ? `/dispatch/purchases/${i.id}`
        : `/dispatch/purchases?tab=field_purchases&purchase=${i.id}`;

function PurchaseItems({ items }: { items: PurchasesBySupplierItem[] }) {
    return (
        <div className="mx-3 my-2 rounded-md border border-border-subtle bg-base text-sm">
            <div className={`${ITEM_GRID} py-1.5 text-xs text-text-muted border-b border-border-subtle`}>
                <span>Date</span>
                <span>Number</span>
                <span>Source</span>
                <span>Status</span>
                <span>Technician</span>
                <span className="text-right">Subtotal</span>
            </div>
            <ul className="divide-y divide-border-subtle">
                {items.map((i) => (
                    <li key={i.id}>
                        <Link
                            to={purchaseLink(i)}
                            className={`${ITEM_GRID} py-2 tabular-nums transition-colors hover:bg-surface`}
                        >
                            <span className="text-text-muted">{formatDate(i.date)}</span>
                            <span className="font-medium text-primary-text">{i.number ?? "—"}</span>
                            <span>
                                {i.source === "order" ? "Order" : "Field"}
                                {i.kind === "refund" && " refund"}
                            </span>
                            <span className="text-text-muted capitalize">{i.status.replace(/_/g, " ")}</span>
                            <span>{i.techName ?? "—"}</span>
                            <span className={`text-right ${i.kind === "refund" ? "text-text-muted" : "font-medium"}`}>
                                {formatCurrency(i.subtotal)}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}


export default function PurchasesBySupplierPage() {
    const [searchParams] = useSearchParams();
    const [searchInput, setSearchInput] = useState("");
    const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");
    const navigate = useNavigate();

    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState(50);
    const [supplierView, setSupplierView] = useState(true);
    const [source, setSource] = useState<"order" | "field" | undefined>();
    const supplierSort = useReportSort(SUPPLIER_NUMERIC_KEYS, SUPPLIER_DATE_KEYS);
    const purchaseSort = useReportSort(PURCHASE_NUMERIC_KEYS, PURCHASE_DATE_KEYS);
    const { sort, tableProps } = supplierView ? supplierSort : purchaseSort;
    const serverSort = supplierView ? supplierSort.sort : undefined;
    const { sortKey: itemSortKey, sortDir: itemSortDir } = purchaseSort.tableProps;

    const resolved = resolveDateRange(parseDateRangeFromParams(searchParams, "period"));
    const startDate = resolved?.start.toISOString();
    const endDate = resolved?.end.toISOString();

    const searchTerms = useMemo(() => {
        const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
        return t.length ? t : undefined;
    }, [terms, searchInput]);

    const queryParams = useMemo<ReportFetchParams>(
        () => ({ searchTerms, startDate, endDate, source, page, limit: pageSize, ...serverSort }),
        [searchTerms, startDate, endDate, source, page, pageSize, serverSort],
    );

    const { data, isLoading, isFetching, error } = usePurchasesBySupplierQuery(queryParams);
    const rows = useMemo(() => (data?.rows ?? []) as unknown as PurchasesBySupplierRow[], [data]);
    const total = data?.total ?? 0;
    const hasMore = data?.hasMore ?? false;
    const summary = data?.summary as PurchasesBySupplierSummary | undefined;

    const filterKey = JSON.stringify([searchTerms, startDate, endDate, source, pageSize, serverSort]);
    useEffect(() => {
        setPage(0);
    }, [filterKey]);

    const itemsById = useMemo(() => new Map(rows.map((r) => [r.id, r.items])), [rows]);

    const stats = useMemo(
        () => [
            { label: "Net Spend", value: summary ? formatCurrency(summary.netSpend) : "—" },
            { label: "Purchases", value: summary ? String(summary.purchaseCount) : "—" },
            { label: "Suppliers", value: summary ? String(summary.supplierCount) : "—" },
            {
                label: "Field Share",
                value: summary?.fieldSharePct != null ? `${summary.fieldSharePct}%` : "—",
            },
        ],
        [summary],
    );

    const supplierCols = useColumnVisibility("purchases-by-supplier", SUPPLIER_COLS);
    const purchaseCols = useColumnVisibility("purchases-by-supplier-items", PURCHASE_COLS);
    const { hidden, toggle, reset, columnVisibility, visibleColumns } = supplierView ? supplierCols : purchaseCols;

    const displayRows = useMemo(
        () =>
            supplierView 
            ? rows.map((r) => ({
                id: r.id,
                supplierName: r.supplierName,
                purchaseCount: r.purchaseCount,
                orderSpend: formatCurrency(r.orderSpend),
                fieldSpend: formatCurrency(r.fieldSpend),
                tax: formatCurrency(r.tax),
                subtotal: formatCurrency(r.subtotal),
                lastPurchaseAt: formatDate(r.lastPurchaseAt),
            }))
            : sortRows(
                rows.flatMap((r) =>
                    r.items.map((i) => ({
                        id: `${i.source}:${i.id}`,
                        supplierName: r.supplierName,
                        date: i.date,
                        number: i.number,
                        source: `${i.source === "order" ? "Order" : "Field"}${i.kind === "refund" ? " refund" : ""}`,
                        status: i.status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
                        techName: i.techName,
                        subtotal: i.subtotal,
                    })),
                ),
                itemSortKey || "date",
                itemSortKey ? itemSortDir : "desc",
                PURCHASE_DATE_KEYS,
            )
                .map((i) => ({
                    ...i,
                    date: formatDate(i.date),
                    number: i.number ?? "—",
                    techName: i.techName ?? "—",
                    subtotal: formatCurrency(i.subtotal),
                })),
        [rows, supplierView, itemSortKey, itemSortDir],
    );

    const clearAllFilters = () => {
        setSearchInput("");
        clearAll();
    };

    const hasActiveFilters = terms.length > 0;
    const showEmpty = total === 0 && !isLoading && !error;

    return (
        <div className="text-text-primary">
            <PageHeader title="Purchases by Supplier" />

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
                        placeholder="Search by supplier..."
                        onValueChange={setSearchInput}
                        onSubmit={addTerm}
                    />
                }
                right={
                    <>
                        <DropdownFilter
                            placeholder="Source"
                            values={source ? [source] : null}
                            onChange={(v) => setSource((v as "order" | "field" | null) ?? undefined)}
                            options={[
                                { value: "order", label: "Purchase order" },
                                { value: "field", label: "Field purchase" },
                            ]}
                            exclusive
                        />
                        <DateRangeFilter paramKey="period" />
                        <ExportExcelButton
                            onExport={() =>
                                exportReportServer({
                                    report: supplierView ? "purchases-by-supplier" : "purchases-by-supplier-items",
                                    filename: datedFilename("purchases-by-supplier"),
                                    sheetName: "Purchases by Supplier",
                                    columns: visibleColumns,
                                    params: { searchTerms, startDate, endDate, source, ...sort },
                                })
                            }
                            disabled={total === 0}
                        />
                        <ColumnsButton columns={supplierView ? SUPPLIER_COLS : PURCHASE_COLS} hidden={hidden} onToggle={toggle} onReset={reset} />
                        <RefreshReportsButton />
                        <SegmentedToggle
                            value={supplierView ? "supplier" : "purchase"}
                            onChange={(v) => setSupplierView(v === "supplier")}
                            options={[
                                { id: "supplier", label: "By supplier" },
                                { id: "purchase", label: "All purchases" },
                            ]}
                            ariaLabel="Group rows"
                            size="md"
                        />
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
                        <ShoppingCart size={48} className="mx-auto text-text-faint mb-3" />
                        <h3 className="text-text-tertiary text-lg font-medium mb-2">No purchases</h3>
                        <p className="text-text-muted text-sm">
                            {hasActiveFilters
                                ? "Try adjusting your filters"
                                : "Purchase orders and approved field purchases in this period appear here"}
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
                            headerLabels={supplierView ? SUPPLIER_HEADER_LABELS : PURCHASE_HEADER_LABELS}
                            columnAlign={supplierView ? SUPPLIER_COLUMN_ALIGN : PURCHASE_COLUMN_ALIGN}
                            renderExpanded={supplierView ? (row) => <PurchaseItems items={itemsById.get(row.id as string) ?? []} /> : undefined}
                            onRowClick={
                                supplierView
                                    ? undefined
                                    : (row) => {
                                          const [source, id] = (row.id as string).split(":");
                                          navigate(purchaseLink({ source, id }));
                                      }
                            }
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
