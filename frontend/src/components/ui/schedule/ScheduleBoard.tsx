import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { ChevronDown } from "lucide-react";
import DayHeaderCell from "./DayHeaderCell";
import { useNavigate, useSearchParams } from "react-router-dom";
import ScheduleBoardDayColumn from "./ScheduleBoardDayColumn";
import { setSharedDragOffset } from "./scheduleBoardDragState";
import MonthGrid from "./MonthGrid";
import TechFilter from "./TechFilter";
import {
	buildTechOrder,
	getTechColor,
	getWeekDays,
	groupVisitsByDay,
	getPriorityColor,
	SLOT_H,
	DAY_START,
	DAY_END,
	SCROLL_ZONE_W,
	SCROLL_DELAY_MS,
	localDateKey,
	dateKeyAt,
	getAnchoredPopupPos,
	CLICK_POPUP_H,
	prefersReducedMotion,
} from "./scheduleBoardUtils";
import { extractOccurrences, type OccurrenceWithPlan, type VisitWithJob } from "./dashboardCalendarUtils";
import type { Job } from "../../../types/jobs";
import type { Technician } from "../../../types/technicians";
import { useUpdateJobVisitMutation } from "../../../hooks/useJobs";
import { useRescheduleOccurrenceMutation, useGenerateVisitFromOccurrenceMutation } from "../../../hooks/useRecurringPlans";
import VisitClickPopup from "./VisitClickPopup";
import { buildWeekTemplate } from "./weekTemplate";
import { weekParamToMonday, windowLabel } from "./stripWindow";
import ScheduleToolbar from "./ScheduleToolbar";
import { TOOLBAR_FOCUS } from "./toolbarButton";

interface ScheduleBoardProps {
	jobs: Job[];
	technicians: Technician[];
}

/** An occurrence with no specific time requirement – keyed off the arrival_constraint field. */
function isAnytimeOccurrence(occ: OccurrenceWithPlan): boolean {
	return occ.arrival_constraint === "anytime";
}

const GUTTER_W  = 64;
const HEADER_H  = 44;
// Until a column has been measured.
const FALLBACK_COL_W = 200;

function mondayOf(date: Date): Date {
	const monday = new Date(date);
	monday.setDate(date.getDate() - ((date.getDay() + 6) % 7));
	monday.setHours(0, 0, 0, 0);
	return monday;
}

function hourLabel(h: number): string {
	if (h === 0)  return "12 AM";
	if (h === 12) return "12 PM";
	return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

export default function ScheduleBoard({ jobs, technicians }: ScheduleBoardProps) {
	const navigate = useNavigate();
	const [viewMode, setViewMode] = useState<"week" | "month">("week");

	const [searchParams] = useSearchParams();

	// `?week=` is read once; later navigation does not rewrite the URL.
	const [link] = useState(() => {
		const day = searchParams.get("week");
		const monday = weekParamToMonday(day);
		if (!day || !monday) return null;
		return { day, monday: dateKeyAt(monday), zoom: searchParams.get("zoom") === "1" };
	});

	const [weekStart, setWeekStart] = useState<Date>(() => link?.monday ?? mondayOf(new Date()));

	// Seeded from the linked week so switching to Month stays on it.
	const [monthYear, setMonthYear] = useState<{ year: number; month: number }>(() => {
		const d = link?.monday ?? new Date();
		return { year: d.getFullYear(), month: d.getMonth() };
	});

	const [selectedTechs, setSelectedTechs] = useState<Set<string>>(new Set());
	const [showVisits, setShowVisits] = useState(true);
	const [showOccurrences, setShowOccurrences] = useState(true);
	const [anytimeOpen, setAnytimeOpen] = useState(false);
	const [colWidths, setColWidths] = useState<Record<string, number>>({});
	const [clickedAnytimeVisit, setClickedAnytimeVisit] = useState<{ visit: VisitWithJob; rect: DOMRect } | null>(null);
	const [scrollTop, setScrollTop] = useState(0);
	const [containerHeight, setContainerHeight] = useState(0);
	const [dragOverAnytimeDay, setDragOverAnytimeDay] = useState<string | null>(null);
	// `&zoom=1` (the dashboard's "open in schedule") enlarges the linked day on arrival.
	const [zoomedDay, setZoomedDay] = useState<string | null>(link?.zoom ? link.day : null);
	const [hoverDay, setHoverDay] = useState<string | null>(null);
	const [animateZoom, setAnimateZoom] = useState(false);
	const [scrollLeft, setScrollLeft] = useState(0);
	const [containerWidth, setContainerWidth] = useState(0);

	const scrollRef       = useRef<HTMLDivElement>(null);
	const anytimePopupRef = useRef<HTMLDivElement>(null);
	const anytimeRef      = useRef<HTMLDivElement>(null);
	const colRefs         = useRef<Map<string, HTMLDivElement>>(new Map());

	// -- Week-view scroll zone state/refs --------------------------------------
	const [weekScrollZone, setWeekScrollZone]         = useState<"left" | "right" | null>(null);
	const [weekScrollProgress, setWeekScrollProgress] = useState(0);
	const [isDraggingWeek, setIsDraggingWeek]         = useState(false);
	const weekTimeGridRef        = useRef<HTMLDivElement>(null);
	const weekScrollZoneRef      = useRef<"left" | "right" | null>(null);
	const weekScrollEnterTimeRef = useRef<number | null>(null);
	const weekScrollRafRef       = useRef<number | null>(null);
	const weekDragOriginRef      = useRef<Date | null>(null);
	const weekHasPendingPopupRef = useRef(false);
	const isDraggingWeekRef      = useRef(false);
	const weekDragOverTimerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);
	const weekStartRef           = useRef<Date>(new Date());

	const { mutateAsync: updateVisit } = useUpdateJobVisitMutation();
	const { mutateAsync: rescheduleOccurrence } = useRescheduleOccurrenceMutation();
	const { mutateAsync: generateVisitFromOccurrence } = useGenerateVisitFromOccurrenceMutation();

	// Track scroll container height for overflow pills
	useEffect(() => {
		if (!scrollRef.current) return;
		const ro = new ResizeObserver(() => {
			if (!scrollRef.current) return;
			setContainerHeight(scrollRef.current.clientHeight);
			setContainerWidth(scrollRef.current.clientWidth);
		});
		ro.observe(scrollRef.current);
		setContainerHeight(scrollRef.current.clientHeight);
		setContainerWidth(scrollRef.current.clientWidth);
		return () => ro.disconnect();
	}, []);


	// Auto-scroll to ~2 hours before current time on week-view mount
	useEffect(() => {
		if (viewMode !== "week" || !scrollRef.current) return;
		const now = new Date();
		const top = (now.getHours() + now.getMinutes() / 60) * SLOT_H;
		scrollRef.current.scrollTop = Math.max(0, top - 2 * SLOT_H);
	}, [viewMode]);

	// Close anytime popup on outside click
	useEffect(() => {
		if (!clickedAnytimeVisit) return;
		function handler(e: MouseEvent) {
			if (anytimePopupRef.current && !anytimePopupRef.current.contains(e.target as Node))
				setClickedAnytimeVisit(null);
		}
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [clickedAnytimeVisit]);

	const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart]);

	// Measure each day column: widths differ once a day is zoomed, and DayColumn's
	// overlap layout, ghost width and popup flip all key off its own width. Layout effect +
	// sync measure so a new week's first paint uses real widths, not a placeholder or a
	// stale zoomed width from a previous visit to that week.
	useLayoutEffect(() => {
		if (viewMode !== "week") return;
		const measured: Record<string, number> = {};
		colRefs.current.forEach((el, day) => {
			measured[day] = el.getBoundingClientRect().width;
		});
		setColWidths(measured);
		const ro = new ResizeObserver((entries) => {
			setColWidths((prev) => {
				let next = prev;
				for (const entry of entries) {
					const day = (entry.target as HTMLElement).dataset.day;
					if (!day || prev[day] === entry.contentRect.width) continue;
					if (next === prev) next = { ...prev };
					next[day] = entry.contentRect.width;
				}
				return next;
			});
		});
		colRefs.current.forEach((el) => ro.observe(el));
		return () => ro.disconnect();
	}, [weekDays, viewMode]);

	const todayStr = localDateKey(new Date());

	const globalTechOrder = useMemo(() => buildTechOrder(technicians), [technicians]);
	const techColorMap = useMemo(
		() => new Map(globalTechOrder.map((id, i) => [id, getTechColor(i)])),
		[globalTechOrder]
	);

	const isAllSelected = selectedTechs.size === 0;

	const allVisits: VisitWithJob[] = useMemo(
		() => jobs.flatMap((job_obj) => (job_obj.visits ?? []).map((v) => ({ ...v, job_obj }))),
		[jobs]
	);

	const filteredVisits = useMemo(() => {
		if (isAllSelected) return allVisits;
		return allVisits.filter((v) =>
			v.visit_techs?.some((vt) => selectedTechs.has(vt.tech_id))
		);
	}, [allVisits, selectedTechs, isAllSelected]);

	// Split anytime vs timed visits
	const anytimeVisits = useMemo(
		() => filteredVisits.filter((v) => v.arrival_constraint === "anytime"),
		[filteredVisits]
	);
	const timedVisits = useMemo(
		() => filteredVisits.filter((v) => v.arrival_constraint !== "anytime"),
		[filteredVisits]
	);

	const visitsByDay    = useMemo(() => groupVisitsByDay(timedVisits),   [timedVisits]);
	const anytimeByDay   = useMemo(() => groupVisitsByDay(anytimeVisits), [anytimeVisits]);

	// All planned occurrences – split into timed (time-grid) and anytime (midnight signal)
	const allOccs = useMemo(() => extractOccurrences(jobs), [jobs]);

	const timedOccurrencesByDay = useMemo(() =>
		allOccs.filter((o) => !isAnytimeOccurrence(o)).reduce((acc, occ) => {
			const dateStr = localDateKey(occ.occurrence_start_at);
			if (!acc[dateStr]) acc[dateStr] = [];
			acc[dateStr].push(occ);
			return acc;
		}, {} as Record<string, OccurrenceWithPlan[]>),
	[allOccs]);

	const anytimeOccurrencesByDay = useMemo(() =>
		allOccs.filter(isAnytimeOccurrence).reduce((acc, occ) => {
			const dateStr = localDateKey(occ.occurrence_start_at);
			if (!acc[dateStr]) acc[dateStr] = [];
			acc[dateStr].push(occ);
			return acc;
		}, {} as Record<string, OccurrenceWithPlan[]>),
	[allOccs]);

	// Now indicator – raw fractional hour (DAY_START = 0)
	const nowTop = useMemo(() => {
		const now = new Date();
		return (now.getHours() + now.getMinutes() / 60) * SLOT_H;
	}, []);

	// -- Navigation ------------------------------------------------------------

	function prevWeek() {
		setWeekStart((d) => { const n = new Date(d); n.setDate(d.getDate() - 7); return n; });
	}
	function nextWeek() {
		setWeekStart((d) => { const n = new Date(d); n.setDate(d.getDate() + 7); return n; });
	}
	function prevMonth() {
		setMonthYear(({ year, month }) =>
			month === 0 ? { year: year - 1, month: 11 } : { year, month: month - 1 }
		);
	}
	function nextMonth() {
		setMonthYear(({ year, month }) =>
			month === 11 ? { year: year + 1, month: 0 } : { year, month: month + 1 }
		);
	}
	function goToday() {
		const today = new Date();
		setWeekStart(mondayOf(today));
		setMonthYear({ year: today.getFullYear(), month: today.getMonth() });
		// Also scroll to now
		if (scrollRef.current) {
			const top = (today.getHours() + today.getMinutes() / 60) * SLOT_H;
			scrollRef.current.scrollTop = Math.max(0, top - 2 * SLOT_H);
		}
	}

	function scrollToY(y: number) {
		if (scrollRef.current) scrollRef.current.scrollTop = Math.max(0, y);
	}

	// -- Week-view scroll zone helpers -----------------------------------------

	// Keep weekStartRef current so mount-only document handlers have fresh weekStart
	useEffect(() => { weekStartRef.current = weekStart; }, [weekStart]);

	// Zoom belongs to a date, not a weekday, so a week change drops it — during render, so
	// the new week never commits with the old zoom. Keyed on time: Today on the current
	// week builds a new Date for the same Monday and must keep the zoom.
	const weekKey = weekStart.getTime();
	const [zoomWeekKey, setZoomWeekKey] = useState(weekKey);
	if (zoomWeekKey !== weekKey) {
		setZoomWeekKey(weekKey);
		setZoomedDay(null);
		setAnimateZoom(false);
	}

	function toggleZoom(dateStr: string) {
		setAnimateZoom(true);
		setZoomedDay((d) => (d === dateStr ? null : dateStr));
	}

	const reducedMotion = useMemo(prefersReducedMotion, []);
	// Only a user toggle animates; a week change must snap rather than tween the old zoom away.
	const gridTransition =
		animateZoom && !reducedMotion ? "grid-template-columns 180ms ease-out" : undefined;

	// Document-level drag tracking (mount only – uses refs, no stale closures)
	useEffect(() => {
		function onDragStart(e: DragEvent) {
			const inTimeGrid = weekTimeGridRef.current?.contains(e.target as Node);
			const inAnytime  = anytimeRef.current?.contains(e.target as Node);
			if (!inTimeGrid && !inAnytime) return;
			weekDragOriginRef.current = weekStartRef.current;
			isDraggingWeekRef.current = true;
			setIsDraggingWeek(true);
		}
		function onDragOver() {
			if (!isDraggingWeekRef.current) return;
			if (weekDragOverTimerRef.current) clearTimeout(weekDragOverTimerRef.current);
			weekDragOverTimerRef.current = setTimeout(() => {
				isDraggingWeekRef.current = false;
				setIsDraggingWeek(false);
				clearWeekScrollZone();
				if (!weekHasPendingPopupRef.current) restoreOriginWeek();
			}, 150);
		}
		document.addEventListener("dragstart", onDragStart);
		document.addEventListener("dragover", onDragOver);
		return () => {
			document.removeEventListener("dragstart", onDragStart);
			document.removeEventListener("dragover", onDragOver);
			if (weekDragOverTimerRef.current) clearTimeout(weekDragOverTimerRef.current);
			if (weekScrollRafRef.current) cancelAnimationFrame(weekScrollRafRef.current);
		};
	}, []); // mount only

	function startWeekScrollRaf() {
		if (weekScrollRafRef.current) return;
		function tick() {
			const enterTime = weekScrollEnterTimeRef.current;
			const zone = weekScrollZoneRef.current;
			if (!enterTime || !zone) { weekScrollRafRef.current = null; return; }
			const progress = Math.min(1, (Date.now() - enterTime) / SCROLL_DELAY_MS);
			setWeekScrollProgress(progress);
			if (progress >= 1) {
				if (zone === "left") prevWeek(); else nextWeek();
				weekScrollEnterTimeRef.current = Date.now();
			}
			weekScrollRafRef.current = requestAnimationFrame(tick);
		}
		weekScrollRafRef.current = requestAnimationFrame(tick);
	}

	function stopWeekScrollRaf() {
		if (weekScrollRafRef.current) { cancelAnimationFrame(weekScrollRafRef.current); weekScrollRafRef.current = null; }
	}

	function clearWeekScrollZone() {
		setWeekScrollZone(null);
		weekScrollZoneRef.current = null;
		weekScrollEnterTimeRef.current = null;
		stopWeekScrollRaf();
		setWeekScrollProgress(0);
	}

	function restoreOriginWeek() {
		if (weekDragOriginRef.current) setWeekStart(weekDragOriginRef.current);
		weekDragOriginRef.current = null;
		weekHasPendingPopupRef.current = false;
	}

	function handleWeekGridDragOver(e: React.DragEvent<HTMLDivElement>) {
		// Zones key off the visible viewport, not the grid: a zoomed day can make the
		// grid wider than the board, which would push the right zone off-screen.
		const viewport = scrollRef.current;
		if (!viewport || !isDraggingWeekRef.current) return;
		const x = e.clientX - viewport.getBoundingClientRect().left;
		const newZone: "left" | "right" | null =
			x > GUTTER_W && x < GUTTER_W + SCROLL_ZONE_W ? "left"
			: x > viewport.clientWidth - SCROLL_ZONE_W ? "right"
			: null;
		if (newZone !== weekScrollZoneRef.current) {
			weekScrollZoneRef.current = newZone;
			setWeekScrollZone(newZone);
			if (newZone) {
				weekScrollEnterTimeRef.current = Date.now();
				startWeekScrollRaf();
			} else {
				weekScrollEnterTimeRef.current = null;
				stopWeekScrollRaf();
				setWeekScrollProgress(0);
			}
		}
	}

	function handleWeekGridDragLeave(e: React.DragEvent<HTMLDivElement>) {
		const rect = weekTimeGridRef.current?.getBoundingClientRect();
		if (!rect) return;
		const { clientX: x, clientY: y } = e;
		if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
			clearWeekScrollZone();
		}
	}

	// Clears scroll zone when leaving the anytime section – but NOT if the pointer
	// moved into the time grid below (so dragging down doesn't flicker the zone).
	function handleAnytimeSectionDragLeave(e: React.DragEvent<HTMLDivElement>) {
		const anytimeRect  = anytimeRef.current?.getBoundingClientRect();
		const gridRect     = weekTimeGridRef.current?.getBoundingClientRect();
		if (!anytimeRect) return;
		const { clientX: x, clientY: y } = e;
		const inAnytime = x >= anytimeRect.left && x <= anytimeRect.right && y >= anytimeRect.top && y <= anytimeRect.bottom;
		const inGrid    = gridRect && x >= gridRect.left && x <= gridRect.right && y >= gridRect.top && y <= gridRect.bottom;
		if (!inAnytime && !inGrid) clearWeekScrollZone();
	}

	// -- Anytime drag/drop ----------------------------------------------------

	function handleAnytimeDragStart(e: React.DragEvent, visit: VisitWithJob) {
		setSharedDragOffset(0);
		// stopPropagation on child dragstart blocks the document-level handler, so
		// activate the week-scroll state here directly instead.
		weekDragOriginRef.current = weekStartRef.current;
		isDraggingWeekRef.current = true;
		setIsDraggingWeek(true);
		const startMs = new Date(visit.scheduled_start_at).getTime();
		const endMs   = new Date(visit.scheduled_end_at).getTime();
		e.dataTransfer.setData(
			"text/plain",
			JSON.stringify({
				type: "visit",
				visitId: visit.id,
				jobId: visit.job_obj.id,
				durationMs: endMs - startMs,
				startMs,
				arrival_constraint: "anytime",
				arrival_time: null,
				arrival_window_start: null,
				arrival_window_end: null,
			})
		);
		e.dataTransfer.effectAllowed = "move";
	}

	function handleAnytimeOccurrenceDragStart(e: React.DragEvent, occ: OccurrenceWithPlan) {
		setSharedDragOffset(0);
		// Same as above – set scroll state explicitly because stopPropagation prevents
		// the document-level dragstart listener from running.
		weekDragOriginRef.current = weekStartRef.current;
		isDraggingWeekRef.current = true;
		setIsDraggingWeek(true);
		const startMs = new Date(occ.occurrence_start_at).getTime();
		const endMs   = new Date(occ.occurrence_end_at).getTime();
		e.dataTransfer.setData(
			"text/plain",
			JSON.stringify({
				type: "occurrence",
				occurrenceId: occ.id,
				jobId: occ.job_obj.id,
				durationMs: Math.max(endMs - startMs, 3_600_000),
				startMs,
			})
		);
		e.dataTransfer.effectAllowed = "move";
	}

	function handleAnytimeCellDragOver(e: React.DragEvent, dateStr: string) {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		setDragOverAnytimeDay(dateStr);
	}

	function handleAnytimeCellDragLeave(e: React.DragEvent) {
		// Only clear if leaving the cell entirely (not entering a child)
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const { clientX: x, clientY: y } = e;
		if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
			setDragOverAnytimeDay(null);
		}
	}

	async function handleAnytimeCellDrop(e: React.DragEvent, targetDateStr: string) {
		e.preventDefault();
		setDragOverAnytimeDay(null);
		const raw = e.dataTransfer.getData("text/plain");
		if (!raw) return;
		const parsed = JSON.parse(raw) as {
			type?: string;
			visitId?: string;
			occurrenceId?: string;
			jobId?: string;
			arrival_constraint?: string;
			durationMs: number;
		};

		const newStart = dateKeyAt(targetDateStr);
		if (parsed.type === "occurrence") {
			weekHasPendingPopupRef.current = true;
			try {
				await rescheduleOccurrence({
					occurrenceId: parsed.occurrenceId!,
					jobId: parsed.jobId!,
					input: { new_start_at: newStart.toISOString() },
				});
				weekDragOriginRef.current = null;
				weekHasPendingPopupRef.current = false;
			} catch {
				weekHasPendingPopupRef.current = false;
			}
			return;
		}

		if (parsed.type !== "visit") return;
		const newEnd   = new Date(newStart.getTime() + Math.max(parsed.durationMs, 3_600_000));
		const data: Parameters<typeof updateVisit>[0]["data"] = {
			scheduled_start_at: newStart.toISOString(),
			scheduled_end_at: newEnd.toISOString(),
			arrival_constraint: "anytime",
			arrival_time: null,
			arrival_window_start: null,
			arrival_window_end: null,
		};
		// Converting from a timed constraint ? also reset finish to when_done
		if (parsed.arrival_constraint !== "anytime") {
			data.finish_constraint = "when_done";
			data.finish_time = null;
		}
		weekHasPendingPopupRef.current = true;
		try {
			await updateVisit({ id: parsed.visitId!, data });
			weekDragOriginRef.current = null;
			weekHasPendingPopupRef.current = false;
		} catch {
			weekHasPendingPopupRef.current = false;
		}
	}

	// -- Labels ----------------------------------------------------------------

	const weekLabel = useMemo(() => windowLabel(weekDays, "full"), [weekDays]);

	const monthLabel = useMemo(() =>
		new Date(monthYear.year, monthYear.month, 1).toLocaleDateString("en-US", {
			month: "long", year: "numeric",
		}),
		[monthYear]
	);

	const totalSlots = DAY_END - DAY_START; // 24

	// -- Anytime popup positioning ---------------------------------------------

	function getAnytimePopupPos(rect: DOMRect) {
		return getAnchoredPopupPos(
			{ left: rect.left, right: rect.right, top: rect.bottom + 4 },
			{ popupH: CLICK_POPUP_H }
		);
	}

	// -- Grid column template --------------------------------------------------

	const { gridTemplateColumns, gridMinWidth } = buildWeekTemplate(weekDays, zoomedDay, GUTTER_W);

	return (
		<div className="flex flex-col h-full bg-canvas text-text-primary select-none">

			<ScheduleToolbar
				periodLabel={viewMode === "week" ? weekLabel : monthLabel}
				prevLabel={viewMode === "week" ? "Previous week" : "Previous month"}
				nextLabel={viewMode === "week" ? "Next week" : "Next month"}
				onToday={goToday}
				onPrev={viewMode === "week" ? prevWeek : prevMonth}
				onNext={viewMode === "week" ? nextWeek : nextMonth}
				viewMode={viewMode}
				onViewModeChange={setViewMode}
				showVisits={showVisits}
				onToggleVisits={() => setShowVisits((v) => !v)}
				showOccurrences={showOccurrences}
				onToggleOccurrences={() => setShowOccurrences((v) => !v)}
				techFilter={
					<TechFilter
						technicians={technicians}
						selected={selectedTechs}
						onChange={setSelectedTechs}
						techColorMap={techColorMap}
					/>
				}
			/>

			{/* -- Month View ----------------------------------------------------- */}
			{viewMode === "month" && (
				<div className="flex-1 overflow-auto">
					<MonthGrid
						year={monthYear.year}
						month={monthYear.month}
						todayStr={todayStr}
						visitsByDay={visitsByDay}
						occurrencesByDay={timedOccurrencesByDay}
						showVisits={showVisits}
						showOccurrences={showOccurrences}
						technicians={technicians}
						techColorMap={techColorMap}
						selectedTechs={selectedTechs}
						isAllSelected={isAllSelected}
						updateVisit={updateVisit}
						rescheduleOccurrence={rescheduleOccurrence}
						generateVisitFromOccurrence={generateVisitFromOccurrence}
						onPrevMonth={prevMonth}
						onNextMonth={nextMonth}
						currentMonthYear={monthYear}
						onRestoreMonthYear={setMonthYear}
					/>
				</div>
			)}

			{/* -- Week View ------------------------------------------------------ */}
			{viewMode === "week" && (
				<div ref={scrollRef} className="flex-1 overflow-auto" onScroll={(e) => {
					setScrollTop(e.currentTarget.scrollTop);
					setScrollLeft(e.currentTarget.scrollLeft);
				}}>
				<div
					// The header row is separate from the body rows, so hover is resolved by x.
					onMouseMove={(e) => {
						const hit = Array.from(
							e.currentTarget.querySelectorAll<HTMLElement>("[data-day-header]")
						).find((h) => {
							const r = h.getBoundingClientRect();
							return e.clientX >= r.left && e.clientX < r.right;
						});
						const day = hit?.dataset.dayHeader ?? null;
						if (day !== hoverDay) setHoverDay(day);
					}}
					onMouseLeave={() => setHoverDay(null)}
					style={{ minWidth: gridMinWidth, position: "relative" }}
				>

					{/* Sticky day-header row */}
					<div
						style={{
							display: "grid",
							gridTemplateColumns,
							transition: gridTransition,
							height: HEADER_H,
							position: "sticky",
							top: 0,
							borderBottom: "1px solid var(--color-grid-line-strong)",
							backgroundColor: "var(--color-canvas)",
							zIndex: 30,
						}}
					>
						{/* Gutter header cell */}
						<div style={{ borderRight: "1px solid var(--color-grid-line-strong)" }} />
						{weekDays.map((dateStr) => (
							<DayHeaderCell
								key={dateStr}
								dateStr={dateStr}
								isToday={dateStr === todayStr}
								isZoomed={dateStr === zoomedDay}
								height={HEADER_H}
								onToggleZoom={() => toggleZoom(dateStr)}
								revealZoom={dateStr === hoverDay}
								style={{ borderLeft: "1px solid var(--color-grid-line-strong)" }}
							/>
						))}
					</div>

					{/* Anytime section */}
					{showVisits && (
						<div
							ref={anytimeRef}
							id="anytime-row"
							role="group"
							aria-label="Anytime visits"
							onDragOver={handleWeekGridDragOver}
							onDragLeave={handleAnytimeSectionDragLeave}
							style={{
								display: "grid",
								gridTemplateColumns,
								transition: gridTransition,
								position: "sticky",
								top: HEADER_H,
								borderBottom: "1px solid var(--color-grid-line-strong)",
								backgroundColor: "var(--color-canvas)",
								zIndex: 20,
							}}
						>
							{/* Anytime toggle — the whole gutter cell is the control */}
							<button
								type="button"
								onClick={() => setAnytimeOpen((v) => !v)}
								aria-expanded={anytimeOpen}
								aria-controls="anytime-row"
								className={`flex justify-end w-full pr-1.5 text-[9px] font-semibold text-text-tertiary hover:bg-surface hover:text-text-secondary transition-colors duration-150 ${TOOLBAR_FOCUS} focus-visible:ring-inset ${
									anytimeOpen ? "items-start pt-1.5" : "items-center"
								}`}
								style={{ borderRight: "1px solid var(--color-grid-line-strong)" }}
							>
								<span className="flex items-center gap-[3px]">
									Anytime
									<ChevronDown
										size={11}
										aria-hidden
										className={`transition-transform duration-150 ease-out ${anytimeOpen ? "rotate-180" : ""}`}
									/>
								</span>
							</button>

							{/* Per-day anytime cells */}
							{weekDays.map((dateStr) => {
								const dayVisits = (anytimeByDay[dateStr] ?? []) as VisitWithJob[];
								const dayOccs   = showOccurrences ? (anytimeOccurrencesByDay[dateStr] ?? []) : [];
								const totalCount = dayVisits.length + dayOccs.length;
								return (
									<div
										key={dateStr}
										onDragOver={(e) => handleAnytimeCellDragOver(e, dateStr)}
										onDragLeave={handleAnytimeCellDragLeave}
										onDrop={(e) => handleAnytimeCellDrop(e, dateStr)}
										style={{
											borderLeft: "1px solid var(--color-grid-line-strong)",
											padding: "4px 5px",
											minHeight: anytimeOpen ? undefined : 28,
											outline: dragOverAnytimeDay === dateStr ? "2px solid var(--color-primary)" : undefined,
											outlineOffset: -2,
											transition: "outline 0.1s",
										}}
									>
										{!anytimeOpen ? (
											/* Collapsed: first item (visit preferenced) + overflow count */
											totalCount > 0 ? (() => {
												const hasVisit = dayVisits.length > 0;
												return (
													<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
														{hasVisit ? (() => {
															const first = dayVisits[0];
															const firstTechId = first.visit_techs?.[0]?.tech_id;
															const firstTechColor = (firstTechId ? techColorMap.get(firstTechId) : undefined) ?? "var(--color-tech-unassigned)";
															return (
																<button
																	draggable
																	onDragStart={(e) => { e.stopPropagation(); handleAnytimeDragStart(e, first); }}
																	onClick={(e) => {
																		e.stopPropagation();
																		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
																		setClickedAnytimeVisit((prev) =>
																			prev?.visit.id === first.id ? null : { visit: first, rect }
																		);
																	}}
																	style={{
																		display: "flex",
																		alignItems: "center",
																		gap: 4,
																		padding: "3px 5px",
																		borderRadius: 4,
																		backgroundColor: `${firstTechColor}22`,
																		border: `1px solid ${firstTechColor}55`,
																		cursor: "pointer",
																		textAlign: "left",
																		width: "100%",
																	}}
																>
																	<span style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: getPriorityColor(first.job_obj?.priority), flexShrink: 0 }} />
																	<span style={{
																		display: "-webkit-box",
																		WebkitBoxOrient: "vertical",
																		WebkitLineClamp: 2,
																		overflow: "hidden",
																		wordBreak: "break-word",
																		fontSize: 9,
																		color: "var(--color-text-on-surface)",
																		flex: 1,
																		textAlign: "left",
																		lineHeight: 1.4,
																	} as React.CSSProperties}>
																		{first.job_obj?.name ?? "Visit"}
																	</span>
																	<div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
																		{(first.visit_techs ?? []).slice(0, 4).map((vt) => {
																			const tc = techColorMap.get(vt.tech_id) ?? "var(--color-tech-unassigned)";
																			const inf = isAllSelected || selectedTechs.has(vt.tech_id);
																			return (
																				<span key={vt.tech_id} style={{
																					display: "block",
																					width: 6,
																					height: 6,
																					borderRadius: "50%",
																					flexShrink: 0,
																					backgroundColor: tc,
																					opacity: inf ? 1 : 0.35,
																				}} />
																			);
																		})}
																	</div>
																</button>
															);
														})() : (() => {
															const first = dayOccs[0];
															return (
																<button
																	draggable
																	onDragStart={(e) => { e.stopPropagation(); handleAnytimeOccurrenceDragStart(e, first); }}
																	style={{
																		display: "flex",
																		alignItems: "center",
																		gap: 4,
																		padding: "3px 5px",
																		borderRadius: 4,
																		backgroundColor: "var(--color-occurrence-bg)",
																		border: "1px solid var(--color-occurrence-border)",
																		cursor: "grab",
																		textAlign: "left",
																		width: "100%",
																	}}
																>
																	<span style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: getPriorityColor(first.job_obj?.priority), flexShrink: 0 }} />
																	<span style={{
																		display: "-webkit-box",
																		WebkitBoxOrient: "vertical",
																		WebkitLineClamp: 2,
																		overflow: "hidden",
																		wordBreak: "break-word",
																		fontSize: 9,
																		color: "var(--color-sched-occurrence-title)",
																		flex: 1,
																		textAlign: "left",
																		lineHeight: 1.4,
																	} as React.CSSProperties}>
																		{first.job_obj?.name ?? "Recurring"}
																	</span>
																</button>
															);
														})()}
														{totalCount > 1 && (
															<button
																onClick={() => setAnytimeOpen(true)}
																style={{ fontSize: 9, color: "var(--color-text-muted)", background: "none", border: "none", cursor: "pointer", textAlign: "left", padding: "0 2px", transition: "color 0.1s" }}
																onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--color-text-tertiary)"; }}
																onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = "var(--color-text-muted)"; }}
															>
																+{totalCount - 1} more
															</button>
														)}
													</div>
												);
											})() : null
										) : (
											/* Expanded: all visit chips then all occurrence chips */
											<div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3 }}>
												{dayVisits.map((visit) => {
													const firstTechId = visit.visit_techs?.[0]?.tech_id;
													const firstTechColor = (firstTechId ? techColorMap.get(firstTechId) : undefined) ?? "var(--color-tech-unassigned)";
													return (
														<button
															key={visit.id}
															draggable
															onDragStart={(e) => { e.stopPropagation(); handleAnytimeDragStart(e, visit); }}
															onClick={(e) => {
																e.stopPropagation();
																const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
																setClickedAnytimeVisit((prev) =>
																	prev?.visit.id === visit.id ? null : { visit, rect }
																);
															}}
															style={{
																display: "flex",
																alignItems: "center",
																gap: 4,
																padding: "3px 5px",
																borderRadius: 4,
																backgroundColor: `${firstTechColor}22`,
																border: `1px solid ${firstTechColor}55`,
																cursor: "pointer",
																textAlign: "left",
																width: "100%",
															}}
														>
															<span style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: getPriorityColor(visit.job_obj?.priority), flexShrink: 0 }} />
															<span style={{
																display: "-webkit-box",
																WebkitBoxOrient: "vertical",
																WebkitLineClamp: 2,
																overflow: "hidden",
																wordBreak: "break-word",
																fontSize: 9,
																color: "var(--color-text-on-surface)",
																flex: 1,
																textAlign: "left",
																lineHeight: 1.4,
															} as React.CSSProperties}>
																{visit.job_obj?.name ?? "Visit"}
															</span>
															<div style={{ display: "flex", alignItems: "center", gap: 2, flexShrink: 0 }}>
																{(visit.visit_techs ?? []).slice(0, 4).map((vt) => {
																	const tc = techColorMap.get(vt.tech_id) ?? "var(--color-tech-unassigned)";
																	const inf = isAllSelected || selectedTechs.has(vt.tech_id);
																	return (
																		<span key={vt.tech_id} style={{
																			display: "block",
																			width: 6,
																			height: 6,
																			borderRadius: "50%",
																			flexShrink: 0,
																			backgroundColor: tc,
																			opacity: inf ? 1 : 0.35,
																		}} />
																	);
																})}
															</div>
														</button>
													);
												})}
												{dayOccs.map((occ) => (
													<button
														key={occ.id}
														draggable
														onDragStart={(e) => { e.stopPropagation(); handleAnytimeOccurrenceDragStart(e, occ); }}
														style={{
															display: "flex",
															alignItems: "center",
															gap: 4,
															padding: "3px 5px",
															borderRadius: 4,
															backgroundColor: "var(--color-occurrence-bg)",
															border: "1px solid var(--color-occurrence-border)",
															cursor: "grab",
															textAlign: "left",
															width: "100%",
														}}
													>
														<span style={{ width: 4, height: 4, borderRadius: "50%", backgroundColor: getPriorityColor(occ.job_obj?.priority), flexShrink: 0 }} />
														<span style={{
															display: "-webkit-box",
															WebkitBoxOrient: "vertical",
															WebkitLineClamp: 2,
															overflow: "hidden",
															wordBreak: "break-word",
															fontSize: 9,
															color: "var(--color-sched-occurrence-title)",
															flex: 1,
															textAlign: "left",
															lineHeight: 1.4,
														} as React.CSSProperties}>
															{occ.job_obj?.name ?? "Recurring"}
														</span>
													</button>
												))}
												{totalCount === 0 && (
													<span style={{ fontSize: 9, color: "var(--color-text-faint)" }}>–</span>
												)}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}

					{/* Time grid */}
					<div
						ref={weekTimeGridRef}
						style={{
							display: "grid",
							gridTemplateColumns,
							transition: gridTransition,
							height: totalSlots * SLOT_H,
							position: "relative",
						}}
						onDragOver={handleWeekGridDragOver}
						onDragLeave={handleWeekGridDragLeave}
					>
							{/* Time gutter – sticky left */}
							<div
								style={{
									position: "sticky",
									left: 0,
									zIndex: 10,
									backgroundColor: "var(--color-canvas)",
									borderRight: "1px solid var(--color-grid-line-strong)",
									height: totalSlots * SLOT_H,
								}}
							>
								{Array.from({ length: totalSlots }, (_, i) => (
									<div
										key={i}
										style={{
											position: "absolute",
											top: i === 0 ? 4 : i * SLOT_H - 8,
											left: 0,
											right: 6,
											fontSize: 10,
											color: "var(--color-text-muted)",
											lineHeight: 1,
											userSelect: "none",
											textAlign: "right",
										}}
									>
										{hourLabel(DAY_START + i)}
									</div>
								))}
								{/* Bottom 12 AM label */}
								<div
									style={{
										position: "absolute",
										top: totalSlots * SLOT_H - 8,
										left: 0,
										right: 6,
										fontSize: 10,
										color: "var(--color-text-muted)",
										lineHeight: 1,
										userSelect: "none",
										textAlign: "right",
									}}
								>
									12 AM
								</div>
							</div>

							{/* Day columns */}
							{weekDays.map((dateStr, dayIndex) => {
								const dayVisits     = (visitsByDay[dateStr] ?? []) as VisitWithJob[];
								const dayOccurrences = timedOccurrencesByDay[dateStr] ?? [];
								const isToday = dateStr === todayStr;
								return (
									<div
										key={dateStr}
										data-day={dateStr}
										ref={(el) => {
											if (el) colRefs.current.set(dateStr, el);
											else colRefs.current.delete(dateStr);
										}}
										style={{ position: "relative" }}
									>
										<ScheduleBoardDayColumn
											dateStr={dateStr}
											dayIndex={dayIndex}
											isToday={isToday}
											visits={dayVisits}
											occurrences={dayOccurrences}
											showVisits={showVisits}
											showOccurrences={showOccurrences}
											technicians={technicians}
											techColorMap={techColorMap}
											colWidth={colWidths[dateStr] || FALLBACK_COL_W}
											selectedTechs={selectedTechs}
											isAllSelected={isAllSelected}
											updateVisit={updateVisit}
											rescheduleOccurrence={rescheduleOccurrence}
											generateVisitFromOccurrence={generateVisitFromOccurrence}
											scrollTop={scrollTop}
											visibleHeight={Math.max(0, containerHeight - HEADER_H - (showVisits && anytimeRef.current ? anytimeRef.current.offsetHeight : 0))}
											onScrollToY={scrollToY}
											onDropHandled={() => { weekHasPendingPopupRef.current = true; }}
											onRescheduleConfirmed={() => { weekDragOriginRef.current = null; weekHasPendingPopupRef.current = false; }}
										/>
										{isToday && (
											<>
												<div
													style={{
														position: "absolute",
														top: nowTop,
														left: 0,
														right: 0,
														height: 2,
														backgroundColor: "var(--color-error)",
														zIndex: 3,
														pointerEvents: "none",
													}}
												/>
												<div
													style={{
														position: "absolute",
														top: nowTop - 4,
														left: -4,
														width: 10,
														height: 10,
														borderRadius: "50%",
														backgroundColor: "var(--color-error)",
														zIndex: 3,
														pointerEvents: "none",
													}}
												/>
											</>
										)}
									</div>
								);
							})}

					</div>

				{/* Left week scroll zone – positioned at the grid wrapper so it spans the
				    anytime sticky section + time grid (zIndex 25 clears sticky z-index 20) */}
				<div aria-hidden data-scroll-zone="left" style={{
					position: "absolute", left: scrollLeft + GUTTER_W, top: 0, bottom: 0, width: SCROLL_ZONE_W,
					pointerEvents: "none", opacity: isDraggingWeek ? 1 : 0, transition: "opacity 0.3s ease",
					overflow: "hidden", zIndex: 25,
				}}>
					<div style={{ position: "absolute", inset: 0, background: "linear-gradient(to right, rgba(59,130,246,0.22), transparent)" }} />
					{weekScrollZone === "left" && (
						<div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: `${weekScrollProgress * 100}%`,
							background: "linear-gradient(to right, rgba(59,130,246,0.6) 0%, rgba(59,130,246,0.18) 100%)" }} />
					)}
					{weekScrollZone === "left" && weekScrollProgress > 0 && (
						<div style={{ position: "absolute", top: 0, bottom: 0,
							left: `calc(${weekScrollProgress * 100}% - 2px)`, width: 2,
							background: "var(--color-primary)", boxShadow: "0 0 6px rgba(59,130,246,0.7)" }} />
					)}
					{weekScrollZone === "left" && (
						<div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: 1, background: "rgba(59,130,246,0.55)" }} />
					)}
					<div style={{ position: "absolute", top: "50%", left: 6, transform: "translateY(-50%)",
						color: `rgba(147,197,253,${0.4 + (weekScrollZone === "left" ? weekScrollProgress * 0.6 : 0)})`,
						fontSize: 16, fontWeight: 700, lineHeight: 1, userSelect: "none" }}>–</div>
				</div>

				{/* Right week scroll zone */}
				<div aria-hidden data-scroll-zone="right" style={{
					position: "absolute", top: 0, bottom: 0, width: SCROLL_ZONE_W,
					...(containerWidth ? { left: scrollLeft + containerWidth - SCROLL_ZONE_W } : { right: 0 }),
					pointerEvents: "none", opacity: isDraggingWeek ? 1 : 0, transition: "opacity 0.3s ease",
					overflow: "hidden", zIndex: 25,
				}}>
					<div style={{ position: "absolute", inset: 0, background: "linear-gradient(to left, rgba(59,130,246,0.22), transparent)" }} />
					{weekScrollZone === "right" && (
						<div style={{ position: "absolute", top: 0, bottom: 0, right: 0, width: `${weekScrollProgress * 100}%`,
							background: "linear-gradient(to left, rgba(59,130,246,0.6) 0%, rgba(59,130,246,0.18) 100%)" }} />
					)}
					{weekScrollZone === "right" && weekScrollProgress > 0 && (
						<div style={{ position: "absolute", top: 0, bottom: 0,
							right: `calc(${weekScrollProgress * 100}% - 2px)`, width: 2,
							background: "var(--color-primary)", boxShadow: "0 0 6px rgba(59,130,246,0.7)" }} />
					)}
					{weekScrollZone === "right" && (
						<div style={{ position: "absolute", top: 0, bottom: 0, left: 0, width: 1, background: "rgba(59,130,246,0.55)" }} />
					)}
					<div style={{ position: "absolute", top: "50%", right: 6, transform: "translateY(-50%)",
						color: `rgba(147,197,253,${0.4 + (weekScrollZone === "right" ? weekScrollProgress * 0.6 : 0)})`,
						fontSize: 16, fontWeight: 700, lineHeight: 1, userSelect: "none" }}>–</div>
				</div>
			</div>
		</div>
		)}

			{/* Anytime visit detail popup */}
			{clickedAnytimeVisit && (() => {
				const v   = clickedAnytimeVisit.visit;
				const pos = getAnytimePopupPos(clickedAnytimeVisit.rect);
				return (
					<VisitClickPopup
						visit={v}
						style={{ position: "fixed", top: pos.top, left: pos.left }}
						technicians={technicians}
						techColorMap={techColorMap}
						popupRef={anytimePopupRef}
						onClose={() => setClickedAnytimeVisit(null)}
						onViewVisit={() => { setClickedAnytimeVisit(null); navigate(`/dispatch/jobs/${v.job_obj.id}/visits/${v.id}`); }}
						onViewJob={() => { setClickedAnytimeVisit(null); navigate(`/dispatch/jobs/${v.job_obj.id}`); }}
					/>
				);
			})()}
	</div>
	);
}
