import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AlertTriangle, X } from "lucide-react";
import SegmentedToggle from "../ui/SegmentedToggle";
import SearchBar from "../ui/SearchBar";
import DateRangeFilter from "../ui/DateRangeFilter";
import { DropdownFilter } from "../ui/StatusFilter";
import { FOCUS_RING } from "./fieldPurchaseFormat";
import { QUEUE_STAGES, SORT_OPTIONS, type QueueFilters, type QueueStage } from "./queueFilters";
import {
	formatTriggerLabel,
	parseDateRangeFromParams,
	serializeDateRange,
} from "../../util/dateRangeUtils";
import type { FieldPurchaseSummary } from "../../types/fieldPurchases";
import type { FieldPurchaseSort } from "../../api/fieldPurchases";

/**
 * Three bands, because the controls answer different questions: the stage rail is
 * an exclusive position in the lifecycle, refinements combine with whatever stage
 * is showing, and the third band exists so an empty queue is distinguishable from
 * one filtered down to nothing.
 */

interface QueueHeaderProps {
	filters: QueueFilters;
	summary?: FieldPurchaseSummary;
	/** Second sign-off is a separate permission; without it the stage is not work. */
	showSignoff: boolean;
}

export default function QueueHeader({ filters, summary, showSignoff }: QueueHeaderProps) {
	const [searchParams, setSearchParams] = useSearchParams();
	const [draft, setDraft] = useState(filters.search);
	const committed = useRef(filters.search);

	// The URL holds the committed search; this holds what is being typed. Writing
	// every keystroke would spam history and re-fetch mid-word.
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

	const period = parseDateRangeFromParams(searchParams, "period");
	const hasPeriod = period.option !== "all";

	function clearPeriod() {
		setSearchParams((prev) => serializeDateRange({ option: "all" }, "period", prev), {
			replace: true,
		});
	}

	function clearAll() {
		committed.current = "";
		setDraft("");
		setSearchParams(
			(prev) => {
				const next = serializeDateRange({ option: "all" }, "period", prev);
				next.delete("q");
				next.delete("flagged");
				return next;
			},
			{ replace: true }
		);
	}

	const stageCount: Record<QueueStage, number | undefined> = {
		preauth: summary?.pending_preauth_count,
		with_tech: summary?.with_tech_count,
		review: summary?.pending_review_count,
		signoff: summary?.pending_signoff_count,
		decided: undefined,
	};

	const stages = QUEUE_STAGES.filter((s) => s.id !== "signoff" || showSignoff).map((s) => ({
		id: s.id,
		label: s.label,
		badge: s.counted ? stageCount[s.id] : undefined,
	}));

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
		filters.flagged && {
			key: "flagged",
			label: "Flagged",
			onRemove: () => patch({ flagged: null }),
		},
		hasPeriod && {
			key: "period",
			label: formatTriggerLabel(period),
			onRemove: clearPeriod,
		},
	].filter((r): r is { key: string; label: string; onRemove: () => void } => Boolean(r));

	return (
		<div className="border-b border-border">
			{/* Scrolls rather than wraps: reflowed into two lines it stops reading as a sequence. */}
			<div className="overflow-x-auto px-3 pt-2">
				<SegmentedToggle<QueueStage>
					value={filters.stage}
					options={stages}
					onChange={(id) => patch({ stage: id })}
					ariaLabel="Queue stage"
					variant="flat"
				/>
			</div>

			{/* One height and border language, so the field and the dropdowns read as one object. */}
			<div className="flex flex-wrap items-center gap-2 px-3 py-2">
				<SearchBar
					placeholder="Technician, vendor or part…"
					value={draft}
					onChange={setDraft}
					className="min-w-[12rem] flex-1 [&_input]:h-9 [&_input]:py-0"
				/>
				<button
					type="button"
					role="switch"
					aria-checked={filters.flagged}
					aria-label="Flagged only"
					onClick={() => patch({ flagged: filters.flagged ? null : "1" })}
					className={`inline-flex h-9 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border px-3 text-sm transition-colors duration-150 ${FOCUS_RING} ${
						filters.flagged
							? "border-warning bg-warning-bg text-warning-text"
							: "border-border bg-base text-text-tertiary hover:text-text-primary"
					}`}
				>
					<AlertTriangle aria-hidden size={14} />
					Flagged
				</button>
				<DateRangeFilter paramKey="period" label="Purchased" />
				<DropdownFilter
					values={[filters.sort]}
					onChange={(value) => patch({ sort: (value as FieldPurchaseSort) ?? "newest" })}
					options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
					placeholder="Sort"
					exclusive
					// Sorting always has an answer, so there is nothing to clear back to.
					hideAll
				/>
			</div>

			{/* Only when something is actually hiding rows. */}
			{refinements.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle bg-surface px-3 py-1.5">
					<span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
						Filtered by
					</span>
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
								<X aria-hidden size={10} />
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
