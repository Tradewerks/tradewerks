import { useRef, type ReactNode } from "react";
import AgendaRow from "./AgendaRow";
import {
	agendaCountLabel,
	agendaSignature,
	buildAgendaRows,
	countAgenda,
	nowRuleIndex,
	whoLabel,
	type AgendaEntry,
	type AgendaRowModel,
} from "./agendaRows";
import type { AgendaGroup, OccurrenceWithPlan, VisitWithJob } from "./dashboardCalendarUtils";
import { getPriorityColor } from "./scheduleBoardUtils";
import { TOOLBAR_FOCUS } from "./toolbarButton";
import { useAgendaOverflow } from "./useAgendaOverflow";
import { useMinuteClock } from "./useMinuteClock";

interface DayAgendaProps {
	groups: AgendaGroup[];
	techColorMap: Map<string, string>;
	techNameMap: Map<string, string>;
	isToday: boolean;
	onVisitClick: (visit: VisitWithJob, rect: DOMRect) => void;
	onVisitDragStart: (e: React.DragEvent, visit: VisitWithJob) => void;
	onOccurrenceClick: (occ: OccurrenceWithPlan, rect: DOMRect) => void;
	onOccurrenceDragStart: (e: React.DragEvent, occ: OccurrenceWithPlan) => void;
	onDragEnd: () => void;
	sortMode: "tech" | "time";
	onSortModeChange: (mode: "tech" | "time") => void;
	isRowDragging?: (entry: AgendaEntry) => boolean;
	isRowGhost?: (entry: AgendaEntry) => boolean;
}

const SORT_MODES = [
	{ mode: "time", label: "Time" },
	{ mode: "tech", label: "Tech" },
] as const;

function NowRule() {
	return (
		<div data-now-rule role="separator" aria-label="Now" className="flex items-center gap-1.5 h-3">
			<span className="w-11 shrink-0 text-right text-[9px] font-semibold text-primary">now</span>
			<span className="flex-1 h-px bg-primary" />
		</div>
	);
}

export default function DayAgenda({
	groups,
	techColorMap,
	techNameMap,
	isToday,
	onVisitClick,
	onVisitDragStart,
	onOccurrenceClick,
	onOccurrenceDragStart,
	onDragEnd,
	sortMode,
	onSortModeChange,
	isRowDragging,
	isRowGhost,
}: DayAgendaProps) {
	const showNow = isToday && sortMode === "time";
	// Ticks in Tech sort too, so switching back to Time never places the rule by a stale clock.
	const nowMs = useMinuteClock(isToday);
	const { visits, occs } = countAgenda(groups);
	const rootRef = useRef<HTMLDivElement>(null);
	const signature = agendaSignature(groups, sortMode, showNow);
	const hintRef = useRef<HTMLButtonElement>(null);
	const overflow = useAgendaOverflow(rootRef, hintRef, signature);
	const hintEmpty = overflow.below === 0;

	function renderRow(row: AgendaRowModel) {
		const { entry } = row;
		const common = {
			anytime: row.anytime,
			showTime: row.showTime,
			time: row.time,
			suffix: row.suffix,
			isDragging: isRowDragging?.(entry) ?? false,
			isGhost: isRowGhost?.(entry) ?? false,
			onDragEnd,
		};
		if (entry.type === "visit") {
			const visit = entry.item;
			const techs = visit.visit_techs.map((vt) => ({
				id: vt.tech_id,
				color: techColorMap.get(vt.tech_id) ?? "var(--color-tech-unassigned)",
			}));
			const names = visit.visit_techs
				.map((vt) => techNameMap.get(vt.tech_id))
				.filter((n): n is string => !!n);
			return (
				<AgendaRow
					key={row.key}
					{...common}
					title={visit.job_obj?.name ?? "Visit"}
					priorityColor={getPriorityColor(visit.job_obj?.priority)}
					isOccurrence={false}
					techs={techs}
					who={sortMode === "time" ? whoLabel(names) : null}
					onClick={(e) => {
						e.stopPropagation();
						onVisitClick(visit, e.currentTarget.getBoundingClientRect());
					}}
					onDragStart={(e) => onVisitDragStart(e, visit)}
				/>
			);
		}
		const occurrence = entry.item;
		return (
			<AgendaRow
				key={row.key}
				{...common}
				title={occurrence.job_obj?.name ?? "Recurring"}
				priorityColor={getPriorityColor(occurrence.job_obj?.priority)}
				isOccurrence
				techs={[]}
				who={null}
				onClick={(e) => {
					e.stopPropagation();
					onOccurrenceClick(occurrence, e.currentTarget.getBoundingClientRect());
				}}
				onDragStart={(e) => onOccurrenceDragStart(e, occurrence)}
			/>
		);
	}

	function renderRows(items: AgendaEntry[], keyPrefix: string, withNow: boolean): ReactNode[] {
		const rows = buildAgendaRows(items, keyPrefix);
		const nowAt = withNow ? nowRuleIndex(rows, nowMs) : null;
		const out: ReactNode[] = [];
		rows.forEach((row, i) => {
			if (i === nowAt) out.push(<NowRule key="now" />);
			out.push(renderRow(row));
		});
		if (nowAt === rows.length) out.push(<NowRule key="now" />);
		return out;
	}

	return (
		<div ref={rootRef} data-day-agenda className="flex flex-col gap-0.5">
			<div
				data-agenda-header
				className="h-5 shrink-0 flex items-center justify-between pl-2 mb-0.5"
			>
				<span className="text-[10px] font-medium text-text-muted">
					{agendaCountLabel(visits, occs)}
				</span>
				{visits + occs > 0 && (
					<div
						role="group"
						aria-label="Sort visits"
						className="flex items-center gap-px p-px border border-border-subtle rounded bg-base"
					>
						{SORT_MODES.map(({ mode, label }) => (
							<button
								key={mode}
								type="button"
								aria-pressed={sortMode === mode}
								onClick={() => onSortModeChange(mode)}
								className={`h-4 px-1.5 rounded-sm text-[10px] font-medium transition-colors duration-150 ${TOOLBAR_FOCUS} ${
									sortMode === mode
										? "bg-surface-raised text-primary-text"
										: "text-text-muted hover:text-text-secondary"
								}`}
							>
								{label}
							</button>
						))}
					</div>
				)}
			</div>

			{sortMode === "time"
				? renderRows(groups[0]?.items ?? [], "all", showNow)
				: groups.map((g) => (
						<div
							key={g.techId}
							role="group"
							aria-label={g.techName || "Unassigned"}
							className="flex flex-col gap-0.5"
						>
							<div
								data-agenda-group
								className="sticky top-0 z-[1] h-5 flex items-center gap-1.5 pl-2 bg-base"
							>
								<span
									aria-hidden
									className="block w-2 h-2 rounded-full"
									style={{ backgroundColor: g.color }}
								/>
								<span className="text-[10px] font-semibold text-text-primary">
									{g.techName || "Unassigned"}
								</span>
								<span className="text-[10px] font-medium text-text-muted">
									{g.items.length}
								</span>
							</div>
							{renderRows(g.items, g.techId, false)}
						</div>
					))}
			{/* after: backs the strip body's 4px bottom padding, which sticky bottom-0 leaves open. */}
			{overflow.overflowing && (
				<button
					ref={hintRef}
					type="button"
					data-agenda-below
					aria-hidden={hintEmpty || undefined}
					tabIndex={hintEmpty ? -1 : undefined}
					onClick={overflow.pageDown}
					className={`sticky bottom-0 z-[1] h-4 shrink-0 pl-2 text-left text-[9px] font-semibold bg-base before:pointer-events-none before:absolute before:inset-x-0 before:-top-3 before:h-3 before:bg-linear-to-t before:from-base before:to-transparent after:absolute after:inset-x-0 after:top-full after:h-1 after:bg-base ${TOOLBAR_FOCUS} ${hintEmpty ? "invisible" : ""}`}
					style={{ color: "var(--color-visit-driving-text)" }}
				>
					+{overflow.below} below
				</button>
			)}
		</div>
	);
}
