import { useMemo } from "react";
import { Coins } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import ColumnsButton from "../../components/ui/ColumnsButton";
import StatCard from "../../components/ui/StatCard";
import ExportExcelButton from "../../components/reports/ExportExcelButton";
import AdaptableTable from "../../components/AdaptableTable";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import RevenueByLineItemTypeChart from "../../components/reports/RevenueByLineItemTypeChart";
import { exportReportServer } from "../../api/reports";
import { datedFilename } from "../../util/download";
import { formatCurrency } from "../../util/util";
import {
	buildColumnAlign,
	buildHeaderLabels,
	useColumnVisibility,
	type ColumnOption,
} from "../../hooks/useColumnVisibility";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import { useRevenueByLineItemTypeQuery } from "../../hooks/useReports";
import type {
	RevenueByLineItemTypeRow,
	RevenueByLineItemTypeSummary,
	ReportFetchParams,
} from "../../types/reports";

const COLS: ColumnOption[] = [
	{ key: "label", label: "Type" },
	{ key: "revenue", label: "Revenue" },
	{ key: "lineCount", label: "Line Items" },
	{ key: "pctOfTotal", label: "% of Total" },
];

const NUMERIC_KEYS = ["revenue", "lineCount", "pctOfTotal"] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);

export default function RevenueByLineItemTypePage() {
	const navigate = useNavigate();
	const [searchParams] = useSearchParams();

	const dateRange = parseDateRangeFromParams(searchParams, "period");
	const resolved = resolveDateRange(dateRange);
	const startDate = resolved?.start.toISOString();
	const endDate = resolved?.end.toISOString();

	const queryParams = useMemo<ReportFetchParams>(
		() => ({ startDate, endDate, limit: 200 }),
		[startDate, endDate],
	);

	const { data, isLoading, error } = useRevenueByLineItemTypeQuery(queryParams);
	const rows = useMemo(() => (data?.rows ?? []) as unknown as RevenueByLineItemTypeRow[], [data]);
	const summary = data?.summary as RevenueByLineItemTypeSummary | undefined;

	const { hidden, toggle, reset, columnVisibility, visibleColumns } = useColumnVisibility(
		"revenue-by-line-item-type",
		COLS,
	);

	const displayRows = useMemo(
		() =>
			rows.map((r) => ({
				id: r.id,
				label: r.label,
				revenue: formatCurrency(Number(r.revenue)),
				lineCount: r.lineCount,
				pctOfTotal: `${r.pctOfTotal}%`,
			})),
		[rows],
	);

	// The backend sums invoice_line_item.total, which is before any invoice-level
	// discount and before tax, so this cannot reconcile with "Issued" on the
	// Invoices page — the label says what it actually is.
	const stats = useMemo(
		() => [
			{
				label: "Line-Item Subtotal (pre-discount, pre-tax)",
				value: summary ? formatCurrency(summary.totalRevenue) : "—",
				hint: "Sum of invoice lines; invoice-level discounts and tax are not allocated.",
			},
			{
				label: "Total Line Items",
				value: summary ? String(summary.totalLineItems) : "—",
			},
		],
		[summary],
	);

	const showEmpty = (summary?.totalRevenue ?? 0) === 0 && !isLoading && !error;

	return (
		<div className="text-text-primary">
			<PageHeader title="Revenue by Line Item Type" />

			<div className="grid grid-cols-2 gap-3 mb-4">
				{stats.map((card) => (
					<StatCard key={card.label} {...card} />
				))}
			</div>

			{!isLoading && !error && (
				<div className="h-72 mb-4">
					<RevenueByLineItemTypeChart data={rows} total={summary?.totalRevenue ?? 0} />
				</div>
			)}

			<PageControls
				className="mb-4"
				right={
					<>
						<DateRangeFilter paramKey="period" />
						<ExportExcelButton
							onExport={() =>
								exportReportServer({
									report: "revenue-by-line-item-type",
									filename: datedFilename("revenue-by-line-item-type"),
									sheetName: "Revenue by Line Item Type",
									columns: visibleColumns,
									params: { startDate, endDate },
								})
							}
							disabled={(summary?.totalRevenue ?? 0) === 0}
						/>
						<ColumnsButton columns={COLS} hidden={hidden} onToggle={toggle} onReset={reset} />
						<RefreshReportsButton />
					</>
				}
			/>

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<Coins size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No billed revenue</h3>
						<p className="text-text-muted text-sm">
							Revenue from issued invoices appears here once you invoice work
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
							onRowClick={(row) =>
								navigate(
									`/dispatch/reporting/revenue-by-line-item-type/${row.id as string}?${searchParams.toString()}`,
								)
							}
						/>
					</>
				)}
			</div>
		</div>
	);
}
