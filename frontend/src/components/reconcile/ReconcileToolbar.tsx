import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Wand2, X } from "lucide-react";
import SegmentedToggle from "../ui/SegmentedToggle";
import SearchBar from "../ui/SearchBar";
import { DropdownFilter } from "../ui/StatusFilter";
import { ITEM_ORIGIN_LABELS, type ItemOrigin, type ReconcileSort } from "../../api/inventory";
import { COL_LABEL, FOCUS_RING, moneyRound } from "./reconcileFormat";
import {
	ORIGIN_OPTIONS,
	RECONCILE_TABS,
	SORT_OPTIONS,
	type ReconcileFilters,
	type ReconcileTab,
} from "./reconcileFilters";

/**
 * Three bands, because the controls answer different questions: the tab rail is
 * an exclusive kind of problem, refinements combine with whatever tab is
 * showing, and the accept band is the one action worth interrupting the layout
 * for — clearing a screenful of exact matches is the difference between a queue
 * that drains and one that gets clicked through 200 times.
 */

export interface BulkAccept {
	count: number;
	value: number;
	isPending: boolean;
	onAccept: () => void;
}

interface ReconcileToolbarProps {
	filters: ReconcileFilters;
	counts: Record<ReconcileTab, number | undefined>;
	/** Absent on the tabs where every row is a bare name with no origin. */
	showOrigin: boolean;
	bulk?: BulkAccept;
}

export default function ReconcileToolbar({
	filters,
	counts,
	showOrigin,
	bulk,
}: ReconcileToolbarProps) {
	const [, setSearchParams] = useSearchParams();
	const [draft, setDraft] = useState(filters.search);
	const committed = useRef(filters.search);

	// The URL holds the committed search; this holds what is being typed. Writing
	// every keystroke would spam history and refetch mid-word.
	useEffect(() => {
		if (filters.search === committed.current) return;
		committed.current = filters.search;
		setDraft(filters.search);
	}, [filters.search]);

	useEffect(() => {
		if (draft.trim() === committed.current) return;
		const id = setTimeout(() => {
			committed.current = draft.trim();
			patch({ q: draft.trim() || null });
		}, 250);
		return () => clearTimeout(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft]);

	function patch(changes: Record<string, string | null>) {
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				for (const [key, value] of Object.entries(changes)) {
					if (value === null) next.delete(key);
					else next.set(key, value);
				}
				return next;
			},
			{ replace: true }
		);
	}

	function clearAll() {
		committed.current = "";
		setDraft("");
		patch({ q: null, origin: null });
	}

	const refinements = [
		filters.search && {
			key: "q",
			label: `“${filters.search}”`,
			onRemove: () => {
				committed.current = "";
				setDraft("");
				patch({ q: null });
			},
		},
		filters.origin && {
			key: "origin",
			label: ITEM_ORIGIN_LABELS[filters.origin],
			onRemove: () => patch({ origin: null }),
		},
	].filter((r): r is { key: string; label: string; onRemove: () => void } => Boolean(r));

	const tabs = RECONCILE_TABS.map((t) => ({
		id: t.id,
		label: t.label,
		badge: t.counted ? counts[t.id] : undefined,
	}));

	return (
		<div className="border-b border-border">
			{/* Scrolls rather than wraps: reflowed onto two lines it stops reading as one rail. */}
			<div className="overflow-x-auto px-3 pt-2">
				<SegmentedToggle<ReconcileTab>
					value={filters.tab}
					options={tabs}
					onChange={(id) => patch({ tab: id })}
					ariaLabel="Reconcile view"
					variant="flat"
				/>
			</div>

			<div className="flex flex-wrap items-center gap-2 px-3 py-2">
				<SearchBar
					placeholder="Part name or SKU…"
					value={draft}
					onChange={setDraft}
					className="min-w-[12rem] flex-1 [&_input]:h-9 [&_input]:py-0"
				/>
				{showOrigin && (
					<DropdownFilter
						values={filters.origin ? [filters.origin] : []}
						onChange={(value) =>
							patch({
								origin:
									(value as ItemOrigin) ??
									null,
							})
						}
						options={ORIGIN_OPTIONS}
						placeholder="Origin"
						allLabel="All origins"
						exclusive
					/>
				)}
				<DropdownFilter
					values={[filters.sort]}
					onChange={(value) =>
						patch({
							sort:
								(value as ReconcileSort) ??
								"value_desc",
						})
					}
					options={SORT_OPTIONS}
					placeholder="Sort"
					exclusive
					// Ordering always has an answer, so there is nothing to clear back to.
					hideAll
				/>
			</div>

			{/* One decision for everything the catalog already agrees with by name. */}
			{bulk && bulk.count > 0 && (
				<div className="flex flex-wrap items-center gap-2 border-t border-primary-border bg-primary-bg px-3 py-2">
					<Wand2
						size={14}
						className="flex-shrink-0 text-primary-text"
					/>
					<span className="min-w-0 flex-1 text-xs text-text-secondary">
						<span className="font-semibold tabular-nums text-text-primary">
							{bulk.count}
						</span>{" "}
						{bulk.count === 1 ? "name matches" : "names match"}{" "}
						a catalog item exactly
						{bulk.value > 0 && (
							<>
								{" · "}
								<span className="tabular-nums">
									{moneyRound(bulk.value)}
								</span>{" "}
								of billing
							</>
						)}
					</span>
					<button
						type="button"
						onClick={bulk.onAccept}
						disabled={bulk.isPending}
						className={`inline-flex h-8 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 text-xs font-semibold text-on-primary transition-colors duration-150 hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60 ${FOCUS_RING}`}
					>
						{bulk.isPending
							? "Linking…"
							: `Accept all ${bulk.count}`}
					</button>
				</div>
			)}

			{/* Only when something is actually hiding rows. */}
			{refinements.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle bg-surface px-3 py-1.5">
					<span className={COL_LABEL}>Filtered by</span>
					{refinements.map((r) => (
						<span
							key={r.key}
							className="inline-flex h-5 max-w-[12rem] items-center gap-1 rounded border border-primary-border bg-primary-bg pl-1.5 text-[11px] font-medium text-primary-text"
						>
							<span className="truncate">{r.label}</span>
							<button
								type="button"
								onClick={r.onRemove}
								aria-label={`Remove ${r.label} filter`}
								className={`cursor-pointer rounded-r px-1 hover:bg-primary-hover/20 ${FOCUS_RING}`}
							>
								<X size={10} />
							</button>
						</span>
					))}
					<button
						type="button"
						onClick={clearAll}
						className={`ml-auto cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium text-text-muted transition-colors duration-150 hover:bg-surface-raised hover:text-text-primary ${FOCUS_RING}`}
					>
						Clear all
					</button>
				</div>
			)}
		</div>
	);
}
