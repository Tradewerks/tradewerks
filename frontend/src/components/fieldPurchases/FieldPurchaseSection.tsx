import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle } from "lucide-react";
import StatCard from "../ui/StatCard";
import FieldPurchaseGrantsPanel from "../inventory/FieldPurchaseGrantsPanel";
import QueueHeader from "../fieldPurchases/QueueHeader";
import PurchaseQueue from "../fieldPurchases/PurchaseQueue";
import PurchaseReviewPanel from "../fieldPurchases/PurchaseReviewPanel";
import {
	ageLabel,
	hoursWaiting,
	isTypingKeystroke,
	money,
} from "../fieldPurchases/fieldPurchaseFormat";
import {
	EMPTY_COPY,
	QUEUE_STAGES,
	readQueueFilters,
} from "../fieldPurchases/queueFilters";
import { useFieldPurchaseQueue, useFieldPurchaseSummary } from "../../hooks/useFieldPurchases";
import { usePermission } from "../../hooks/usePermission";
import { parseDateRangeFromParams, resolveDateRange } from "../../util/dateRangeUtils";
import type { ListPurchasesParams } from "../../api/fieldPurchases";

// The stage rail narrows one queue; authorizations is a different record, so it
// gets a level of its own rather than a fifth stage.
type View = "queue" | "grants";

const PAGE_SIZE = 50;
/** Mirrors the server's `limit` ceiling in listPurchasesQuerySchema. */
const MAX_ROWS = 200;

/**
 * The dispatcher's side of emergency purchasing. Reimbursement has no
 * independent upstream record of the spend — the receipt is the only proof — so
 * this queue IS the control, and the summary above it is how a dispatcher knows,
 * before opening anything, whether today is under control.
 */
export default function FieldPurchasesSection() {
	const [searchParams, setSearchParams] = useSearchParams();
	const [view, setView] = useState<View>("queue");
	const [limit, setLimit] = useState(PAGE_SIZE);
	// The panel's own receipt lightbox is a fixed sheet that paints over this page
	// without unmounting anything under it — j/k moving the selection behind a
	// receipt the dispatcher cannot see past is the same defect the panel's own
	// shortcuts already had to be fixed for.
	const [receiptFull, setReceiptFull] = useState(false);

	// The open row lives in the URL, not in component state: a job page, a
	// notification or a colleague's link has to be able to name one purchase, and
	// a stage on its own cannot — three statuses share a stage.
	const selectedId = searchParams.get("purchase");
	const setSelectedId = useCallback(
		(id: string | null) => {
			setSearchParams(
				(prev) => {
					const next = new URLSearchParams(prev);
					if (id) next.set("purchase", id);
					else next.delete("purchase");
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);
	const canManageGrants = usePermission("manage_field_purchase_grants");
	const canSecondSign = usePermission("second_sign_off_field_purchases");

	const parsed = readQueueFilters(searchParams);
	// A URL can name a stage this dispatcher has no permission to act in.
	const filters =
		parsed.stage === "signoff" && !canSecondSign ? { ...parsed, stage: "review" as const } : parsed;

	const period = parseDateRangeFromParams(searchParams, "period");
	const resolved = resolveDateRange(period);
	const stage = QUEUE_STAGES.find((s) => s.id === filters.stage)!;

	const params: ListPurchasesParams = {
		status: stage.status,
		flagged: filters.flagged ? "true" : undefined,
		search: filters.search || undefined,
		date_from: resolved?.start.toISOString(),
		date_to: resolved?.end.toISOString(),
		sort: filters.sort,
		limit,
	};

	const { data: page, isLoading, isError } = useFieldPurchaseQueue(params, view === "queue");
	const { data: summary, isError: summaryFailed } = useFieldPurchaseSummary();

	const rows = useMemo(() => page?.items ?? [], [page]);
	const total = page?.total ?? 0;

	// Any change to what the queue is showing invalidates both the page depth and
	// the row the reviewer had open.
	const filterKey = `${filters.stage}|${filters.flagged}|${filters.search}|${filters.sort}|${period.option}|${resolved?.start.toISOString() ?? ""}`;
	const lastFilterKey = useRef(filterKey);
	useEffect(() => {
		if (lastFilterKey.current === filterKey) return;
		lastFilterKey.current = filterKey;
		setLimit(PAGE_SIZE);
		setSelectedId(null);
	}, [filterKey, setSelectedId]);

	/** The row a decision just settled is no longer the work; move to the next one. */
	function advance() {
		const i = rows.findIndex((r) => r.id === selectedId);
		if (i === -1) return setSelectedId(null);
		setSelectedId(rows[i + 1]?.id ?? rows[i - 1]?.id ?? null);
	}

	// j/k walk the queue. Guarded on the focused element so the same letters stay
	// ordinary typing inside the search box or the note.
	useEffect(() => {
		if (view !== "queue" || receiptFull) return;
		const onKey = (e: KeyboardEvent) => {
			if (isTypingKeystroke(e)) return;
			if (e.key !== "j" && e.key !== "k") return;
			e.preventDefault();
			const i = rows.findIndex((r) => r.id === selectedId);
			const target = i === -1 ? rows[0] : rows[e.key === "j" ? i + 1 : i - 1];
			if (target) setSelectedId(target.id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [rows, selectedId, view, setSelectedId, receiptFull]);

	const oldestHours = hoursWaiting(summary?.oldest_open_at ?? null);

	// An empty stage and a stage filtered down to nothing are different facts, and
	// telling a dispatcher "nothing waiting on review" while a date filter hides
	// six receipts is simply false.
	const narrowed = Boolean(filters.search || filters.flagged || period.option !== "all");
	const empty = narrowed
		? {
				title: "No purchases match these filters",
				description: "Take a filter off above to widen the search.",
			}
		: EMPTY_COPY[filters.stage];

	return (
		<div className="flex flex-col gap-3 pb-4">
			{/* Every card prints "—" without this, which is also what they print while
			    loading and next to what zero looks like. The strip is how a dispatcher
			    decides whether today is under control, so it must not fail quietly. */}
			{summaryFailed && (
				<p
					role="status"
					aria-live="polite"
					className="flex items-center gap-1.5 rounded-md border border-warning-border bg-warning-bg px-3 py-1.5 text-xs text-warning-text"
				>
					<AlertTriangle size={13} aria-hidden className="flex-shrink-0" />
					Could not load today's totals — the figures below are unknown, not zero.
					The queue itself is unaffected.
				</p>
			)}

			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<StatCard
					dense
					label="Awaiting decision"
					value={summary ? money(summary.open_value) : "—"}
					hint={summary ? `${summary.open_count} open receipts` : undefined}
				/>
				<StatCard
					dense
					label="Oldest waiting"
					value={oldestHours === null ? "—" : ageLabel(oldestHours)}
					hint={oldestHours === null ? "Nothing in the queue" : "Since submission"}
					tone={
						oldestHours === null
							? undefined
							: oldestHours >= 72
								? "error"
								: oldestHours >= 24
									? "warning"
									: undefined
					}
				/>
				<StatCard
					dense
					label="Flagged"
					value={summary ? String(summary.flagged_count) : "—"}
					hint="Open purchases needing a look"
					tone={summary?.flagged_count ? "warning" : undefined}
				/>
				<StatCard
					dense
					label="Refunds owed"
					value={summary ? money(summary.unsettled_refund_value) : "—"}
					hint={summary ? `${summary.unsettled_refund_count} not yet received` : undefined}
					tone={summary?.unsettled_refund_count ? "warning" : undefined}
				/>
			</div>

			{/* DispatchLayout scrolls the page, not this panel, so both panes get their
			    height from here. 14rem is the measured chrome above it. */}
			<div className="flex min-h-[24rem] flex-col overflow-hidden rounded-lg border border-border bg-base lg:h-[calc(100vh-14rem)]">
				{/* Only worth drawing when the second screen is reachable at all. */}
				{canManageGrants && (
					<div
						role="tablist"
						aria-label="Field purchase views"
						className="flex items-center border-b border-border bg-surface px-3"
					>
						{(
							[
								{ key: "queue", label: "Review queue" },
								{ key: "grants", label: "Authorizations" },
							] as { key: View; label: string }[]
						).map((v) => (
							<button
								key={v.key}
								type="button"
								role="tab"
								id={`fp-tab-${v.key}`}
								aria-controls={`fp-panel-${v.key}`}
								aria-selected={view === v.key}
								// Roving tabindex: the tablist is one tab stop, arrows move within it.
								tabIndex={view === v.key ? 0 : -1}
								onKeyDown={(e) => {
									if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
									e.preventDefault();
									const next: View = view === "queue" ? "grants" : "queue";
									setView(next);
									// Focus travels with the selection, or it is left on a tab that
									// just became tabIndex=-1 and the next Tab leaves the tablist.
									document.getElementById(`fp-tab-${next}`)?.focus();
								}}
								onClick={() => setView(v.key)}
								className={`-mb-px cursor-pointer border-b-2 px-5 py-2.5 text-sm font-medium transition-colors ${
									view === v.key
										? "border-primary text-text-primary"
										: "border-transparent text-text-tertiary hover:text-text-primary"
								}`}
							>
								{v.label}
							</button>
						))}
					</div>
				)}

				{view === "queue" && (
					<QueueHeader filters={filters} summary={summary} showSignoff={canSecondSign} />
				)}

				{view === "grants" ? (
					<div
						id="fp-panel-grants"
						role="tabpanel"
						aria-labelledby="fp-tab-grants"
						className="min-h-0 flex-1 overflow-y-auto"
					>
						<FieldPurchaseGrantsPanel />
					</div>
				) : (
					<div
						id="fp-panel-queue"
						role={canManageGrants ? "tabpanel" : undefined}
						aria-labelledby={canManageGrants ? "fp-tab-queue" : undefined}
						className="flex min-h-0 flex-1 flex-col lg:flex-row"
					>
						{/* One ground for both panes; the 2px rule carries the split. */}
						<div className="flex max-h-[45vh] min-h-0 flex-col border-b-2 border-border-strong bg-base lg:max-h-none lg:w-[22rem] lg:flex-shrink-0 lg:border-b-0 lg:border-r-2">
							<PurchaseQueue
								rows={rows}
								total={total}
								isLoading={isLoading}
								isError={isError}
								selectedId={selectedId}
								onSelect={setSelectedId}
								onLoadMore={() => setLimit((n) => Math.min(MAX_ROWS, n + PAGE_SIZE))}
								canLoadMore={limit < MAX_ROWS}
								showStatus={stage.mixed}
								emptyTitle={empty.title}
								emptyDescription={empty.description}
							/>
						</div>

						<div className="flex min-h-0 flex-1 flex-col">
							<PurchaseReviewPanel
								purchaseId={selectedId}
								onDecided={advance}
								onReceiptFullscreenChange={setReceiptFull}
							/>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
