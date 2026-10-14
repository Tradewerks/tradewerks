import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import MonthMiniCard from "./MonthMiniCard";
import TechFilter from "./TechFilter";
import ScheduleToolbar from "./ScheduleToolbar";
import WeekStripDayColumn, { type CompactItem } from "./WeekStripDayColumn";
import ReschedulePopup from "./ReschedulePopup";
import OccurrenceReschedulePopup from "./OccurrenceReschedulePopup";
import VisitClickPopup from "./VisitClickPopup";
import OccurrenceClickPopup from "./OccurrenceClickPopup";
import {
	buildTechOrder,
	getTechColor,
	groupVisitsByDay,
	visitStartLabel,
	getPriorityColor,
	localDateKey,
	getAnchoredPopupPos,
	SCROLL_ZONE_W,
	SCROLL_DELAY_MS,
	CLICK_POPUP_H,
	prefersReducedMotion,
} from "./scheduleBoardUtils";
import {
	extractVisits,
	extractOccurrences,
	formatTime,
	buildAgendaGroups,
	buildChronologicalAgenda,
	itemStart,
} from "./dashboardCalendarUtils";
import type { OccurrenceWithPlan, VisitWithJob } from "./dashboardCalendarUtils";
import DayAgenda from "./DayAgenda";
import { useTodayKey } from "./useTodayKey";
import { isAnytimeEntry, type AgendaEntry } from "./agendaRows";
import {
	colModeForWidth,
	defaultZoom,
	effectiveZoom,
	navLabels,
	shiftAnchor,
	visibleWindow,
	windowLabel,
	type ColMode,
} from "./stripWindow";
import { buildStripTemplate } from "./weekTemplate";
import type { Job, UpdateJobVisitInput } from "../../../types/jobs";
import type { Technician } from "../../../types/technicians";
import { useUpdateJobVisitMutation } from "../../../hooks/useJobs";
import { useRescheduleOccurrenceMutation, useGenerateVisitFromOccurrenceMutation } from "../../../hooks/useRecurringPlans";
import type { RescheduleOccurrenceInput } from "../../../types/recurringPlans";

interface PendingDrop {
	visit: VisitWithJob;
	oldDateStr: string;
	newDateStr: string;
	anchorRect: DOMRect;
}

interface PendingOccurrenceDrop {
	occurrence: OccurrenceWithPlan;
	fromDateStr: string;
	newDateStr: string;
	anchorRect: DOMRect;
}

interface ClickedVisit {
	visit: VisitWithJob;
	rect: DOMRect;
}

interface ClickedOccurrence {
	occ: OccurrenceWithPlan;
	rect: DOMRect;
}

interface WeekStripProps {
	jobs: Job[];
	technicians: Technician[];
}

const STATUS_SORT_ORDER: Record<string, number> = {
	InProgress: 0, OnSite: 0,
	Driving: 1,
	Delayed: 2, Paused: 2,
	Scheduled: 3,
	Completed: 4,
	Cancelled: 5,
};

function visitTimeLabel(v: VisitWithJob): string {
	if (v.arrival_constraint === "anytime") return "";
	return visitStartLabel(v);
}

function occurrenceTimeLabel(occ: OccurrenceWithPlan): string {
	if (isAnytimeEntry({ type: "occ", item: occ })) return "";
	return formatTime(occ.occurrence_start_at);
}

function getPopupPos(rect: DOMRect): { top: number; left: number } {
	return getAnchoredPopupPos(rect, { popupH: CLICK_POPUP_H });
}

const NO_ITEMS: CompactItem[] = [];

function buildCompactItems(
	visits: VisitWithJob[],
	occs: OccurrenceWithPlan[],
	isToday: boolean
): CompactItem[] {
	const items: CompactItem[] = [
		...visits.map((v) => ({ key: `v:${v.id}`, type: "visit" as const, item: v })),
		...occs.map((o) => ({ key: `o:${o.id}`, type: "occ" as const, item: o })),
	];
	// Today is triaged by live status first; other days keep API order.
	if (isToday) {
		items.sort((a, b) => {
			const sa = a.type === "visit" ? (STATUS_SORT_ORDER[a.item.status] ?? 3) : 3;
			const sb = b.type === "visit" ? (STATUS_SORT_ORDER[b.item.status] ?? 3) : 3;
			return sa !== sb ? sa - sb : itemStart(a) - itemStart(b);
		});
	}
	return items;
}

export default function WeekStrip({ jobs, technicians }: WeekStripProps) {
	const navigate = useNavigate();

	const todayStr = useTodayKey();
	const [anchor, setAnchor] = useState<string>(todayStr);
	// colMode starts "full" (the RO corrects it after mount) and today is always inside
	// its own week, so the default-zoom rule reduces to today here.
	const [zoomedDay, setZoomedDay] = useState<string | null>(todayStr);
	// At midnight, a strip still parked on the old today follows the date; one the user
	// navigated elsewhere stays put.
	const [prevToday, setPrevToday] = useState(todayStr);
	if (prevToday !== todayStr) {
		setPrevToday(todayStr);
		if (anchor === prevToday) {
			setAnchor(todayStr);
			setZoomedDay((z) => (z === prevToday ? todayStr : z));
		}
	}
	const [animateZoom, setAnimateZoom] = useState(false);
	const [showVisits, setShowVisits] = useState(true);
	const [showOccurrences, setShowOccurrences] = useState(true);
	const [selectedTechs, setSelectedTechs] = useState<Set<string>>(new Set());

	const [draggingVisitId, setDraggingVisitId] = useState<string | null>(null);
	const [draggingOccurrenceId, setDraggingOccurrenceId] = useState<string | null>(null);
	const [dragOverDate, setDragOverDate] = useState<string | null>(null);

	const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
	const [pendingOccurrenceDrop, setPendingOccurrenceDrop] = useState<PendingOccurrenceDrop | null>(null);
	const [clickedVisit, setClickedVisit] = useState<ClickedVisit | null>(null);
	const [clickedOccurrence, setClickedOccurrence] = useState<ClickedOccurrence | null>(null);
	const [generatingVisitId, setGeneratingVisitId] = useState<string | null>(null);
	const [pendingClickReschedule, setPendingClickReschedule] = useState<{
		type: "visit" | "occurrence";
		visit?: VisitWithJob;
		occurrence?: OccurrenceWithPlan;
		anchorRect: DOMRect;
	} | null>(null);
	const [agendaSort, setAgendaSort] = useState<"tech" | "time">("time");

	const popupRef = useRef<HTMLDivElement>(null);
	const occurrencePopupRef = useRef<HTMLDivElement>(null);

	const [scrollZone, setScrollZone] = useState<"left" | "right" | null>(null);
	const [scrollProgress, setScrollProgress] = useState(0);
	const [colMode, setColMode] = useState<ColMode>("full");

	const containerRef       = useRef<HTMLDivElement>(null);
	const weekGridRef        = useRef<HTMLDivElement>(null);
	const scrollZoneRef      = useRef<"left" | "right" | null>(null);
	const scrollEnterTimeRef = useRef<number | null>(null);
	const scrollRafRef       = useRef<number | null>(null);
	const dragOriginRef      = useRef<string | null>(null);
	const hasPendingPopupRef = useRef(false);

	const isDragging = draggingVisitId !== null || draggingOccurrenceId !== null;

	// Cancel RAF on unmount
	useEffect(() => {
		return () => { if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current); };
	}, []);

	// Responsive column mode
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver(([entry]) => setColMode(colModeForWidth(entry.contentRect.width)));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	// Close visit popup on outside click.
	// Changed to "click" event listener since mousedown was messing with toggle feature that was added
	useEffect(() => {
		if (!clickedVisit) return;
		function handle(e: MouseEvent) {
			if (popupRef.current && !popupRef.current.contains(e.target as Node))
				setClickedVisit(null);
		}
		document.addEventListener("click", handle);
		return () => document.removeEventListener("click", handle);
	}, [clickedVisit]);

	// Close occurrence popup on outside click (see note above on "click" vs "mousedown")
	useEffect(() => {
		if (!clickedOccurrence) return;
		function handle(e: MouseEvent) {
			if (occurrencePopupRef.current && !occurrencePopupRef.current.contains(e.target as Node))
				setClickedOccurrence(null);
		}
		document.addEventListener("click", handle);
		return () => document.removeEventListener("click", handle);
	}, [clickedOccurrence]);

	const { mutateAsync: updateVisit } = useUpdateJobVisitMutation();
	const { mutateAsync: rescheduleOccurrence } = useRescheduleOccurrenceMutation();
	const { mutateAsync: generateVisitFromOccurrence } = useGenerateVisitFromOccurrenceMutation();

	const globalTechOrder = useMemo(() => buildTechOrder(technicians), [technicians]);
	const techColorMap = useMemo(
		() => new Map(globalTechOrder.map((id, i) => [id, getTechColor(i)])),
		[globalTechOrder]
	);
	const techNameMap = useMemo(
		() => new Map(technicians.map((t) => [t.id, t.name])),
		[technicians]
	);

	const reducedMotion = useMemo(prefersReducedMotion, []);

	const days = useMemo(() => visibleWindow(anchor, colMode), [anchor, colMode]);
	const zoom = effectiveZoom(days, zoomedDay, colMode);
	const isNarrow = colMode !== "full";
	const { prev: prevLabel, next: nextLabel } = navLabels(colMode);

	function goTo(nextAnchor: string) {
		setAnimateZoom(false);
		setAnchor(nextAnchor);
		setZoomedDay(defaultZoom(visibleWindow(nextAnchor, colMode), todayStr, colMode));
	}

	function toggleZoom(day: string) {
		setAnimateZoom(true);
		setZoomedDay((d) => (d === day ? null : day));
	}

	const allVisits = useMemo(
		() => extractVisits(jobs) as VisitWithJob[],
		[jobs]
	);
	const allOccurrences = useMemo(() => extractOccurrences(jobs, todayStr), [jobs, todayStr]);

	const filteredVisits = useMemo(() => {
		const visible = showVisits ? allVisits : [];
		if (selectedTechs.size === 0) return visible;
		return visible.filter((v) =>
			v.visit_techs?.some((vt) => selectedTechs.has(vt.tech_id))
		);
	}, [allVisits, showVisits, selectedTechs]);

	const visibleOccurrences = useMemo(
		() => (showOccurrences ? allOccurrences : []),
		[allOccurrences, showOccurrences]
	);

	const visitsByDay = useMemo(
		() => groupVisitsByDay(filteredVisits) as Record<string, VisitWithJob[]>,
		[filteredVisits]
	);

	const occurrencesByDay = useMemo(() => {
		const map: Record<string, OccurrenceWithPlan[]> = {};
		for (const occ of visibleOccurrences) {
			const day = localDateKey(occ.occurrence_start_at);
			if (!map[day]) map[day] = [];
			map[day].push(occ);
		}
		return map;
	}, [visibleOccurrences]);

	const effectiveVisitsByDay = useMemo(() => {
		if (!pendingDrop) return visitsByDay;
		const result = { ...visitsByDay };
		result[pendingDrop.oldDateStr] = (result[pendingDrop.oldDateStr] ?? []).filter(
			(v) => v.id !== pendingDrop.visit.id
		);
		result[pendingDrop.newDateStr] = [...(result[pendingDrop.newDateStr] ?? []), pendingDrop.visit];
		return result;
	}, [visitsByDay, pendingDrop]);

	const effectiveOccurrencesByDay = useMemo(() => {
		if (!pendingOccurrenceDrop) return occurrencesByDay;
		const result = { ...occurrencesByDay };
		result[pendingOccurrenceDrop.fromDateStr] = (result[pendingOccurrenceDrop.fromDateStr] ?? []).filter(
			(o) => o.id !== pendingOccurrenceDrop.occurrence.id
		);
		result[pendingOccurrenceDrop.newDateStr] = [
			...(result[pendingOccurrenceDrop.newDateStr] ?? []),
			pendingOccurrenceDrop.occurrence,
		];
		return result;
	}, [occurrencesByDay, pendingOccurrenceDrop]);

	// ── Scroll zone helpers ───────────────────────────────────────────────────

	function startScrollRaf() {
		if (scrollRafRef.current) return;
		function tick() {
			const enterTime = scrollEnterTimeRef.current;
			const zone = scrollZoneRef.current;
			if (!enterTime || !zone) { scrollRafRef.current = null; return; }
			const progress = Math.min(1, (Date.now() - enterTime) / SCROLL_DELAY_MS);
			setScrollProgress(progress);
			if (progress >= 1) {
				setAnchor((a) => shiftAnchor(a, colMode, zone === "left" ? -1 : 1));
				scrollEnterTimeRef.current = Date.now();
			}
			scrollRafRef.current = requestAnimationFrame(tick);
		}
		scrollRafRef.current = requestAnimationFrame(tick);
	}

	function stopScrollRaf() {
		if (scrollRafRef.current) { cancelAnimationFrame(scrollRafRef.current); scrollRafRef.current = null; }
	}

	function clearScrollZone() {
		setScrollZone(null);
		scrollZoneRef.current = null;
		scrollEnterTimeRef.current = null;
		stopScrollRaf();
		setScrollProgress(0);
	}

	function restoreOrigin() {
		if (dragOriginRef.current) setAnchor(dragOriginRef.current);
		dragOriginRef.current = null;
		hasPendingPopupRef.current = false;
	}

	// ── Drag handlers ────────────────────────────────────────────────────────

	// If the card unmounts mid-drag (e.g. a window shift via the scroll zone), React's
	// synthetic dragend never fires; a native listener on the source node still does.
	function listenNativeDragEnd(el: EventTarget) {
		function onNativeDragEnd() {
			el.removeEventListener("dragend", onNativeDragEnd);
			handleDragEnd();
		}
		el.addEventListener("dragend", onNativeDragEnd);
	}

	function handleVisitDragStart(e: React.DragEvent, visit: VisitWithJob, fromDateStr: string) {
		dragOriginRef.current = anchor;
		setDraggingVisitId(visit.id);

		listenNativeDragEnd(e.currentTarget);
		e.dataTransfer.setData(
			"text/plain",
			JSON.stringify({ type: "visit", visitId: visit.id, fromDateStr })
		);
		e.dataTransfer.effectAllowed = "move";
	}

	function handleOccurrenceDragStart(e: React.DragEvent, occ: OccurrenceWithPlan, fromDateStr: string) {
		dragOriginRef.current = anchor;
		setDraggingOccurrenceId(occ.id);

		listenNativeDragEnd(e.currentTarget);
		const startMs = new Date(occ.occurrence_start_at).getTime();
		const endMs   = new Date(occ.occurrence_end_at).getTime();
		e.dataTransfer.setData(
			"text/plain",
			JSON.stringify({ type: "occurrence", occurrenceId: occ.id, jobId: occ.job_obj.id, durationMs: endMs - startMs, fromDateStr })
		);
		e.dataTransfer.effectAllowed = "move";
	}

	function handleDragEnd() {
		setDragOverDate(null);
		setDraggingVisitId(null);
		setDraggingOccurrenceId(null);
		clearScrollZone();
		if (!hasPendingPopupRef.current) restoreOrigin();
	}

	function handleDragOver(e: React.DragEvent, dateStr: string) {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		setDragOverDate(dateStr);
	}

	function handleDragLeave(e: React.DragEvent) {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) {
			setDragOverDate(null);
		}
	}

	function handleGridDragOver(e: React.DragEvent<HTMLDivElement>) {
		const rect = weekGridRef.current?.getBoundingClientRect();
		if (!rect || !isDragging) return;
		const x = e.clientX - rect.left;
		const newZone: "left" | "right" | null =
			x < SCROLL_ZONE_W ? "left" : x > rect.width - SCROLL_ZONE_W ? "right" : null;
		if (newZone !== scrollZoneRef.current) {
			scrollZoneRef.current = newZone;
			setScrollZone(newZone);
			if (newZone) {
				scrollEnterTimeRef.current = Date.now();
				startScrollRaf();
			} else {
				scrollEnterTimeRef.current = null;
				stopScrollRaf();
				setScrollProgress(0);
			}
		}
	}

	function handleGridDragLeave(e: React.DragEvent<HTMLDivElement>) {
		const rect = weekGridRef.current?.getBoundingClientRect();
		if (!rect) return;
		const { clientX: x, clientY: y } = e;
		if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
			clearScrollZone();
		}
	}

	function handleDrop(e: React.DragEvent, toDateStr: string) {
		e.preventDefault();
		setDragOverDate(null);
		setDraggingVisitId(null);
		setDraggingOccurrenceId(null);
		clearScrollZone();

		const raw = e.dataTransfer.getData("text/plain");
		if (!raw) return;

		const parsed = JSON.parse(raw) as {
			type?: string;
			visitId?: string;
			occurrenceId?: string;
			jobId?: string;
			durationMs?: number;
			fromDateStr: string;
		};

		if (parsed.fromDateStr === toDateStr) {
			restoreOrigin();
			return;
		}

		const anchorRect = (e.currentTarget as HTMLElement).getBoundingClientRect();

		if (parsed.type === "occurrence") {
			let occ: OccurrenceWithPlan | undefined;
			for (const occs of Object.values(occurrencesByDay)) {
				occ = occs.find((o) => o.id === parsed.occurrenceId);
				if (occ) break;
			}
			if (!occ) return;
			hasPendingPopupRef.current = true;
			setPendingOccurrenceDrop({ occurrence: occ, fromDateStr: parsed.fromDateStr, newDateStr: toDateStr, anchorRect });
			return;
		}

		let visit: VisitWithJob | undefined;
		for (const dayVisits of Object.values(visitsByDay)) {
			visit = dayVisits.find((v) => v.id === parsed.visitId);
			if (visit) break;
		}
		if (!visit) return;
		hasPendingPopupRef.current = true;
		setPendingDrop({ visit, oldDateStr: parsed.fromDateStr, newDateStr: toDateStr, anchorRect });
	}

	// ── Mutation handlers ────────────────────────────────────────────────────

	async function handleVisitSave(visitId: string, data: UpdateJobVisitInput) {
		dragOriginRef.current = null;
		hasPendingPopupRef.current = false;
		try {
			await updateVisit({ id: visitId, data });
		} catch {
			// reverts via query invalidation
		}
		setPendingDrop(null);
	}

	function handleVisitRescheduleCancel() {
		setPendingDrop(null);
		restoreOrigin();
	}

	async function handleOccurrenceSave(input: RescheduleOccurrenceInput & { scope: "this" | "future" }) {
		if (!pendingOccurrenceDrop) return;
		dragOriginRef.current = null;
		hasPendingPopupRef.current = false;
		const { occurrence } = pendingOccurrenceDrop;
		try {
			await rescheduleOccurrence({
				occurrenceId: occurrence.id,
				jobId: occurrence.job_obj.id,
				input,
			});
		} catch {
			// reverts via query invalidation
		}
		setPendingOccurrenceDrop(null);
	}

	function handleOccurrenceRescheduleCancel() {
		setPendingOccurrenceDrop(null);
		restoreOrigin();
	}

	async function handleOccurrenceGenerate(input: Omit<RescheduleOccurrenceInput, "scope">) {
		if (!pendingOccurrenceDrop) return;
		dragOriginRef.current = null;
		hasPendingPopupRef.current = false;
		const { occurrence } = pendingOccurrenceDrop;
		setGeneratingVisitId(occurrence.id);
		setPendingOccurrenceDrop(null);
		try {
			await rescheduleOccurrence({
				occurrenceId: occurrence.id,
				jobId: occurrence.job_obj.id,
				input,
			});
			await generateVisitFromOccurrence({ occurrenceId: occurrence.id, jobId: occurrence.job_obj.id });
		} catch {
			// reverts via query invalidation
		}
		setGeneratingVisitId(null);
	}

	async function handleGenerateVisitFromClickedOccurrence() {
		if (!clickedOccurrence) return;
		const { occ } = clickedOccurrence;
		setGeneratingVisitId(occ.id);
		setClickedOccurrence(null);
		try {
			await generateVisitFromOccurrence({ occurrenceId: occ.id, jobId: occ.job_obj.id });
		} catch {
			// reverts via query invalidation
		}
		setGeneratingVisitId(null);
	}

	function isEntryDragging(entry: AgendaEntry): boolean {
		return entry.type === "visit"
			? draggingVisitId === entry.item.id
			: draggingOccurrenceId === entry.item.id || generatingVisitId === entry.item.id;
	}

	function isEntryGhost(entry: AgendaEntry): boolean {
		return entry.type === "visit"
			? pendingDrop?.visit.id === entry.item.id
			: pendingOccurrenceDrop?.occurrence.id === entry.item.id;
	}

	function toggleVisitPopup(visit: VisitWithJob, rect: DOMRect) {
		setClickedOccurrence(null);
		setClickedVisit((prev) => (prev?.visit.id === visit.id ? null : { visit, rect }));
	}

	function toggleOccurrencePopup(occ: OccurrenceWithPlan, rect: DOMRect) {
		setClickedVisit(null);
		setClickedOccurrence((prev) => (prev?.occ.id === occ.id ? null : { occ, rect }));
	}

	function renderCard(ci: CompactItem, dateStr: string, maxLines: number) {
		if (ci.type === "visit") {
			const v = ci.item;
			const techs = (v.visit_techs ?? []).map((vt) => ({
				id: vt.tech_id,
				color: techColorMap.get(vt.tech_id) ?? "var(--color-tech-unassigned)",
			}));
			return (
				<MonthMiniCard
					visitName={v.job_obj?.name ?? "Visit"}
					priorityColor={getPriorityColor(v.job_obj?.priority)}
					timeLabel={visitTimeLabel(v)}
					techs={techs}
					maxLines={maxLines}
					isDragging={isEntryDragging(ci)}
					isGhost={isEntryGhost(ci)}
					onDragStart={(e) => handleVisitDragStart(e, v, dateStr)}
					onDragEnd={handleDragEnd}
					onClick={(e) => {
						e.stopPropagation();
						toggleVisitPopup(v, e.currentTarget.getBoundingClientRect());
					}}
				/>
			);
		}
		const occ = ci.item;
		return (
			<MonthMiniCard
				visitName={occ.job_obj?.name ?? "Recurring"}
				priorityColor={getPriorityColor(occ.job_obj?.priority)}
				timeLabel={occurrenceTimeLabel(occ)}
				techs={[]}
				maxLines={maxLines}
				isOccurrence
				isDragging={isEntryDragging(ci)}
				isGhost={isEntryGhost(ci)}
				onDragStart={(e) => handleOccurrenceDragStart(e, occ, dateStr)}
				onDragEnd={handleDragEnd}
				onClick={(e) => {
					e.stopPropagation();
					toggleOccurrencePopup(occ, e.currentTarget.getBoundingClientRect());
				}}
			/>
		);
	}

	function renderAgenda(dateStr: string) {
		const dayVisits = effectiveVisitsByDay[dateStr] ?? [];
		const dayOccs = effectiveOccurrencesByDay[dateStr] ?? [];
		const groups =
			agendaSort === "tech"
				? buildAgendaGroups(dayVisits, dayOccs, technicians, techColorMap, globalTechOrder)
				: buildChronologicalAgenda(dayVisits, dayOccs);
		return (
			<DayAgenda
				groups={groups}
				techColorMap={techColorMap}
				techNameMap={techNameMap}
				isToday={dateStr === todayStr}
				onVisitClick={toggleVisitPopup}
				onVisitDragStart={(e, v) => handleVisitDragStart(e, v, dateStr)}
				onOccurrenceClick={toggleOccurrencePopup}
				onOccurrenceDragStart={(e, occ) => handleOccurrenceDragStart(e, occ, dateStr)}
				onDragEnd={handleDragEnd}
				sortMode={agendaSort}
				onSortModeChange={setAgendaSort}
				isRowDragging={isEntryDragging}
				isRowGhost={isEntryGhost}
			/>
		);
	}

	return (
		<div ref={containerRef} data-schedule-strip style={{
			display: "flex",
			flexDirection: "column",
			height: "100%",
			minHeight: 0,
			backgroundColor: "var(--color-popup-bg)",
			border: "1px solid var(--color-border-subtle)",
			borderRadius: 8,
			overflow: "hidden",
			userSelect: "none",
		}}>

			<ScheduleToolbar
				className="bg-base"
				periodLabel={windowLabel(days, colMode)}
				prevLabel={prevLabel}
				nextLabel={nextLabel}
				onToday={() => goTo(todayStr)}
				onPrev={() => goTo(shiftAnchor(anchor, colMode, -1))}
				onNext={() => goTo(shiftAnchor(anchor, colMode, 1))}
				showVisits={showVisits}
				onToggleVisits={() => setShowVisits((v) => !v)}
				showOccurrences={showOccurrences}
				onToggleOccurrences={() => setShowOccurrences((v) => !v)}
				compact={isNarrow}
				techFilter={
					<TechFilter
						technicians={technicians}
						selected={selectedTechs}
						onChange={setSelectedTechs}
						techColorMap={techColorMap}
					/>
				}
			/>

			{/* ── Week grid ────────────────────────────────────────────────────── */}
			<div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
			<div
				ref={weekGridRef}
				style={{
					display: "grid",
					gridTemplateColumns: buildStripTemplate(days, zoom),
					gridTemplateRows: "minmax(0, 1fr)",
					flex: 1,
					minHeight: 0,
					position: "relative",
					transition:
						animateZoom && !reducedMotion
							? "grid-template-columns 180ms ease-out"
							: undefined,
				}}
				onDragOver={handleGridDragOver}
				onDragLeave={handleGridDragLeave}
			>
				{days.map((dateStr, i) => {
					const isToday = dateStr === todayStr;
					const isZoomed = dateStr === zoom;
					return (
						<WeekStripDayColumn
							key={dateStr}
							dateStr={dateStr}
							isToday={isToday}
							isZoomed={isZoomed}
							showZoomButton={colMode !== "one"}
							isLast={i === days.length - 1}
							onToggleZoom={() => toggleZoom(dateStr)}
							onShowMore={() => {
								setAnimateZoom(true);
								setZoomedDay(dateStr);
							}}
							onOpenInSchedule={() => navigate(`/dispatch/schedule?week=${dateStr}&zoom=1`)}
							isDragOver={dragOverDate === dateStr}
							onDragOver={(e) => handleDragOver(e, dateStr)}
							onDragLeave={handleDragLeave}
							onDrop={(e) => handleDrop(e, dateStr)}
							items={
								isZoomed
									? NO_ITEMS
									: buildCompactItems(
											effectiveVisitsByDay[dateStr] ?? [],
											effectiveOccurrencesByDay[dateStr] ?? [],
											isToday
										)
							}
							renderCard={(ci, maxLines) => renderCard(ci, dateStr, maxLines)}
							agenda={isZoomed ? renderAgenda(dateStr) : null}
						/>
					);
				})}

				{/* ── Left drag scroll zone ─────────────────────────────────────── */}
				<div
					aria-hidden
					style={{
						position: "absolute", left: 0, top: 0, bottom: 0, width: SCROLL_ZONE_W,
						pointerEvents: "none",
						opacity: isDragging ? 1 : 0,
						transition: "opacity 0.3s ease",
						overflow: "hidden",
						zIndex: 10,
					}}
				>
					{/* Base gradient — visible while dragging */}
					<div style={{ position: "absolute", inset: 0, background: "linear-gradient(to right, rgba(59,130,246,0.22), transparent)" }} />
					{/* Progress trailing fill */}
					{scrollZone === "left" && (
						<div style={{
							position: "absolute", top: 0, bottom: 0, left: 0,
							width: `${scrollProgress * 100}%`,
							background: "linear-gradient(to right, rgba(59,130,246,0.6) 0%, rgba(59,130,246,0.18) 100%)",
						}} />
					)}
					{/* Sweep bar */}
					{scrollZone === "left" && scrollProgress > 0 && (
						<div style={{
							position: "absolute", top: 0, bottom: 0,
							left: `calc(${scrollProgress * 100}% - 2px)`, width: 2,
							background: "var(--color-primary)",
							boxShadow: "0 0 6px rgba(59,130,246,0.7)",
						}} />
					)}
					{/* Finish line — shown when hovering the zone */}
					{scrollZone === "left" && (
						<div style={{
							position: "absolute", top: 0, bottom: 0, right: 0, width: 1,
							background: "rgba(59,130,246,0.55)",
						}} />
					)}
					{/* Chevron */}
					<div style={{
						position: "absolute", top: "50%", left: 6,
						transform: "translateY(-50%)",
						color: `rgba(147,197,253,${0.4 + (scrollZone === "left" ? scrollProgress * 0.6 : 0)})`,
						fontSize: 16, fontWeight: 700, lineHeight: 1, userSelect: "none",
					}}>‹</div>
				</div>

				{/* ── Right drag scroll zone ────────────────────────────────────── */}
				<div
					aria-hidden
					style={{
						position: "absolute", right: 0, top: 0, bottom: 0, width: SCROLL_ZONE_W,
						pointerEvents: "none",
						opacity: isDragging ? 1 : 0,
						transition: "opacity 0.3s ease",
						overflow: "hidden",
						zIndex: 10,
					}}
				>
					<div style={{ position: "absolute", inset: 0, background: "linear-gradient(to left, rgba(59,130,246,0.22), transparent)" }} />
					{scrollZone === "right" && (
						<div style={{
							position: "absolute", top: 0, bottom: 0, right: 0,
							width: `${scrollProgress * 100}%`,
							background: "linear-gradient(to left, rgba(59,130,246,0.6) 0%, rgba(59,130,246,0.18) 100%)",
						}} />
					)}
					{scrollZone === "right" && scrollProgress > 0 && (
						<div style={{
							position: "absolute", top: 0, bottom: 0,
							right: `calc(${scrollProgress * 100}% - 2px)`, width: 2,
							background: "var(--color-primary)",
							boxShadow: "0 0 6px rgba(59,130,246,0.7)",
						}} />
					)}
					{/* Finish line — shown when hovering the zone */}
					{scrollZone === "right" && (
						<div style={{
							position: "absolute", top: 0, bottom: 0, left: 0, width: 1,
							background: "rgba(59,130,246,0.55)",
						}} />
					)}
					<div style={{
						position: "absolute", top: "50%", right: 6,
						transform: "translateY(-50%)",
						color: `rgba(147,197,253,${0.4 + (scrollZone === "right" ? scrollProgress * 0.6 : 0)})`,
						fontSize: 16, fontWeight: 700, lineHeight: 1, userSelect: "none",
					}}>›</div>
				</div>
			</div>
			</div>

		{/* ── Visit detail popup ───────────────────────────────────────────── */}
		{clickedVisit && (() => {
			const v   = clickedVisit.visit;
			const pos = getPopupPos(clickedVisit.rect);
			return (
				<VisitClickPopup
					visit={v}
					style={{ position: "fixed", top: pos.top, left: pos.left }}
					technicians={technicians}
					techColorMap={techColorMap}
					popupRef={popupRef}
					onClose={() => setClickedVisit(null)}
					onViewVisit={() => { setClickedVisit(null); navigate(`/dispatch/jobs/${v.job_obj.id}/visits/${v.id}`); }}
					onViewJob={() => { setClickedVisit(null); navigate(`/dispatch/jobs/${v.job_obj.id}`); }}
					onRescheduleClick={() => { setClickedVisit(null); setPendingClickReschedule({ type: "visit", visit: v, anchorRect: clickedVisit.rect }); }}
				/>
			);
		})()}

		{/* ── Occurrence click popup ───────────────────────────────────────── */}
		{clickedOccurrence && (() => {
			const { occ, rect } = clickedOccurrence;
			const pos = getPopupPos(rect);
			return (
				<OccurrenceClickPopup
					occurrence={occ}
					style={{ position: "fixed", top: pos.top, left: pos.left }}
					popupRef={occurrencePopupRef}
					isGenerating={generatingVisitId === occ.id}
					onClose={() => setClickedOccurrence(null)}
					onViewPlan={() => { setClickedOccurrence(null); navigate(`/dispatch/recurring-plans/${occ.plan.id}`); }}
					onGenerate={handleGenerateVisitFromClickedOccurrence}
					onRescheduleClick={() => { setClickedOccurrence(null); setPendingClickReschedule({ type: "occurrence", occurrence: occ, anchorRect: rect }); }}
				/>
			);
		})()}

		{/* ── Reschedule popup (visit drag) ────────────────────────────────── */}
		{pendingDrop && (
			<ReschedulePopup
				visit={pendingDrop.visit}
				oldDateStr={pendingDrop.oldDateStr}
				newDateStr={pendingDrop.newDateStr}
				allVisitsOnNewDay={visitsByDay[pendingDrop.newDateStr] ?? []}
				technicians={technicians}
				techColorMap={techColorMap}
				anchorRect={pendingDrop.anchorRect}
				onSave={(data) => handleVisitSave(pendingDrop.visit.id, data)}
				onUndo={handleVisitRescheduleCancel}
			/>
		)}

		{/* ── Occurrence reschedule popup (occurrence drag) ─────────────────── */}
		{pendingOccurrenceDrop && (
			<OccurrenceReschedulePopup
				occurrence={pendingOccurrenceDrop.occurrence}
				oldDateStr={pendingOccurrenceDrop.fromDateStr}
				newDateStr={pendingOccurrenceDrop.newDateStr}
				anchorRect={pendingOccurrenceDrop.anchorRect}
				onReschedule={handleOccurrenceSave}
				onGenerate={handleOccurrenceGenerate}
				onCancel={handleOccurrenceRescheduleCancel}
				isGenerating={generatingVisitId === pendingOccurrenceDrop.occurrence.id}
			/>
		)}

		{/* ── Click-reschedule: visit (clock button) ───────────────────────── */}
		{pendingClickReschedule?.type === "visit" && pendingClickReschedule.visit && (() => {
			const v  = pendingClickReschedule.visit;
			const nd = localDateKey(v.scheduled_start_at);
			return (
				<ReschedulePopup
					visit={v}
					oldDateStr={nd}
					newDateStr={nd}
					allVisitsOnNewDay={visitsByDay[nd] ?? []}
					technicians={technicians}
					techColorMap={techColorMap}
					anchorRect={pendingClickReschedule.anchorRect}
					onSave={async (data) => {
						try {
							await updateVisit({ id: v.id, data });
						} catch {
							// A failed update leaves the visit as-is; dismiss the popover regardless.
						}
						setPendingClickReschedule(null);
					}}
					onUndo={() => setPendingClickReschedule(null)}
				/>
			);
		})()}

		{/* ── Click-reschedule: occurrence (clock button) ──────────────────── */}
		{pendingClickReschedule?.type === "occurrence" && pendingClickReschedule.occurrence && (() => {
			const occ = pendingClickReschedule.occurrence;
			const nd  = localDateKey(occ.occurrence_start_at);
			return (
				<OccurrenceReschedulePopup
					occurrence={occ}
					oldDateStr={nd}
					newDateStr={nd}
					anchorRect={pendingClickReschedule.anchorRect}
					onReschedule={async (input) => {
						try {
							await rescheduleOccurrence({ occurrenceId: occ.id, jobId: occ.job_obj.id, input });
						} catch {
							// A failed reschedule leaves the occurrence as-is; dismiss the popover regardless.
						}
						setPendingClickReschedule(null);
					}}
					onGenerate={async (input) => {
						setGeneratingVisitId(occ.id);
						setPendingClickReschedule(null);
						try {
							await rescheduleOccurrence({ occurrenceId: occ.id, jobId: occ.job_obj.id, input });
							await generateVisitFromOccurrence({ occurrenceId: occ.id, jobId: occ.job_obj.id });
						} catch {
							// A failed generation leaves the occurrence as-is; clear the spinner regardless.
						}
						setGeneratingVisitId(null);
					}}
					onCancel={() => setPendingClickReschedule(null)}
				/>
			);
		})()}
		</div>
	);
}
