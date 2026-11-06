import { useEffect, useMemo, useState } from "react";
import { ReceiptText } from "lucide-react";
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
import { camelCaseToRegular, formatDate } from "../../util/util";
import { useInvoiceLifecycleQuery } from "../../hooks/useReports";
import type {
    InvoiceLifecycleSummary,
    InvoiceLifecycleRow,
    InvoiceLifecycleItem,
    ReportFetchParams,
} from "../../types/reports";
import { useReportSort } from "../../hooks/useReportSort";
import { sortRows } from "../../util/sortUtil";
import InvoiceLifeCycleChart from "../../components/reports/InvoiceLifecycleChart";

const CLIENT_COLS: ColumnOption[] = [
    { key: "clientName", label: "Client" },
    { key: "invoiceCount", label: "Invoices" },
    { key: "avgCompletedToInvoiced", label: "Completed → Invoiced" },
    { key: "avgCreatedToSent", label: "Created → Sent" },
    { key: "avgSentToPaid", label: "Sent → Paid" },
    { key: "avgCreatedToPaid", label: "Created → Paid" },
    { key: "avgDaysLate", label: "Avg Days Late" },
    { key: "onTimePct", label: "On Time" },
];

const INVOICE_COLS: ColumnOption[] = [
    { key: "clientName", label: "Client" },
    { key: "number", label: "Invoice" },
    { key: "status", label: "Status" },
    { key: "createdAt", label: "Created" },
    { key: "completedToInvoiced", label: "Completed → Invoiced" },
    { key: "createdToSent", label: "Created → Sent" },
    { key: "sentToPaid", label: "Sent → Paid" },
    { key: "createdToPaid", label: "Created → Paid" },
    { key: "daysLate", label: "Days Late" },
];

const CLIENT_NUMERIC_KEYS = [
    "invoiceCount",
    "avgCompletedToInvoiced",
    "avgCreatedToSent",
    "avgSentToPaid",
    "avgCreatedToPaid",
    "avgDaysLate",
    "onTimePct",
] as const;
const INVOICE_NUMERIC_KEYS = [
    "completedToInvoiced",
    "createdToSent",
    "sentToPaid",
    "createdToPaid",
    "daysLate",
] as const;
const CLIENT_DATE_KEYS: string[] = [];
const INVOICE_DATE_KEYS = ["createdAt"];

const days = (n: number | null) => (n == null ? "—" : `${n} d`);
const lateText = (n: number | null) =>
    n == null ? "—" : n > 0 ? `${n} d late` : n === 0 ? "On due date" : `${-n} d early`;

const CLIENT_HEADER_LABELS = buildHeaderLabels(CLIENT_COLS);
const INVOICE_HEADER_LABELS = buildHeaderLabels(INVOICE_COLS);
const CLIENT_COLUMN_ALIGN = buildColumnAlign(CLIENT_COLS, CLIENT_NUMERIC_KEYS);
const INVOICE_COLUMN_ALIGN = buildColumnAlign(INVOICE_COLS, INVOICE_NUMERIC_KEYS);

const ITEM_GRID = "grid grid-cols-[6rem_6rem_6rem_repeat(5,minmax(0,1fr))] items-center gap-3 px-3";

function late(n: number | null) {
    if (n == null) return <span className="text-text-muted">—</span>;
    if (n > 0) return <span className="font-medium text-warning-text">{n} d late</span>;
    return <span className="text-text-muted">{n === 0 ? "On due date" : `${-n} d early`}</span>;
}

function InvoiceLifecycleItems({ items }: { items: InvoiceLifecycleItem[] }) {
    return (
        <div className="mx-3 my-2 rounded-md border border-border-subtle bg-base text-sm">
            <div className={`${ITEM_GRID} py-1.5 text-xs text-text-muted border-b border-border-subtle`}>
                <span>Invoice</span>
                <span>Status</span>
                <span>Created</span>
                <span className="text-right">Completed → Invoiced</span>
                <span className="text-right">Created → Sent</span>
                <span className="text-right">Sent → Paid</span>
                <span className="text-right">Created → Paid</span>
                <span className="text-right">Due</span>
            </div>
            <ul className="divide-y divide-border-subtle">
                {items.map((i) => (
                    <li key={i.id}>
                        <Link
                            to={`/dispatch/invoices/${i.id}`}
                            className={`${ITEM_GRID} py-2 tabular-nums transition-colors hover:bg-surface`}
                        >
                            <span className="font-medium text-primary-text">{i.number}</span>
                            <span className="text-text-muted">{camelCaseToRegular(i.status)}</span>
                            <span className="text-text-muted">{formatDate(i.createdAt)}</span>
                            <span className="text-right">{days(i.completedToInvoiced)}</span>
                            <span className="text-right">{days(i.createdToSent)}</span>
                            <span className="text-right">{days(i.sentToPaid)}</span>
                            <span className="text-right">{days(i.createdToPaid)}</span>
                            <span className="text-right">{late(i.daysLate)}</span>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default function InvoiceLifecyclePage() {
    const [searchParams] = useSearchParams();
    const [searchInput, setSearchInput] = useState("");
    const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState(50);
    const [clientView, setClientView] = useState(true);
    const [paymentStatus, setPaymentStatus] = useState<"open" | "paid" | undefined>();
    const navigate = useNavigate();
    const clientSort = useReportSort(CLIENT_NUMERIC_KEYS, CLIENT_DATE_KEYS);
    const invoiceSort = useReportSort(INVOICE_NUMERIC_KEYS, INVOICE_DATE_KEYS);
    const { sort, tableProps } = clientView ? clientSort : invoiceSort;
    const serverSort = clientView ? clientSort.sort : undefined;
    const { sortKey: itemSortKey, sortDir: itemSortDir } = invoiceSort.tableProps;

    const resolved = resolveDateRange(parseDateRangeFromParams(searchParams, "period"));
    const startDate = resolved?.start.toISOString();
    const endDate = resolved?.end.toISOString();

    const searchTerms = useMemo(() => {
        const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
        return t.length ? t : undefined;
    }, [terms, searchInput]);

    const queryParams = useMemo<ReportFetchParams>(
        () => ({ searchTerms, startDate, endDate, paymentStatus, page, limit: pageSize, ...serverSort }),
        [searchTerms, startDate, endDate, paymentStatus, page, pageSize, serverSort],
    );

    const { data, isLoading, isFetching, error } = useInvoiceLifecycleQuery(queryParams);
    const rows = useMemo(() => (data?.rows ?? []) as unknown as InvoiceLifecycleRow[], [data]);
    const total = data?.total ?? 0;
    const hasMore = data?.hasMore ?? false;
    const summary = data?.summary as InvoiceLifecycleSummary | undefined;

    const filterKey = JSON.stringify([searchTerms, startDate, endDate, paymentStatus, pageSize, serverSort]);
    useEffect(() => {
        setPage(0);
    }, [filterKey]);

    const itemsById = useMemo(() => new Map(rows.map((r) => [r.id, r.items])), [rows]);

    const stats = useMemo(
        () => [
            { label: "Invoices", value: summary ? String(summary.invoiceCount) : "—" },
            { label: "Avg Created → Paid", value: summary ? days(summary.avgCreatedToPaid) : "—" },
            {
                label: "Paid On Time",
                value: summary?.onTimePct != null ? `${summary.onTimePct}%` : "—",
            },
            { label: "Clients", value: summary ? String(summary.clientCount) : "—" },
        ],
        [summary],
    );

    const clientCols = useColumnVisibility("invoice-lifecycle", CLIENT_COLS);
    const invoiceCols = useColumnVisibility("invoice-lifecycle-items", INVOICE_COLS);
    const { hidden, toggle, reset, columnVisibility, visibleColumns } = clientView ? clientCols : invoiceCols;

    const displayRows = useMemo(
        () =>
            clientView
            ? rows.map((r) => ({
                id: r.id,
                clientName: r.clientName,
                invoiceCount: r.invoiceCount,
                avgCompletedToInvoiced: days(r.avgCompletedToInvoiced),
                avgCreatedToSent: days(r.avgCreatedToSent),
                avgSentToPaid: days(r.avgSentToPaid),
                avgCreatedToPaid: days(r.avgCreatedToPaid),
                avgDaysLate: days(r.avgDaysLate),
                onTimePct: r.onTimePct == null ? "—" : `${r.onTimePct}%`,
            }))
            : sortRows(
                rows.flatMap((r) =>
                    r.items.map((i) => ({ ...i, clientName: r.clientName, status: camelCaseToRegular(i.status) })),
                ),
                itemSortKey || "createdAt",
                itemSortKey ? itemSortDir : "desc",
                INVOICE_DATE_KEYS,
            )
                .map((i) => ({
                    id: i.id,
                    clientName: i.clientName,
                    number: i.number,
                    status: i.status,
                    createdAt: formatDate(i.createdAt),
                    completedToInvoiced: days(i.completedToInvoiced),
                    createdToSent: days(i.createdToSent),
                    sentToPaid: days(i.sentToPaid),
                    createdToPaid: days(i.createdToPaid),
                    daysLate: lateText(i.daysLate),
                })),
        [rows, clientView, itemSortKey, itemSortDir],
    );

    const clearAllFilters = () => {
        setSearchInput("");
        clearAll();
    };

    const hasActiveFilters = terms.length > 0;
    const showEmpty = total === 0 && !isLoading && !error;

    return (
        <div className="text-text-primary">
            <PageHeader title="Invoice Lifecycle" />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {stats.map((card) => (
                    <StatCard key={card.label} {...card} />
                ))}
            </div>

            <InvoiceLifeCycleChart timeBuckets={summary?.timeBuckets ?? []} />

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
                        <DropdownFilter
                            placeholder="Status"
                            values={paymentStatus ? [paymentStatus] : null}
                            onChange={(v) => setPaymentStatus((v as "open" | "paid" | null) ?? undefined)}
                            options={[
                                { value: "open", label: "Open" },
                                { value: "paid", label: "Paid" },
                            ]}
                            exclusive
                        />
                        <DateRangeFilter paramKey="period" />
                        <ExportExcelButton
                            onExport={() =>
                                exportReportServer({
                                    report: clientView ? "invoice-lifecycle" : "invoice-lifecycle-items",
                                    filename: datedFilename("invoice-lifecycle"),
                                    sheetName: "Invoice Lifecycle",
                                    columns: visibleColumns,
                                    params: { searchTerms, startDate, endDate, paymentStatus, ...sort },
                                })
                            }
                            disabled={total === 0}
                        />
                        <ColumnsButton columns={clientView ? CLIENT_COLS : INVOICE_COLS} hidden={hidden} onToggle={toggle} onReset={reset} />
                        <RefreshReportsButton />
                        <SegmentedToggle
                            value={clientView ? "client" : "invoice"}
                            onChange={(v) => setClientView(v === "client")}
                            options={[
                                { id: "client", label: "By client" },
                                { id: "invoice", label: "All invoices" },
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
                        <ReceiptText size={48} className="mx-auto text-text-faint mb-3" />
                        <h3 className="text-text-tertiary text-lg font-medium mb-2">No invoices</h3>
                        <p className="text-text-muted text-sm">
                            {hasActiveFilters
                                ? "Try adjusting your filters"
                                : "Issued invoices in this period appear here"}
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
                            headerLabels={clientView ? CLIENT_HEADER_LABELS : INVOICE_HEADER_LABELS}
                            columnAlign={clientView ? CLIENT_COLUMN_ALIGN : INVOICE_COLUMN_ALIGN}
                            renderExpanded={clientView ? (row) => <InvoiceLifecycleItems items={itemsById.get(row.id as string) ?? []} /> : undefined}
                            onRowClick={clientView ? undefined : (row) => navigate(`/dispatch/invoices/${row.id}`)}
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
