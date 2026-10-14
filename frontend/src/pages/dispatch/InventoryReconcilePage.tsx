import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { MousePointerClick } from "lucide-react";
import PageHeader from "../../components/ui/PageHeader";
import StatCard from "../../components/ui/StatCard";
import ConfirmDialog from "../../components/ui/ConfirmDialog";
import ReconcileToolbar from "../../components/reconcile/ReconcileToolbar";
import ReconcileList from "../../components/reconcile/ReconcileList";
import UnmappedDetail from "../../components/reconcile/UnmappedDetail";
import ProvisionalDetail from "../../components/reconcile/ProvisionalDetail";
import DismissedDetail from "../../components/reconcile/DismissedDetail";
import { EntityBreakdown } from "../../components/reconcile/reconcileUi";
import {
	isAutoAcceptable,
	lineCountLabel,
	moneyRound,
} from "../../components/reconcile/reconcileFormat";
import {
	EMPTY_COPY,
	activeRefinementCount,
	readReconcileFilters,
	type ReconcileTab,
} from "../../components/reconcile/reconcileFilters";
import { useApplyLinkageMatchBulkMutation, useReconcileQueueQuery } from "../../hooks/useInventory";
import { useToast } from "../../components/ui/useToast";
import { isTypingKeystroke } from "../../util/keyboard";

const PAGE_SIZE = 50;
/** Mirrors CANDIDATE_LIMIT on the server; asking for more returns the same 200. */
const MAX_ROWS = 200;

/**
 * One surface for both halves of "somebody named a part the catalog doesn't know".
 * They fail differently, but which half a problem lands in depends only on whether
 * an item row happened to get created, and quick-add resolves one by creating the
 * other.
 *
 * Ranked by summed line value: a $4 grommet billed nine times does not belong above
 * a $2,400 compressor billed once. Shaped as triage because every row costs a
 * decision - the money, the machine's confidence, and the documents billing it,
 * without leaving the page to look any of it up.
 */
export default function InventoryReconcilePage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const toast = useToast();

	const filters = readReconcileFilters(searchParams);

	// The open row lives in the URL, not in component state: an approved field
	// purchase has to be able to name the part it left behind, and a tab on its
	// own cannot — it opens a list with nothing selected in it. One param for all
	// three tabs, because each tab's row key is already a single string.
	const selectedKey = searchParams.get("row");
	const setSelectedKey = useCallback(
		(key: string | null) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					if (key) next.set("row", key);
					else next.delete("row");
					return next;
				},
				{ replace: true }
			);
		},
		[setSearchParams]
	);
	const [limit, setLimit] = useState(PAGE_SIZE);
	const [confirmBulk, setConfirmBulk] = useState(false);

	const {
		data: queue,
		isLoading,
		isError,
	} = useReconcileQueueQuery({
		// Only fetched where it is the thing being read — it is a second query on
		// the server, and the other two tabs never show it.
		includeDismissed: filters.tab === "intentional",
		origin: filters.origin ?? undefined,
		search: filters.search || undefined,
		sort: filters.sort,
		limit,
	});
	const bulk = useApplyLinkageMatchBulkMutation();

	const unmapped = useMemo(() => queue?.unmapped ?? [], [queue]);
	const provisional = useMemo(() => queue?.provisional ?? [], [queue]);
	const dismissed = useMemo(() => queue?.dismissed ?? [], [queue]);

	const rowKeys = useMemo(() => {
		if (filters.tab === "unmapped") return unmapped.map((r) => r.name);
		if (filters.tab === "detail") return provisional.map((r) => r.item_id);
		return dismissed.map((r) => r.folded_name);
	}, [filters.tab, unmapped, provisional, dismissed]);

	// Any change to what the list is showing invalidates both the page depth and
	// the row that was open in the detail pane.
	const filterKey = `${filters.tab}|${filters.search}|${filters.origin ?? ""}|${filters.sort}`;
	const lastFilterKey = useRef(filterKey);
	useEffect(() => {
		if (lastFilterKey.current === filterKey) return;
		lastFilterKey.current = filterKey;
		setLimit(PAGE_SIZE);
		setSelectedKey(null);
	}, [filterKey, setSelectedKey]);

	// A settled row leaves the list, which would strand the selection on a key
	// that no longer exists and leave the pane rendering nothing.
	useEffect(() => {
		if (selectedKey && rowKeys.length > 0 && !rowKeys.includes(selectedKey)) {
			setSelectedKey(null);
		}
	}, [rowKeys, selectedKey, setSelectedKey]);

	/** The row a decision settled is no longer the work; move to the next one. */
	function advance() {
		const i = rowKeys.indexOf(selectedKey ?? "");
		if (i === -1) return setSelectedKey(null);
		setSelectedKey(rowKeys[i + 1] ?? rowKeys[i - 1] ?? null);
	}

	// j/k walk the list. Guarded on the focused element so the same letters stay
	// ordinary typing inside the search box or a reason field.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (isTypingKeystroke(e)) return;
			if (e.key !== "j" && e.key !== "k") return;
			e.preventDefault();
			const i = rowKeys.indexOf(selectedKey ?? "");
			const next = i === -1 ? rowKeys[0] : rowKeys[e.key === "j" ? i + 1 : i - 1];
			if (next) setSelectedKey(next);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [rowKeys, selectedKey, setSelectedKey]);

	const coverage = queue?.coverage;
	// Both halves whole-backlog: this is the only figure on the page that is money.
	const openValue = (queue?.unmapped_value ?? 0) + (queue?.provisional_value ?? 0);

	// Exact tier only: a folded-name or SKU hit is a guess somebody should read,
	// and accepting a screenful of guesses is how a catalog fills with
	// confidently wrong links.
	const exactRows = useMemo(
		() => unmapped.filter((r) => r.match && isAutoAcceptable(r.match.tier)),
		[unmapped]
	);
	const exactValue = exactRows.reduce((n, r) => n + r.value, 0);

	async function acceptExact() {
		try {
			const result = await bulk.mutateAsync({
				pairs: exactRows.map((r) => ({
					name: r.name,
					inventory_item_id: r.match!.inventory_item_id,
				})),
			});
			const failed = result.results.filter((r) => r.err);
			setConfirmBulk(false);
			setSelectedKey(null);
			if (failed.length > 0) {
				// Partial success is the server's contract here, so it gets said out
				// loud rather than reported as a flat win.
				toast.warning(
					`Linked ${lineCountLabel(result.linked)}. ${failed.length} of ${result.results.length} names could not be linked.`
				);
			} else {
				toast.success(
					`Linked ${lineCountLabel(result.linked)} across ${result.results.length} parts.`
				);
			}
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Could not link these parts."
			);
		}
	}

	const counts: Record<ReconcileTab, number | undefined> = {
		detail: queue?.provisional_total,
		unmapped: queue?.unmapped_total,
		intentional: undefined,
	};

	// An empty tab and a tab filtered down to nothing are different facts, and
	// telling a dispatcher the catalog is clean while a search hides forty names
	// is simply false.
	const narrowed = activeRefinementCount(filters) > 0;
	const empty = narrowed
		? {
				title: "Nothing matches these filters",
				description: "Take a filter off above to widen the search.",
			}
		: EMPTY_COPY[filters.tab];

	const selectedUnmapped =
		filters.tab === "unmapped"
			? unmapped.find((r) => r.name === selectedKey)
			: undefined;
	const selectedProvisional =
		filters.tab === "detail"
			? provisional.find((r) => r.item_id === selectedKey)
			: undefined;
	const selectedDismissed =
		filters.tab === "intentional"
			? dismissed.find((r) => r.folded_name === selectedKey)
			: undefined;

	return (
		<div className="flex flex-col gap-3 pb-4">
			<PageHeader title="Reconcile Parts" />

			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatCard
					dense
					label="Catalog coverage"
					// 100% of nothing is not coverage; it is an org with no material
					// billing yet, and the old strip reported that as a pass.
					value={
						!coverage || coverage.total === 0
							? "—"
							: `${coverage.pct}%`
					}
					hint={
						coverage && coverage.total > 0
							? `of ${coverage.total.toLocaleString()} material lines`
							: "No material lines yet"
					}
					tone={
						!coverage || coverage.total === 0
							? undefined
							: coverage.pct < 75
								? "error"
								: coverage.pct < 90
									? "warning"
									: undefined
					}
				/>
				<StatCard
					dense
					label="Billed off-catalog"
					value={queue ? moneyRound(openValue) : "—"}
					hint="Through parts the catalog can't deduct"
					tone={openValue > 0 ? "warning" : undefined}
				/>
				<StatCard
					dense
					label="Unmapped names"
					value={queue ? String(queue.unmapped_total) : "—"}
					hint="Lines pointing at no catalog item"
				/>
				<StatCard
					dense
					label="Needs detail"
					value={queue ? String(queue.provisional_total) : "—"}
					hint="Items with no cost basis or unit"
				/>
			</div>

			{/* DispatchLayout scrolls the page, not this panel, so both panes take
			    their height from here. 14rem is the measured chrome above it. */}
			<div className="flex min-h-[24rem] flex-col overflow-hidden rounded-lg border border-border bg-base lg:h-[calc(100vh-14rem)]">
				<ReconcileToolbar
					filters={filters}
					counts={counts}
					// A bare unmapped name has no origin, and neither does a dismissal.
					showOrigin={filters.tab === "detail"}
					bulk={
						filters.tab === "unmapped"
							? {
									count: exactRows.length,
									value: exactValue,
									isPending: bulk.isPending,
									onAccept: () =>
										setConfirmBulk(
											true
										),
								}
							: undefined
					}
				/>

				{/* Counts the whole org, not the search, so a narrowed list would invite
				    reading the two numbers as one. */}
				{filters.tab === "unmapped" && queue && !narrowed && (
					<EntityBreakdown counts={queue.counts} />
				)}

				<div className="flex min-h-0 flex-1 flex-col lg:flex-row">
					{/* One ground for both panes; the 2px rule carries the split. */}
					<div className="flex max-h-[45vh] min-h-0 flex-col border-b-2 border-border-strong bg-base lg:max-h-none lg:w-[24rem] lg:flex-shrink-0 lg:border-b-0 lg:border-r-2">
						<ReconcileList
							tab={filters.tab}
							unmapped={unmapped}
							provisional={provisional}
							dismissed={dismissed}
							unmappedTotal={queue?.unmapped_total ?? 0}
							provisionalTotal={queue?.provisional_total ?? 0}
							isLoading={isLoading}
							isError={isError}
							selectedKey={selectedKey}
							onSelect={setSelectedKey}
							onLoadMore={() =>
								setLimit((n) =>
									Math.min(
										MAX_ROWS,
										n + PAGE_SIZE
									)
								)
							}
							canLoadMore={limit < MAX_ROWS}
							emptyTitle={empty.title}
							emptyDescription={empty.description}
						/>
					</div>

					<div className="flex min-h-0 flex-1 flex-col">
						{/* Keyed on the row so a half-typed reason or a chosen target never
						    survives onto the next part. */}
						{selectedUnmapped ? (
							<UnmappedDetail
								key={selectedUnmapped.name}
								row={selectedUnmapped}
								onSettled={advance}
							/>
						) : selectedProvisional ? (
							<ProvisionalDetail
								key={selectedProvisional.item_id}
								row={selectedProvisional}
								onSettled={advance}
							/>
						) : selectedDismissed ? (
							<DismissedDetail
								key={selectedDismissed.folded_name}
								row={selectedDismissed}
								onSettled={advance}
							/>
						) : (
							<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
								<MousePointerClick
									size={26}
									className="text-text-faint"
								/>
								<p className="text-sm font-medium text-text-secondary">
									Pick a part to settle it
								</p>
								<p className="max-w-xs text-xs text-text-muted">
									You will see every document
									billing it, and every way to
									resolve it, without leaving
									this page.
								</p>
								<p className="text-[11px] text-text-faint">
									<kbd className="rounded border border-border px-1">
										j
									</kbd>{" "}
									and{" "}
									<kbd className="rounded border border-border px-1">
										k
									</kbd>{" "}
									walk the list.
								</p>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Rewrites historical billing rows across every line table at once —
			    exact-name only, but still not a thing to do on a stray click. */}
			<ConfirmDialog
				open={confirmBulk}
				title={`Accept ${exactRows.length} exact matches?`}
				body={
					<>
						Every line naming one of these {exactRows.length}{" "}
						parts will point at the catalog item with the same
						name
						{exactValue > 0 && (
							<>
								{" — "}
								<strong>
									{moneyRound(exactValue)}
								</strong>{" "}
								of billing
							</>
						)}
						. Lines on completed visits are marked already used,
						so the stock is not deducted twice.
					</>
				}
				confirmLabel={`Accept all ${exactRows.length}`}
				pending={bulk.isPending}
				onConfirm={() => void acceptExact()}
				onCancel={() => setConfirmBulk(false)}
			/>
		</div>
	);
}
