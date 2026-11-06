import { useEffect, useMemo, useState } from "react";
import { ReceiptText } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
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
import { camelCaseToRegular, formatCurrency, formatDate } from "../../util/util";
import { useNotInvoicedQuery } from "../../hooks/useReports";
import type {
    NotInvoicedRow,
    NotInvoicedSummary,
    NotInvoicedItem,
    NotInvoicedStage,
    ReportFetchParams,
} from "../../types/reports";
import { useReportSort } from "../../hooks/useReportSort";
import { sortRows } from "../../util/sortUtil";
import NotInvoicedChart from "../../components/reports/NotInvoicedChart";

const CLIENT_COLS: ColumnOption[] = [
    { key: "clientName", label: "Client" },
    { key: "approved", label: "Approved" },
    { key: "inProgress", label: "In Progress" },
    { key: "readyToBill", label: "Ready to Bill" },
    { key: "total", label: "Total" },
    { key: "oldestDate", label: "Oldest" },
];
const ITEM_COLS: ColumnOption[] = [
    { key: "clientName", label: "Client" },
    { key: "stage", label: "Stage" },
    { key: "number", label: "Number" },
    { key: "title", label: "Title" },
    { key: "status", label: "Status" },
    { key: "date", label: "Date" },
    { key: "value", label: "Value" },
    { key: "unbilled", label: "Unbilled" },
];

// and oldestDate so its at the right end of the table
const CLIENT_NUMERIC_KEYS = ["approved", "inProgress", "readyToBill", "total", "oldestDate"] as const;
const ITEM_NUMERIC_KEYS = ["date", "value", "unbilled"] as const;
const CLIENT_DATE_KEYS = ["oldestDate"];
const ITEM_DATE_KEYS = ["date"];

const CLIENT_HEADER_LABELS = buildHeaderLabels(CLIENT_COLS);
const ITEM_HEADER_LABELS = buildHeaderLabels(ITEM_COLS);
const CLIENT_COLUMN_ALIGN = buildColumnAlign(CLIENT_COLS, CLIENT_NUMERIC_KEYS);
const ITEM_COLUMN_ALIGN = buildColumnAlign(ITEM_COLS, ITEM_NUMERIC_KEYS);

const STAGES: Record<NotInvoicedStage, { label: string; className: string }> = {
    approved: { label: "Approved", className: "bg-info-bg text-info-text" },
    in_progress: { label: "In progress", className: "bg-warning-bg text-warning-text" },
    ready: { label: "Ready to bill", className: "bg-success-bg text-success-text" },
};

const ITEM_GRID = "grid grid-cols-[7rem_5rem_minmax(0,1fr)_6.5rem_6rem_9rem] items-center gap-3 px-3";

function NotInvoicedItems({ items }: { items: NotInvoicedItem[] }) {
    return (
        <div className="mx-3 my-2 rounded-md border border-border-subtle bg-base text-sm">
            <div className={`${ITEM_GRID} py-1.5 text-xs text-text-muted border-b border-border-subtle`}>
                <span>Stage</span>
                <span>Number</span>
                <span>Title</span>
                <span>Status</span>
                <span>Date</span>
                <span className="text-right">Unbilled</span>
            </div>
            <ul className="divide-y divide-border-subtle">
                {items.map((i) => (
                    <li key={i.id}>
                        <Link
                            to={`/dispatch/${i.kind === "job" ? "jobs" : "quotes"}/${i.id}`}
                            className={`${ITEM_GRID} py-2 transition-colors hover:bg-surface`}
                        >
                            <span
                                className={`justify-self-start rounded-full px-2 py-0.5 text-xs font-medium ${STAGES[i.stage].className}`}
                                >
                                {STAGES[i.stage].label}
                            </span>
                            <span className="font-medium text-primary-text">{i.number}</span>
                            <span className="truncate text-text-primary" title={i.title}>
                                {i.title}
                            </span>
                            <span className="text-text-muted">{camelCaseToRegular(i.status)}</span>
                            <span className="text-text-muted">{i.date ? formatDate(i.date) : "—"}</span>
                            <span className="text-right tabular-nums">
                                <span className="font-medium">{formatCurrency(i.unbilled)}</span>
                                {i.billed > 0 && (
                                    <span className="block text-xs text-text-muted">
                                        of {formatCurrency(i.value)}
                                    </span>
                                )}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}


export default function NotInvoicedPage() {
    const [searchInput, setSearchInput] = useState("");
    const { terms, addTerm, removeTerm, clearAll, duplicateTerm } = useMultiSearch("search");

    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState(50);
    const [clientView, setClientView] = useState(true);
    const [stage, setStage] = useState<NotInvoicedStage | undefined>();
    const navigate = useNavigate();
    const clientSort = useReportSort(CLIENT_NUMERIC_KEYS, CLIENT_DATE_KEYS);
    const itemSort = useReportSort(ITEM_NUMERIC_KEYS, ITEM_DATE_KEYS);
    const { sort, tableProps } = clientView ? clientSort : itemSort;
    const serverSort = clientView ? clientSort.sort : undefined;
    const { sortKey: itemSortKey, sortDir: itemSortDir } = itemSort.tableProps;

    const searchTerms = useMemo(() => {
        const t = searchInput.trim() ? [...terms, searchInput.trim()] : terms;
        return t.length ? t : undefined;
    }, [terms, searchInput]);

    const queryParams = useMemo<ReportFetchParams>(
        () => ({ searchTerms, stage, page, limit: pageSize, ...serverSort }),
        [searchTerms, stage, page, pageSize, serverSort],
    );

    const { data, isLoading, isFetching, error } = useNotInvoicedQuery(queryParams);
    const rows = useMemo(() => (data?.rows ?? []) as unknown as NotInvoicedRow[], [data]);
    const total = data?.total ?? 0;
    const hasMore = data?.hasMore ?? false;
    const summary = data?.summary as NotInvoicedSummary | undefined;

    const filterKey = JSON.stringify([searchTerms, stage, pageSize, serverSort]);
    useEffect(() => {
        setPage(0);
    }, [filterKey]);

    const itemsById = useMemo(() => new Map(rows.map((r) => [r.id, r.items])), [rows]);

    const stats = useMemo(
        () => [
            {
                label: "Total Approved",
                value: summary ? formatCurrency(summary.totalApproved) : "—",
            },
            {
                label: "Total In Progress",
                value: summary ? formatCurrency(summary.totalInProgress) : "—",
            },
            {
                label: "Total Ready to be Billed",
                value: summary ? formatCurrency(summary.totalReady) : "—",
            },
            { label: "Clients", value: summary ? String(summary.clientCount) : "—" },
        ],
        [summary],
    );

    const clientCols = useColumnVisibility("not-invoiced", CLIENT_COLS);
    const itemCols = useColumnVisibility("not-invoiced-items", ITEM_COLS);
    const { hidden, toggle, reset, columnVisibility, visibleColumns } = clientView ? clientCols : itemCols;

    const displayRows = useMemo(
        () =>
            clientView
            ? rows.map((r) => ({
                id: r.id,
                clientName: r.clientName,
                approved: formatCurrency(Number(r.approved)),
                inProgress: formatCurrency(Number(r.inProgress)),
                readyToBill: formatCurrency(r.readyToBill),
                total: formatCurrency(r.total),
                oldestDate: r.oldestDate ? formatDate(r.oldestDate) : "—",
            }))
            : sortRows(
                rows.flatMap((r) =>
                    r.items.map((i) => ({
                        id: `${i.kind}:${i.id}`,
                        clientName: r.clientName,
                        stage: STAGES[i.stage].label,
                        number: i.number,
                        title: i.title,
                        status: camelCaseToRegular(i.status),
                        date: i.date,
                        value: i.value,
                        unbilled: i.unbilled,
                    })),
                ),
                itemSortKey || "date",
                itemSortKey ? itemSortDir : "asc",
                ITEM_DATE_KEYS,
            )
                .map((i) => ({
                    ...i,
                    date: i.date ? formatDate(i.date) : "—",
                    value: formatCurrency(i.value),
                    unbilled: formatCurrency(i.unbilled),
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
            <PageHeader title="Not Invoiced" />

            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                {stats.map((card) => (
                    <StatCard key={card.label} {...card} />
                ))}
            </div>

            <NotInvoicedChart agedBuckets={summary?.agedBuckets ?? []}/>

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
                            placeholder="Stage"
                            values={stage ? [stage] : null}
                            onChange={(v) => setStage((v as NotInvoicedStage | null) ?? undefined)}
                            options={Object.entries(STAGES).map(([value, s]) => ({ value, label: s.label }))}
                            exclusive
                        />
                        <ExportExcelButton
                            onExport={() =>
                                exportReportServer({
                                    report: clientView ? "not-invoiced" : "not-invoiced-items",
                                    filename: datedFilename("not-invoiced"),
                                    sheetName: "Not Invoiced",
                                    columns: visibleColumns,
                                    params: { searchTerms, stage, ...sort },
                                })
                            }
                            disabled={total === 0}
                        />
                        <ColumnsButton columns={clientView ? CLIENT_COLS : ITEM_COLS} hidden={hidden} onToggle={toggle} onReset={reset} />
                        <RefreshReportsButton />
                        <SegmentedToggle
                            value={clientView ? "client" : "item"}
                            onChange={(v) => setClientView(v === "client")}
                            options={[
                                { id: "client", label: "By client" },
                                { id: "item", label: "All jobs & quotes" },
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
                        <h3 className="text-text-tertiary text-lg font-medium mb-2">All sales are invoiced</h3>
                        <p className="text-text-muted text-sm">
                            {hasActiveFilters
                                ? "Try adjusting your filters"
                                : "Sales that are yet to be invoiced appear here"}
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
                            headerLabels={clientView ? CLIENT_HEADER_LABELS : ITEM_HEADER_LABELS}
                            columnAlign={clientView ? CLIENT_COLUMN_ALIGN : ITEM_COLUMN_ALIGN}
                            renderExpanded={clientView ? (row) => <NotInvoicedItems items={itemsById.get(row.id as string) ?? []} /> : undefined}
                            onRowClick={
                                clientView
                                    ? undefined
                                    : (row) => {
                                          const [kind, id] = (row.id as string).split(":");
                                          navigate(`/dispatch/${kind === "job" ? "jobs" : "quotes"}/${id}`);
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
