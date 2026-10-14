import { useEffect, useRef } from "react";
import { Inbox, Undo2 } from "lucide-react";
import EmptyState from "../ui/EmptyState";
import { AgeChip, FlagChip } from "./fieldPurchaseUi";
import { COL_LABEL, FOCUS_RING, money } from "./fieldPurchaseFormat";
import {
	FIELD_PURCHASE_STATUS_LABELS,
	isPrePurchase,
	type FieldPurchase,
} from "../../types/fieldPurchases";

/**
 * The triage half. What a dispatcher decides from a row is: how long it has been
 * waiting, how much is at stake, and what is wrong with it — so those are the
 * three things the row spends its space on.
 */

interface PurchaseQueueProps {
	rows: FieldPurchase[];
	total: number;
	isLoading: boolean;
	isError: boolean;
	selectedId: string | null;
	onSelect: (id: string) => void;
	onLoadMore: () => void;
	/** False once the server's row cap is reached, whatever the total says. */
	canLoadMore: boolean;
	/** Only worth the space where the filter does not already answer it. */
	showStatus: boolean;
	emptyTitle: string;
	emptyDescription: string;
}

export default function PurchaseQueue({
	rows,
	total,
	isLoading,
	isError,
	selectedId,
	onSelect,
	onLoadMore,
	canLoadMore,
	showStatus,
	emptyTitle,
	emptyDescription,
}: PurchaseQueueProps) {
	const scrollerRef = useRef<HTMLDivElement>(null);

	// Keyboard navigation moves the selection, not the scroll position, so the
	// list has to follow it or `j` walks the cursor off-screen.
	useEffect(() => {
		if (!selectedId) return;
		const row = scrollerRef.current?.querySelector(`[data-purchase-id="${selectedId}"]`);
		// jsdom has no layout, so it ships no scrollIntoView.
		if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
	}, [selectedId]);

	return (
		<>
			<div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
				<span className={COL_LABEL}>Technician</span>
				<span className={COL_LABEL}>Amount</span>
			</div>

			<div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
				{isLoading ? (
					<QueueSkeleton />
				) : isError ? (
					<EmptyState
						title="Could not load the queue"
						description="The request failed. Refresh the page to try again."
						icon={<Inbox aria-hidden size={28} />}
					/>
				) : rows.length === 0 ? (
					<EmptyState
						title={emptyTitle}
						description={emptyDescription}
						icon={<Inbox aria-hidden size={28} />}
					/>
				) : (
					rows.map((p) => (
						<QueueRow
							key={p.id}
							purchase={p}
							selected={p.id === selectedId}
							showStatus={showStatus}
							onSelect={() => onSelect(p.id)}
						/>
					))
				)}
			</div>

			{!isLoading && !isError && rows.length > 0 && (
				<div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-3 py-1.5">
					<span className="text-[11px] tabular-nums text-text-muted">
						{rows.length < total ? `Showing ${rows.length} of ${total}` : `${total} total`}
					</span>
					{rows.length < total &&
						(canLoadMore ? (
							<button
								type="button"
								onClick={onLoadMore}
								className={`cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium text-primary-text transition-colors duration-150 hover:bg-primary-bg ${FOCUS_RING}`}
							>
								Load more
							</button>
						) : (
							// Saying so beats a list that quietly stops being the whole answer.
							<span className="text-[11px] text-text-muted">Narrow with search or dates</span>
						))}
				</div>
			)}
		</>
	);
}

function QueueSkeleton() {
	return (
		<div aria-hidden className="animate-pulse">
			{[0, 1, 2, 3, 4].map((i) => (
				<div key={i} className="space-y-1.5 border-b border-border px-3 py-2.5">
					<div className="flex items-center justify-between gap-2">
						<div className="h-3 w-2/5 rounded bg-surface-raised" />
						<div className="h-3 w-14 rounded bg-surface-raised" />
					</div>
					<div className="h-2.5 w-3/5 rounded bg-surface-raised" />
				</div>
			))}
		</div>
	);
}

function QueueRow({
	purchase,
	selected,
	showStatus,
	onSelect,
}: {
	purchase: FieldPurchase;
	selected: boolean;
	showStatus: boolean;
	onSelect: () => void;
}) {
	const job = purchase.allocations[0]?.job;
	// A split names no single job, and picking the first one attributed the whole
	// receipt to whichever allocation happened to come back first.
	const jobLabel =
		purchase.allocations.length > 1
			? `${purchase.allocations.length} jobs`
			: job?.job_number
				? `Job #${job.job_number}`
				: job?.name;
	const waitingSince = purchase.submitted_at ?? purchase.created_at;
	// Before the counter there is no vendor to have recorded, so the usual
	// fallback reports a gap that cannot exist. The job is the whole of what a
	// pre-approval names.
	const subtitle = isPrePurchase(purchase.status)
		? (jobLabel ?? "No job attached")
		: [purchase.vendor_name || "Vendor not recorded", jobLabel].filter(Boolean).join(" · ");

	return (
		<button
			type="button"
			data-purchase-id={purchase.id}
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			className={`grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-l-[3px] border-border px-3 py-2.5 text-left transition-colors duration-150 ${FOCUS_RING} ${
				selected ? "border-l-primary bg-primary-bg" : "border-l-transparent hover:bg-surface-raised"
			}`}
		>
			<span className="flex min-w-0 items-center gap-1.5">
				{purchase.kind === "refund" && (
					<>
						{/* A glyph was the only thing distinguishing a credit from a
						    charge in this list. The review panel says it in words. */}
						<Undo2 size={12} aria-hidden className="flex-shrink-0 text-text-tertiary" />
						<span className="sr-only">Refund</span>
					</>
				)}
				<span className="truncate text-sm font-medium text-text-primary">
					{purchase.technician.name}
				</span>
			</span>
			<span className="text-right text-sm font-medium tabular-nums text-text-primary">
				{/* The column is headed Amount and the mixed stages put these beside
				    real receipts. Before the counter `total` holds the estimate, so
				    the figure is right and only the heading was lying. */}
				{isPrePurchase(purchase.status) && (
					<>
						<span
							aria-hidden
							className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary"
						>
							Est.
						</span>
						<span className="sr-only">Estimated</span>
					</>
				)}
				{money(purchase.total)}
			</span>

			<span className="col-start-1 truncate text-xs text-text-muted">{subtitle}</span>
			<span className="col-start-2 flex items-center justify-end">
				<AgeChip since={waitingSince} />
			</span>

			{(purchase.flags.length > 0 || showStatus) && (
				<span className="col-span-2 mt-1.5 flex min-w-0 items-center gap-1.5">
					<FlagChip flags={purchase.flags} />
					{showStatus && (
						<span className="truncate text-[10px] uppercase tracking-wide text-text-tertiary">
							{FIELD_PURCHASE_STATUS_LABELS[purchase.status]}
						</span>
					)}
				</span>
			)}
		</button>
	);
}
