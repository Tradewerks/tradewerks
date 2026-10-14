import { useEffect, useRef } from "react";
import { AlertTriangle, Inbox } from "lucide-react";
import EmptyState from "../ui/EmptyState";
import { OriginChip, RowSkeleton, TierChip } from "./reconcileUi";
import {
	COL_LABEL,
	ENTITY_LABELS,
	FOCUS_RING,
	lineCountLabel,
	moneyRound,
	shortDate,
} from "./reconcileFormat";
import type {
	LinkageCandidate,
	ReconcileDismissedRow,
	ReconcileProvisionalRow,
} from "../../api/inventory";
import type { ReconcileTab } from "./reconcileFilters";

/**
 * The triage half, one row shape per tab.
 *
 * What a dispatcher decides from a row is: how much money is riding on it, how
 * many places it is billed, and how confident the machine already is — so those
 * are the three things every row spends its space on.
 */

export interface ReconcileListProps {
	tab: ReconcileTab;
	unmapped: LinkageCandidate[];
	provisional: ReconcileProvisionalRow[];
	dismissed: ReconcileDismissedRow[];
	/** Whole-backlog totals, so "showing N of M" stays true past the server cap. */
	unmappedTotal: number;
	provisionalTotal: number;
	isLoading: boolean;
	isError: boolean;
	selectedKey: string | null;
	onSelect: (key: string) => void;
	onLoadMore: () => void;
	canLoadMore: boolean;
	emptyTitle: string;
	emptyDescription: string;
}

export default function ReconcileList({
	tab,
	unmapped,
	provisional,
	dismissed,
	unmappedTotal,
	provisionalTotal,
	isLoading,
	isError,
	selectedKey,
	onSelect,
	onLoadMore,
	canLoadMore,
	emptyTitle,
	emptyDescription,
}: ReconcileListProps) {
	const scrollerRef = useRef<HTMLDivElement>(null);

	// Keyboard navigation moves the selection, not the scroll position, so the
	// list has to follow it or j walks the cursor off-screen.
	useEffect(() => {
		if (!selectedKey) return;
		// Matched by attribute value rather than a built selector: a part name can
		// hold quotes and brackets, and jsdom does not always ship CSS.escape.
		const row = Array.from(
			scrollerRef.current?.querySelectorAll("[data-row-key]") ?? []
		).find((el) => el.getAttribute("data-row-key") === selectedKey);
		// jsdom has no layout, so it ships no scrollIntoView.
		if (row && typeof row.scrollIntoView === "function")
			row.scrollIntoView({ block: "nearest" });
	}, [selectedKey]);

	const shown =
		tab === "unmapped"
			? unmapped.length
			: tab === "detail"
				? provisional.length
				: dismissed.length;
	// A capped list that does not say it is capped reads as an empty backlog.
	const total =
		tab === "unmapped" ? unmappedTotal : tab === "detail" ? provisionalTotal : shown;

	return (
		<>
			<div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2">
				<span className={COL_LABEL}>
					{tab === "intentional" ? "Name" : "Part"}
				</span>
				<span className={COL_LABEL}>
					{tab === "intentional" ? "Decided" : "Billed"}
				</span>
			</div>

			<div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
				{isLoading ? (
					<RowSkeleton />
				) : isError ? (
					<EmptyState
						title="Could not load the queue"
						description="The request failed. Refresh the page to try again."
						icon={<AlertTriangle size={28} />}
					/>
				) : shown === 0 ? (
					<EmptyState
						title={emptyTitle}
						description={emptyDescription}
						icon={<Inbox size={28} />}
					/>
				) : tab === "unmapped" ? (
					unmapped.map((row) => (
						<UnmappedRow
							key={row.name}
							row={row}
							selected={row.name === selectedKey}
							onSelect={() => onSelect(row.name)}
						/>
					))
				) : tab === "detail" ? (
					provisional.map((row) => (
						<ProvisionalRow
							key={row.item_id}
							row={row}
							selected={row.item_id === selectedKey}
							onSelect={() => onSelect(row.item_id)}
						/>
					))
				) : (
					dismissed.map((row) => (
						<DismissedRow
							key={row.folded_name}
							row={row}
							selected={row.folded_name === selectedKey}
							onSelect={() => onSelect(row.folded_name)}
						/>
					))
				)}
			</div>

			{!isLoading && !isError && shown > 0 && (
				<div className="flex items-center justify-between gap-2 border-t border-border bg-surface px-3 py-1.5">
					<span className="text-[11px] tabular-nums text-text-muted">
						{shown < total
							? `Showing ${shown} of ${total}`
							: `${total} total`}
					</span>
					{shown < total &&
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
							<span className="text-[11px] text-text-muted">
								Narrow with search
							</span>
						))}
				</div>
			)}
		</>
	);
}

const ROW_BASE =
	"grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] gap-x-3 border-b border-l-[3px] border-border px-3 py-2.5 text-left transition-colors duration-150";

const rowTone = (selected: boolean) =>
	selected
		? "border-l-primary bg-primary-bg"
		: "border-l-transparent hover:bg-surface-raised";

function UnmappedRow({
	row,
	selected,
	onSelect,
}: {
	row: LinkageCandidate;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			data-row-key={row.name}
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			className={`${ROW_BASE} ${rowTone(selected)} ${FOCUS_RING}`}
		>
			<span
				className="truncate text-sm font-medium text-text-primary"
				title={row.name}
			>
				{row.name}
			</span>
			<span className="text-right text-sm font-medium tabular-nums text-text-primary">
				{moneyRound(row.value)}
			</span>

			<span className="col-start-1 truncate text-xs text-text-muted">
				{lineCountLabel(row.lines)} ·{" "}
				{row.entities.map((e) => ENTITY_LABELS[e]).join(", ")}
			</span>
			<span className="col-start-2 flex items-center justify-end">
				<TierChip tier={row.match?.tier ?? null} />
			</span>
		</button>
	);
}

function ProvisionalRow({
	row,
	selected,
	onSelect,
}: {
	row: ReconcileProvisionalRow;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			data-row-key={row.item_id}
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			className={`${ROW_BASE} ${rowTone(selected)} ${FOCUS_RING}`}
		>
			<span
				className="truncate text-sm font-medium text-text-primary"
				title={row.name}
			>
				{row.name}
			</span>
			<span className="text-right text-sm font-medium tabular-nums text-text-primary">
				{row.value > 0 ? moneyRound(row.value) : "—"}
			</span>

			<span className="col-start-1 truncate text-xs text-text-muted">
				{row.submitted_by ? row.submitted_by.name : "Dispatch"}
				{row.lines > 0 ? ` · ${lineCountLabel(row.lines)}` : ""}
			</span>
			<span className="col-start-2 flex items-center justify-end gap-1.5">
				{/* No cost basis is why most of these rows are here: the item reads as
				    free to weighted average cost and 100% margin on every line. */}
				{row.cost == null && (
					<span className="inline-flex flex-shrink-0 items-center gap-1 rounded border border-warning-border bg-warning-bg px-1.5 py-px text-[10px] font-medium text-warning-text">
						<AlertTriangle size={9} />
						No cost
					</span>
				)}
				<OriginChip origin={row.origin} />
			</span>
		</button>
	);
}

function DismissedRow({
	row,
	selected,
	onSelect,
}: {
	row: ReconcileDismissedRow;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<button
			type="button"
			data-row-key={row.folded_name}
			onClick={onSelect}
			aria-current={selected ? "true" : undefined}
			className={`${ROW_BASE} ${rowTone(selected)} ${FOCUS_RING}`}
		>
			<span
				className="truncate text-sm text-text-primary"
				title={row.folded_name}
			>
				{row.folded_name}
			</span>
			<span className="whitespace-nowrap text-right text-xs tabular-nums text-text-muted">
				{shortDate(row.decided_at)}
			</span>

			<span className="col-span-2 col-start-1 truncate text-xs text-text-muted">
				{row.decided_by ? row.decided_by.name : "Unknown"}
				{row.reason ? ` · ${row.reason}` : ""}
			</span>
		</button>
	);
}
