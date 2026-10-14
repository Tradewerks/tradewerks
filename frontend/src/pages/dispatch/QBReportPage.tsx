import { useMemo, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { BarChart3, Info, PlugZap } from "lucide-react";
import PageControls from "../../components/ui/PageControls";
import PageHeader from "../../components/ui/PageHeader";
import RefreshReportsButton from "../../components/reports/RefreshReportButton";
import DateRangeFilter from "../../components/ui/DateRangeFilter";
import QBReportTable from "../../components/reports/QBReportTable";
import SyncedClientsToggle from "../../components/reports/SyncedClientsToggle";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import { useQBStatusQuery, useQBReportQuery, useSyncedClientFilter } from "../../hooks/useQuickbooks";
import { QB_REPORT_TYPES, type QBReportQuery, type QBReportTypeId } from "../../types/quickbooks";

type AccountingMethod = "Accrual" | "Cash";

/** Formats a local-time date as "YYYY-MM-DD" (QuickBooks expects date-only). */
function toQBDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export default function QBReportPage() {
	const { reportType } = useParams<{ reportType: string }>();
	const meta = QB_REPORT_TYPES.find((r) => r.id === reportType);

	const [searchParams] = useSearchParams();
	const dateRange = parseDateRangeFromParams(searchParams, "period");
	const resolved = resolveDateRange(dateRange);
	const startDate = resolved ? toQBDate(resolved.start) : undefined;
	const endDate = resolved ? toQBDate(resolved.end) : undefined;

	const [method, setMethod] = useState<AccountingMethod>("Accrual");
	const { enabled: syncedOnly, setEnabled: setSyncedOnly, mappedCount, customer } = useSyncedClientFilter();
	const clientFilterActive = !!meta?.supportsClientFilter;

	const query = useMemo<QBReportQuery>(
		() => ({
			start_date: startDate,
			end_date: endDate,
			accounting_method: method,
			customer: clientFilterActive ? customer : undefined,
		}),
		[startDate, endDate, method, clientFilterActive, customer],
	);

	const { data: status } = useQBStatusQuery();
	const connected = status?.connected ?? false;

	const { data, isLoading, isFetching, error } = useQBReportQuery(
		meta?.id as QBReportTypeId,
		query,
		connected && !!meta,
	);

	const hasRows = (data?.Rows?.Row?.length ?? 0) > 0;

	if (!meta) {
		return (
			<div className="text-text-primary">
				<PageHeader title="Unknown report" />
				<div className="shadow-sm border border-border-subtle p-4 bg-base rounded-lg text-center py-16 text-text-muted text-sm">
					This QuickBooks report type isn&apos;t recognized.
				</div>
			</div>
		);
	}

	return (
		<div className="text-text-primary">
			<PageHeader title={meta.label} />

			<PageControls
				className="mb-4"
				right={
					<>
						<div className="inline-flex rounded-md border border-border overflow-hidden">
							{(["Accrual", "Cash"] as const).map((m) => (
								<button
									key={m}
									onClick={() => setMethod(m)}
									aria-pressed={method === m}
									className={`h-9 px-3 text-sm font-medium transition-colors ${
										method === m
											? "bg-primary-bg text-primary-text"
											: "text-text-tertiary hover:bg-surface hover:text-text-primary"
									}`}
								>
									{m}
								</button>
							))}
						</div>
						{clientFilterActive && (
							<SyncedClientsToggle
								active={syncedOnly}
								onToggle={() => setSyncedOnly((v) => !v)}
								mappedCount={mappedCount}
							/>
						)}
						<DateRangeFilter paramKey="period" />
						<RefreshReportsButton />
					</>
				}
			/>

			{connected && clientFilterActive && !syncedOnly && (
				<div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-surface border border-border mb-4">
					<Info size={14} className="text-text-tertiary shrink-0 mt-0.5" />
					<p className="text-xs text-text-tertiary">
						Showing all QuickBooks data, including customers not linked to a client in this
						app. Turn on "Synced clients only" to limit this report to clients you've linked.
					</p>
				</div>
			)}

			<div className="shadow-sm border border-border-subtle p-4 bg-base rounded-lg overflow-x-auto text-left">
				{!connected ? (
					<div className="text-center py-16">
						<PlugZap size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">
							QuickBooks not connected
						</h3>
						<p className="text-text-muted text-sm mb-4">
							Connect QuickBooks to view your {meta.label} report.
						</p>
						<Link
							to="/dispatch/admin"
							className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md bg-primary hover:bg-primary-hover text-on-primary text-sm font-medium transition-colors"
						>
							Go to Integrations
						</Link>
					</div>
				) : isLoading ? (
					<div className="text-center py-16 text-text-muted text-sm">Loading…</div>
				) : error ? (
					<div className="text-center py-16">
						<p className="text-error-text text-sm">
							{error instanceof Error ? error.message : "Failed to load report"}
						</p>
					</div>
				) : !hasRows ? (
					<div className="text-center py-16">
						<BarChart3 size={48} className="mx-auto text-text-faint mb-3" />
						<h3 className="text-text-tertiary text-lg font-medium mb-2">No data</h3>
						<p className="text-text-muted text-sm">No activity for this period.</p>
					</div>
				) : (
					<div className={isFetching ? "opacity-60 transition-opacity" : undefined}>
						<QBReportTable report={data!} />
					</div>
				)}
			</div>
		</div>
	);
}
