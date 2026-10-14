import { useMemo } from "react";
import { Link } from "react-router-dom";
import { Briefcase, ClipboardList, User } from "lucide-react";
import { useItemUsageQuery } from "../../../hooks/useInventory";
import type { ItemUsageRow, UnitBasis } from "../../../types/inventory";
import { formatDate } from "../../../util/util";
import { unitLabel } from "../../../lib/units";
import EmptyState from "../../ui/EmptyState";
import Card from "../../ui/Card";
import LoadSvg from "../../../assets/icons/loading.svg?react";
import { UNIT_BREAK_DETAIL, unitBreakNote, unitBreakShort } from "./chartNotes";
import { QueryErrorState } from "./chartShared";

const PAGE_SIZE = 20;

// Offset-paginated (see usageQuerySchema on the backend — these are GROUP BY
// aggregate rows, not raw ledger rows with a stable cursor id). Pages live in
// the infinite query, same as StockMovementList, so "Load more" can't append
// a page twice. `createdAfter` folds into the query key, so a range change
// naturally starts the infinite query over at page 0 — no manual reset needed.
// Rows mirror that component's two-line shape rather than BatchDetailPage's
// four-column grid: the two cards sit side by side at half width each, where
// a 600px column floor would have forced a nested horizontal scrollbar.
export default function UsageReport({
	itemId,
	createdAfter,
}: {
	itemId: string;
	createdAfter?: string;
}) {
	const { data, isLoading, isFetching, isError, refetch, hasNextPage, fetchNextPage } =
		useItemUsageQuery(itemId, { limit: PAGE_SIZE, createdAfter });

	const rows: ItemUsageRow[] = useMemo(
		() => data?.pages.flatMap((p) => p.usage) ?? [],
		[data],
	);

	// Union across every loaded row (the same fold the server does per page,
	// extended over pages): every row can be single-unit while the column still
	// stacks `each` totals against `box` totals, which only this can see.
	const columnBasis: UnitBasis = useMemo(() => {
		const units = [...new Set(rows.flatMap((r) => r.unitBasis.units))].sort();
		return { units, unit: units.length === 1 ? units[0] : null, mixed: units.length > 1 };
	}, [rows]);
	const columnBreak = unitBreakNote(columnBasis, "the Used column");

	const isFirstLoad = isLoading && rows.length === 0;

	return (
		<Card title="Usage by Job">
			{isFirstLoad && (
				<div className="flex justify-center py-12">
					<LoadSvg className="w-7 h-7" />
				</div>
			)}

			{isError && rows.length === 0 && (
				<QueryErrorState what="usage by job" onRetry={() => refetch()} />
			)}

			{!isFirstLoad && !isError && rows.length === 0 && (
				<EmptyState
					icon={<ClipboardList size={26} />}
					title={createdAfter ? "No usage in this range" : "No usage yet"}
					description={
						createdAfter
							? "Widen the range above to see more of this item's usage history."
							: "Once this item is used on a job visit, the jobs and clients it was consumed on will show up here."
					}
				/>
			)}

			{/* Job on the first line, client + last-used muted beneath it, qty
			    pinned right. Same 420px cap as the ledger it shares a row with. */}
			{rows.length > 0 && (
				<div className="border border-border-subtle bg-base rounded-lg overflow-hidden">
					<div className="max-h-[420px] overflow-y-auto">
						{rows.map((r) => (
							<div
								key={`${r.jobId}-${r.clientId}`}
								className="flex items-start justify-between gap-3 px-3 py-2.5 border-b border-border-subtle/50 last:border-b-0 hover:bg-surface-raised/40 transition-colors"
							>
								<div className="min-w-0">
									<Link
										to={`/dispatch/jobs/${r.jobId}`}
										className="flex items-center gap-1.5 text-sm text-text-link hover:underline"
									>
										<Briefcase
											size={12}
											className="shrink-0"
										/>
										<span className="truncate">
											{
												r.jobNumber
											}{" "}
											·{" "}
											{
												r.jobName
											}
										</span>
									</Link>
									<div className="mt-0.5 flex items-center gap-1.5 text-xs text-text-muted">
										<User
											size={12}
											className="shrink-0 text-text-faint"
										/>
										<span className="truncate">
											{
												r.clientName
											}
										</span>
										<span className="text-text-faint">
											·
										</span>
										<span className="whitespace-nowrap">
											{formatDate(
												r.lastConsumedAt
											)}
										</span>
									</div>
								</div>
								{/* A withheld total is a fact about the row (its movements span a
								    unit change), not a missing number — say so rather than
								    rendering a blank. A real total names its own unit. */}
								<div className="shrink-0 text-right">
									{r.qtyConsumed == null ? (
										<div className="text-xs font-medium text-text-secondary">
											{unitBreakShort(r.unitBasis) ?? "—"}
										</div>
									) : (
										<div className="text-sm font-semibold tabular-nums text-text-primary">
											{r.qtyConsumed}{" "}
											<span className="text-xs font-normal text-text-muted">
												{unitLabel(r.unitBasis.unit, r.qtyConsumed)}
											</span>
										</div>
									)}
									<div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
										Used
									</div>
								</div>
							</div>
						))}
					</div>
				</div>
			)}

			{columnBreak && (
				<p className="mt-3 text-[11px] text-text-faint" title={UNIT_BREAK_DETAIL}>
					{columnBreak}
				</p>
			)}

			{hasNextPage && (
				<div className="pt-3 flex justify-center">
					<button
						type="button"
						onClick={() => fetchNextPage()}
						disabled={isFetching}
						className="px-3 py-1.5 text-xs font-medium bg-surface border border-border rounded-md text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors disabled:opacity-50"
					>
						{isFetching ? "Loading…" : "Load more"}
					</button>
				</div>
			)}
		</Card>
	);
}
