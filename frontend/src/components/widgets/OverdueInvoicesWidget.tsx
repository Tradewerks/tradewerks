import { AlertCircle } from "lucide-react";
import { ROW_GRID, RowsSkeleton } from "../disputes/OpenDisputeRow";
import { useInvoicesReportQuery } from "../../hooks/useReports";
import { Link } from "react-router-dom";
import type { InvoicesReportRow, ReportFetchParams } from "../../types/reports";
import { InvoiceStatusLabels, type InvoiceStatus } from "../../types/invoices";
import { formatCurrency, formatDateOnly } from "../../util/util";
import Card from "../ui/Card";

const PARAMS: ReportFetchParams = {
    sortKey: "daysOverdue",
    sortDir: "desc",
    limit: 15,
    conditions: [
        { id: "overdue", columnKey: "daysOverdue", operator: "gt", value: "0" },
        { id: "open", columnKey: "status", operator: "in", value: "Issued,Sent,Viewed,PartiallyPaid,Disputed" },
    ],
    join: "and",
};

export default function OverdueInvoicesWidget () {
    const { data, isLoading, error } = useInvoicesReportQuery(PARAMS);
    const rows = data ? data.rows : [];

    if (error) return (
		<div className="flex items-center gap-2 p-4 bg-error/10 border border-error/20 rounded-lg h-full">
			<AlertCircle size={14} className="text-error-text shrink-0" />
			<p className="text-sm text-error-text">Failed to load Overdue Invoices</p>
		</div>
	);


    return (
        <Card
            title="Overdue Invoices"
            className="h-full"
            noWrap
            headerAction={data && data.total > 0 ? (
                <Link
                    to="/dispatch/invoices?sort=date&dir=asc"
                    title="View invoices by due date"
                    className="-my-1 -mr-2 px-2 py-1 rounded text-xs text-text-tertiary hover:text-text-primary hover:bg-surface transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                    <span className="font-semibold tabular-nums text-text-primary">{data.total}</span> overdue →
                </Link>
            ) : undefined}
        >
            {isLoading ? (
                <RowsSkeleton rows={15}/>
            ) : rows.length > 0 ? (
                <ul className="-mx-4 -my-4 flex-1 min-h-0 overflow-y-auto divide-y divide-border-subtle overflow">
                    {rows.map((row) => {
                        const r = row as unknown as InvoicesReportRow;
                        const late = r.daysOverdue >= 30;

                        return (
                            <li key={r.id}>
                                <Link
                                    to={`/dispatch/invoices/${r.id}`}
                                    className={`${ROW_GRID} hover:bg-surface/40 focus-visible:outline-none focus-visible:bg-surface/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary`}
                                >
                                    <span className="truncate text-sm font-medium text-text-primary">
                                        {r.clientName}
                                    </span>
                                    <span className="text-right text-sm tabular-nums text-text-primary">
                                        {formatCurrency(r.balanceDue)}
                                    </span>
                                    <span className="flex min-w-0 items-baseline gap-2 text-xs">
                                        <span className="shrink-0 tabular-nums text-text-secondary">{r.invoiceNumber}</span>
                                        <span className="truncate text-text-muted">
                                            {InvoiceStatusLabels[r.status as InvoiceStatus] ?? r.status}{r.dueDate && ` · Due ${formatDateOnly(r.dueDate)}`}
                                        </span>
                                    </span>
                                    <span
                                        className={`text-right text-xs tabular-nums ${late ? "font-medium text-error-text" : "text-warning-text"}`}
                                    >
                                        {r.daysOverdue}d late
                                    </span>
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <p>No Overdue Invoices</p>
            )}
        </Card>
    )
}