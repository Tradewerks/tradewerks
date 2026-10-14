import { useMemo } from "react";
import { ClipboardList } from "lucide-react";
import { useNavigate } from "react-router-dom";
import PageHeader from "../../components/ui/PageHeader";
import PageControls from "../../components/ui/PageControls";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import AdaptableTable from "../../components/AdaptableTable";
import JobBacklogChart from "../../components/reports/JobBacklogChart";
import {
	buildColumnAlign,
	buildHeaderLabels,
	type ColumnOption,
} from "../../hooks/useColumnVisibility";
import { formatCurrency } from "../../util/util";
import { JobStatusLabels } from "../../types/jobs";
import { useJobBacklogQuery } from "../../hooks/useReports";

const COLS: ColumnOption[] = [
	{ key: "statusLabel", label: "Status" },
	{ key: "fresh", label: "0-7 days" },
	{ key: "aging", label: "7-30 days" },
	{ key: "stalled", label: "30+ days" },
	{ key: "totalJobs", label: "Total Jobs" },
	{ key: "valueAtRisk", label: "Value" },
];

const NUMERIC_KEYS = ["fresh", "aging", "stalled", "totalJobs", "valueAtRisk"] as const;

const HEADER_LABELS = buildHeaderLabels(COLS);
const COLUMN_ALIGN = buildColumnAlign(COLS, NUMERIC_KEYS);
const COLUMN_VISIBILITY = Object.fromEntries(COLS.map((c) => [c.key, true]));

export default function JobBacklogPage() {
	const navigate = useNavigate();
	const { data, isLoading, error } = useJobBacklogQuery();

	const displayRows = useMemo(
		() =>
			(data?.statuses ?? []).map((s) => ({
				_rawStatus: s.status,
				statusLabel: JobStatusLabels[s.status],
				fresh: String(s.fresh.count),
				aging: String(s.aging.count),
				stalled: String(s.stalled.count),
				totalJobs: String(s.total.count),
				valueAtRisk: formatCurrency(s.total.revenue),
			})),
		[data],
	);

	const footerRow = useMemo(() => {
		const t = data?.totals;
		if (!t) return undefined;
		return {
			statusLabel: "Total",
			fresh: String(t.fresh.count),
			aging: String(t.aging.count),
			stalled: String(t.stalled.count),
			totalJobs: String(t.total.count),
			valueAtRisk: formatCurrency(t.total.revenue),
		};
	}, [data]);

	const showEmpty = !isLoading && !error && (data?.totals.total.count ?? 0) === 0;

	return (
		<div className="text-text-primary">
			<PageHeader title="Job Backlog" />

			<p className="text-sm text-text-tertiary mb-4 max-w-3xl">
				Open jobs grouped by status, showing how long they have been at that status
				and the estimated value in each
			</p>

			{data && (
				<div className="mb-4 h-72">
					<JobBacklogChart data={data} />
				</div>
			)}

			<PageControls className="mb-4" right={<RefreshReportsButton />} />

			<div className="shadow-sm border border-border-subtle p-3 bg-base rounded-lg overflow-x-auto text-left">
				{showEmpty ? (
					<div className="text-center py-16">
						<ClipboardList size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No open jobs</h3>
						<p className="text-text-muted text-sm">
							Unscheduled, scheduled, and in-progress jobs appear here as your backlog builds up
						</p>
					</div>
				) : (
					<AdaptableTable
						data={displayRows}
						loadListener={isLoading}
						errListener={error}
						formatNums={false}
						columnVisibility={COLUMN_VISIBILITY}
						headerLabels={HEADER_LABELS}
						columnAlign={COLUMN_ALIGN}
						footerRow={footerRow}
						onRowClick={(row) => {
							const status = row._rawStatus as string | undefined;
							if (status) navigate(`/dispatch/jobs?status=${status}`);
						}}
					/>
				)}
			</div>
		</div>
	);
}
