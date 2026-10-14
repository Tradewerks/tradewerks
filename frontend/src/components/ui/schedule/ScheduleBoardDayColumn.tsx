import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import ScheduleBoardCard from "./ScheduleBoardCard";
import type { AssignedTech } from "./cardModel";
import { toCardModel } from "./cardModel";
import VisitClickPopup from "./VisitClickPopup";
import OccurrenceClickPopup from "./OccurrenceClickPopup";
import ReschedulePopup from "./ReschedulePopup";
import OccurrenceReschedulePopup from "./OccurrenceReschedulePopup";
import {
	resolveOverlapLayout,
	calcCardTop,
	calcCardHeight,
	visitSpan,
	visitDropUpdate,
	visitDropLabel,
	occurrenceDropLabel,
	shiftConstraintTimes,
	occurrenceSpan,
	cardSpan,
	visitConstraintTimeLabel,
	getPriorityColor,
	getAnchoredPopupPos,
	localDateKey,
	minutesOfDay,
	dateKeyAt,
	CLICK_POPUP_H,
	SLOT_H,
	DAY_START,
	DAY_END,
	LEFT_PAD,
	RIGHT_PAD,
	type VisitDragPayload,
} from "./scheduleBoardUtils";
import type { UpdateJobVisitInput } from "../../../types/jobs";
import type { Technician } from "../../../types/technicians";
import type { OccurrenceWithPlan, VisitWithJob } from "./dashboardCalendarUtils";
import type { RescheduleOccurrenceInput, VisitGenerationResult } from "../../../types/recurringPlans";
import { useVehicleStockConflictsQuery } from "../../../hooks/useVehicleStock";
import { getSharedDragOffset, setSharedDragOffset } from "./scheduleBoardDragState";

// Shared across all column instances — only one drag is ever active at a time.
let sharedDraggedVisit: VisitWithJob | null = null;
let sharedDraggedOccurrence: OccurrenceWithPlan | null = null;

// ── Pending drag confirmation state ──────────────────────────────────────────

interface PendingDrop {
	type: "visit" | "occurrence";
	id: string;
	jobId: string;
	isRecurring: boolean;
	entityName: string;
	oldTimeLabel: string;
	newTimeLabel: string;
	priorityColor: string;
	visitObj?: VisitWithJob;
	occurrenceObj?: OccurrenceWithPlan;
	updateData?: UpdateJobVisitInput;
	occurrenceInput?: RescheduleOccurrenceInput;
	clientX: number;
	clientY: number;
}

// ── Pending click-triggered reschedule state ──────────────────────────────────

interface PendingClickReschedule {
	type: "visit" | "occurrence";
	visit?: VisitWithJob;
	occurrence?: OccurrenceWithPlan;
	anchorRect: DOMRect;
}

// ─────────────────────────────────────────────────────────────────────────────

interface ScheduleBoardDayColumnProps {
	dateStr: string;
	dayIndex: number;
	isToday: boolean;
	visits: VisitWithJob[];
	occurrences: OccurrenceWithPlan[];
	showVisits: boolean;
	showOccurrences: boolean;
	technicians: Technician[];
	techColorMap: Map<string, string>;
	colWidth: number;
	selectedTechs: Set<string>;
	isAllSelected: boolean;
	updateVisit: (args: { id: string; data: UpdateJobVisitInput }) => Promise<unknown>;
	rescheduleOccurrence: (args: { occurrenceId: string; jobId: string; input: RescheduleOccurrenceInput }) => Promise<unknown>;
	generateVisitFromOccurrence: (args: { occurrenceId: string; jobId: string }) => Promise<VisitGenerationResult>;
	scrollTop: number;
	visibleHeight: number;
	onScrollToY: (y: number) => void;
	onDropHandled?: () => void;
	onRescheduleConfirmed?: () => void;
}

function snapTo15Min(totalMinutes: number): number {
	return Math.round(totalMinutes / 15) * 15;
}

function minutesToLabel(mins: number): string {
	const h = Math.floor(mins / 60);
	const m = mins % 60;
	const period = h >= 12 ? "PM" : "AM";
	const displayH = h % 12 || 12;
	return `${displayH}:${String(m).padStart(2, "0")} ${period}`;
}

export default function ScheduleBoardDayColumn({
	dateStr,
	dayIndex,
	isToday,
	visits,
	occurrences,
	showVisits,
	showOccurrences,
	technicians,
	techColorMap,
	colWidth,
	selectedTechs,
	isAllSelected,
	updateVisit,
	rescheduleOccurrence,
	generateVisitFromOccurrence,
	scrollTop,
	visibleHeight,
	onScrollToY,
	onDropHandled,
	onRescheduleConfirmed,
}: ScheduleBoardDayColumnProps) {
	const navigate = useNavigate();
	const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
	const [clickedCardId, setClickedCardId] = useState<string | null>(null);
	const [clickedCardRect, setClickedCardRect] = useState<DOMRect | null>(null);
	const [hoveredOccurrenceId, setHoveredOccurrenceId] = useState<string | null>(null);
	const [clickedOccurrenceId, setClickedOccurrenceId] = useState<string | null>(null);
	const [clickedOccurrenceRect, setClickedOccurrenceRect] = useState<DOMRect | null>(null);
	const [generatingVisitId, setGeneratingVisitId] = useState<string | null>(null);
	const [dragOverMinutes, setDragOverMinutes] = useState<number | null>(null);
	const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null);
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const [pendingClickReschedule, setPendingClickReschedule] = useState<PendingClickReschedule | null>(null);

	const columnRef          = useRef<HTMLDivElement>(null);
	const popupRef           = useRef<HTMLDivElement>(null);
	const occurrencePopupRef = useRef<HTMLDivElement>(null);
	const dragOffsetY        = useRef(0);

	const { data: stockConflicts = [] } = useVehicleStockConflictsQuery();
	const conflictsByVisitId = useMemo(() => {
		const map = new Map<string, "out" | "low">();
		for (const c of stockConflicts) {
			const existing = map.get(c.visitId);
			if (!existing || (existing === "low" && c.severity === "out")) {
				map.set(c.visitId, c.severity);
			}
		}
		return map;
	}, [stockConflicts]);

	const totalSlots  = DAY_END - DAY_START;
	const columnHeight = totalSlots * SLOT_H;
	const halfSlotH   = SLOT_H / 2;

	// Close visit popup on outside click
	useEffect(() => {
		if (!clickedCardId) return;
		function handleClick(e: MouseEvent) {
			if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
				setClickedCardId(null);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [clickedCardId]);

	// Close occurrence popup on outside click
	useEffect(() => {
		if (!clickedOccurrenceId) return;
		function handleClick(e: MouseEvent) {
			if (occurrencePopupRef.current && !occurrencePopupRef.current.contains(e.target as Node)) {
				setClickedOccurrenceId(null);
			}
		}
		document.addEventListener("mousedown", handleClick);
		return () => document.removeEventListener("mousedown", handleClick);
	}, [clickedOccurrenceId]);

	// ── Deduplicate visits (one card per visit ID) ────────────────────────────

	const uniqueVisits = (() => {
		const seen = new Set<string>();
		const out: VisitWithJob[] = [];
		for (const v of visits) {
			if (!seen.has(v.id)) {
				seen.add(v.id);
				out.push(v);
			}
		}
		return out;
	})();

	// Combined overlap layout — visits and occurrences compete for the same column space, and
	// both are laid out from the same span that positions them.
	const visitLayoutItems = showVisits
		? uniqueVisits.map((v) => ({ _kind: "visit" as const, id: v.id, span: visitSpan(v) }))
		: [];

	const occLayoutItems = showOccurrences
		? occurrences.map((occ) => ({ _kind: "occ" as const, id: occ.id, span: occurrenceSpan(occ) }))
		: [];

	const combinedSlots = resolveOverlapLayout([...visitLayoutItems, ...occLayoutItems], colWidth);

	const visitPositions = new Map<string, { left: number; width: number }>();
	const occPositions   = new Map<string, { left: number; width: number }>();
	for (const { visit: item, left, width } of combinedSlots) {
		if (item._kind === "visit") visitPositions.set(item.id, { left, width });
		else occPositions.set(item.id, { left, width });
	}

	// ── Overflow pill counts ──────────────────────────────────────────────────
	const visibleBottom = scrollTop + visibleHeight;
	const aboveItems: number[] = [];
	const belowItems: number[] = [];

	if (showVisits && visibleHeight > 0) {
		for (const v of uniqueVisits) {
			const top = calcCardTop(visitSpan(v));
			if (top < scrollTop) aboveItems.push(top);
			else if (top >= visibleBottom) belowItems.push(top);
		}
	}
	if (showOccurrences && visibleHeight > 0) {
		for (const occ of occurrences) {
			const top = calcCardTop(occurrenceSpan(occ));
			if (top < scrollTop) aboveItems.push(top);
			else if (top >= visibleBottom) belowItems.push(top);
		}
	}

	const aboveCount = aboveItems.length;
	const belowCount = belowItems.length;
	const topmostAboveTop    = aboveCount > 0 ? Math.min(...aboveItems) : 0;
	const bottommostBelowTop = belowCount > 0 ? Math.max(...belowItems) : 0;

	// ── Drag handlers ─────────────────────────────────────────────────────────

	function handleDragStart(e: React.DragEvent, visit: VisitWithJob) {
		sharedDraggedVisit = visit;
		setDraggingId(visit.id);
		const el = e.currentTarget as HTMLElement;
		function onDragEnd() {
			el.removeEventListener("dragend", onDragEnd);
			sharedDraggedVisit = null;
			setDraggingId(null);
		}
		el.addEventListener("dragend", onDragEnd);

		const startMs = new Date(visit.scheduled_start_at).getTime();
		const endMs   = new Date(visit.scheduled_end_at).getTime();
		if (columnRef.current) {
			const columnTop = columnRef.current.getBoundingClientRect().top;
			const cardTop   = calcCardTop(visitSpan(visit));
			dragOffsetY.current = (e.clientY - columnTop) - cardTop;
			setSharedDragOffset(dragOffsetY.current);
		}
		e.dataTransfer.setData(
			"text/plain",
			JSON.stringify({
				type: "visit",
				visitId: visit.id,
				jobId: visit.job_obj.id,
				durationMs: endMs - startMs,
				startMs,
				arrival_constraint: visit.arrival_constraint,
				arrival_time: visit.arrival_time ?? null,
				arrival_window_start: visit.arrival_window_start ?? null,
				arrival_window_end: visit.arrival_window_end ?? null,
				finish_constraint: visit.finish_constraint,
				finish_time: visit.finish_time ?? null,
				isRecurring: !!visit.job_obj?.recurring_plan,
				entityName: visit.job_obj?.name ?? "Visit",
			})
		);
		e.dataTransfer.effectAllowed = "move";
	}

	function handleOccurrenceDragStart(e: React.DragEvent, occ: OccurrenceWithPlan) {
		sharedDraggedOccurrence = occ;
		setDraggingId(occ.id);
		const el = e.currentTarget as HTMLElement;
		function onDragEnd() {
			el.removeEventListener("dragend", onDragEnd);
			sharedDraggedOccurrence = null;
			setDraggingId(null);
		}
		el.addEventListener("dragend", onDragEnd);

		const startMs = new Date(occ.occurrence_start_at).getTime();
		const endMs   = new Date(occ.occurrence_end_at).getTime();
		if (columnRef.current) {
			const columnTop = columnRef.current.getBoundingClientRect().top;
			const cardTop   = calcCardTop(occurrenceSpan(occ));
			dragOffsetY.current = (e.clientY - columnTop) - cardTop;
			setSharedDragOffset(dragOffsetY.current);
		}
		e.dataTransfer.setData(
			"text/plain",
			JSON.stringify({
				type: "occurrence",
				occurrenceId: occ.id,
				jobId: occ.job_obj.id,
				durationMs: endMs - startMs,
				startMs,
				entityName: occ.plan.name,
				arrival_constraint: occ.arrival_constraint,
				arrival_time: occ.arrival_time ?? null,
				arrival_window_start: occ.arrival_window_start ?? null,
				arrival_window_end: occ.arrival_window_end ?? null,
				finish_constraint: occ.finish_constraint,
				finish_time: occ.finish_time ?? null,
			})
		);
		e.dataTransfer.effectAllowed = "move";
	}

	function handleDragOver(e: React.DragEvent) {
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		if (!columnRef.current) return;
		const rect = columnRef.current.getBoundingClientRect();
		const y = e.clientY - rect.top - getSharedDragOffset();
		setDragOverMinutes(snapTo15Min((y / SLOT_H) * 60));
	}

	function handleDragLeave() {
		setDragOverMinutes(null);
	}

	function handleDrop(e: React.DragEvent) {
		e.preventDefault();
		setDragOverMinutes(null);
		setDraggingId(null);
		if (!columnRef.current) return;
		const raw = e.dataTransfer.getData("text/plain");
		if (!raw) return;

		let parsed: VisitDragPayload & {
			type?: string;
			visitId?: string;
			occurrenceId?: string;
			jobId?: string;
			isRecurring?: boolean;
			entityName?: string;
		};
		try {
			parsed = JSON.parse(raw);
		} catch {
			return;
		}

		const rect = columnRef.current.getBoundingClientRect();
		const y = e.clientY - rect.top - getSharedDragOffset();
		const snappedMins = snapTo15Min((y / SLOT_H) * 60);
		const clampedMins = Math.max(0, Math.min(snappedMins, (DAY_END - DAY_START) * 60));
		const newStart = dateKeyAt(dateStr, DAY_START * 60 + clampedMins);

		// ── No-op check: dropped in same position as origin ───────────────────
		const origDate    = new Date(parsed.startMs);
		const origDateStr = localDateKey(origDate);
		const origSnappedMins = snapTo15Min(minutesOfDay(origDate) - DAY_START * 60);
		if (dateStr === origDateStr && clampedMins === origSnappedMins) return;

		const newEnd = new Date(newStart.getTime() + parsed.durationMs);

		// Constraint-aware labels: use arrival/finish constraint fields if present,
		// falling back to raw scheduled times. "when_done" shows "· WD" instead of
		// a fabricated end time derived from card height.
		const finishConstraint = parsed.finish_constraint ?? "when_done";
		const oldTimeLabel = visitConstraintTimeLabel({
			arrival_constraint: parsed.arrival_constraint ?? "anytime",
			arrival_time: parsed.arrival_time,
			arrival_window_start: parsed.arrival_window_start,
			arrival_window_end: parsed.arrival_window_end,
			finish_constraint: finishConstraint,
			finish_time: parsed.finish_time,
			scheduled_start_at: origDate,
			scheduled_end_at: new Date(parsed.startMs + parsed.durationMs),
		});

		// ── Occurrence drag ───────────────────────────────────────────────────
		if (parsed.type === "occurrence") {
			const droppedOcc = sharedDraggedOccurrence ?? occurrences.find((o) => o.id === parsed.occurrenceId);
			sharedDraggedOccurrence = null;
			setPendingDrop({
				type: "occurrence",
				id: parsed.occurrenceId!,
				jobId: parsed.jobId!,
				isRecurring: true, // occurrences always belong to a recurring plan
				entityName: parsed.entityName ?? "Occurrence",
				oldTimeLabel,
				newTimeLabel: occurrenceDropLabel(parsed, newStart, newEnd),
				priorityColor: getPriorityColor(droppedOcc?.job_obj?.priority),
				occurrenceObj: droppedOcc ?? undefined,
				occurrenceInput: {
					new_start_at: newStart.toISOString(),
					new_end_at: newEnd.toISOString(),
				},
				clientX: e.clientX,
				clientY: e.clientY,
			});
			return;
		}

		// ── Visit drag ────────────────────────────────────────────────────────
		const { visitId } = parsed;
		const data = visitDropUpdate(parsed, newStart, clampedMins);

		const droppedVisit = sharedDraggedVisit ?? uniqueVisits.find((v) => v.id === visitId);
		sharedDraggedVisit = null;
		setPendingDrop({
			type: "visit",
			id: visitId!,
			jobId: parsed.jobId!,
			isRecurring: parsed.isRecurring ?? false,
			entityName: parsed.entityName ?? "Visit",
			oldTimeLabel,
			newTimeLabel: visitDropLabel(parsed, data, newStart, newEnd),
			priorityColor: getPriorityColor(droppedVisit?.job_obj?.priority),
			visitObj: droppedVisit ?? undefined,
			updateData: data,
			clientX: e.clientX,
			clientY: e.clientY,
		});
	}

	// ── Drag-triggered reschedule handlers ───────────────────────────────────

	async function handleDragRescheduleVisitSave(data: UpdateJobVisitInput) {
		if (!pendingDrop) return;
		onDropHandled?.();
		try {
			await updateVisit({ id: pendingDrop.id, data });
			onRescheduleConfirmed?.();
		} catch {
			// reverts via query invalidation
		}
		setPendingDrop(null);
	}

	async function handleDragRescheduleOccurrenceSave(
		input: RescheduleOccurrenceInput & { scope: "this" | "future" },
	) {
		if (!pendingDrop) return;
		onDropHandled?.();
		try {
			await rescheduleOccurrence({
				occurrenceId: pendingDrop.id,
				jobId: pendingDrop.jobId,
				input,
			});
			onRescheduleConfirmed?.();
		} catch {
			// reverts via query invalidation
		}
		setPendingDrop(null);
	}

	async function handleDragRescheduleOccurrenceGenerate(
		input: Omit<RescheduleOccurrenceInput, "scope">,
	) {
		if (!pendingDrop?.occurrenceObj) return;
		const occ = pendingDrop.occurrenceObj;
		onDropHandled?.();
		setGeneratingVisitId(pendingDrop.id);
		try {
			await rescheduleOccurrence({
				occurrenceId: occ.id,
				jobId: occ.job_obj.id,
				input: { ...input, scope: "this" },
			});
			await generateVisitFromOccurrence({ occurrenceId: occ.id, jobId: occ.job_obj.id });
			onRescheduleConfirmed?.();
		} catch {
			// reverts via query invalidation
		}
		setGeneratingVisitId(null);
		setPendingDrop(null);
	}

	// ── Occurrence generate-visit handler ─────────────────────────────────────

	async function handleGenerateVisitFromOccurrence(occ: OccurrenceWithPlan) {
		setGeneratingVisitId(occ.id);
		setClickedOccurrenceId(null);
		try {
			await generateVisitFromOccurrence({
				occurrenceId: occ.id,
				jobId: occ.job_obj.id,
			});
		} catch {
			// failure — data reverts via query invalidation
		}
		setGeneratingVisitId(null);
	}

	// ── Clock-button reschedule handlers ─────────────────────────────────────

	function handleVisitRescheduleClick() {
		const visit = clickedVisit;
		if (!visit || !clickedCardRect) return;
		setClickedCardId(null);
		setPendingClickReschedule({ type: "visit", visit, anchorRect: clickedCardRect });
	}

	function handleOccurrenceRescheduleClick() {
		const occ = clickedOccurrence;
		if (!occ || !clickedOccurrenceRect) return;
		setClickedOccurrenceId(null);
		setPendingClickReschedule({ type: "occurrence", occurrence: occ, anchorRect: clickedOccurrenceRect });
	}

	async function handleClickRescheduleVisitSave(data: UpdateJobVisitInput) {
		if (!pendingClickReschedule?.visit) return;
		try {
			await updateVisit({ id: pendingClickReschedule.visit.id, data });
		} catch {
			// reverts via query invalidation
		}
		setPendingClickReschedule(null);
	}

	async function handleClickRescheduleOccurrenceSave(input: RescheduleOccurrenceInput & { scope: "this" | "future" }) {
		if (!pendingClickReschedule?.occurrence) return;
		const occ = pendingClickReschedule.occurrence;
		try {
			await rescheduleOccurrence({
				occurrenceId: occ.id,
				jobId: occ.job_obj.id,
				input,
			});
		} catch {
			// reverts via query invalidation
		}
		setPendingClickReschedule(null);
	}

	async function handleClickRescheduleOccurrenceGenerate(input: Omit<RescheduleOccurrenceInput, "scope">) {
		if (!pendingClickReschedule?.occurrence) return;
		const occ = pendingClickReschedule.occurrence;
		setGeneratingVisitId(occ.id);
		try {
			await rescheduleOccurrence({
				occurrenceId: occ.id,
				jobId: occ.job_obj.id,
				input: { ...input, scope: "this" },
			});
			await generateVisitFromOccurrence({ occurrenceId: occ.id, jobId: occ.job_obj.id });
		} catch {
			// reverts via query invalidation
		}
		setGeneratingVisitId(null);
		setPendingClickReschedule(null);
	}

	// ── Popup derivations ─────────────────────────────────────────────────────

	const clickedVisit = clickedCardId
		? uniqueVisits.find((v) => v.id === clickedCardId) ?? null
		: null;

	const clickedOccurrence = clickedOccurrenceId
		? occurrences.find((o) => o.id === clickedOccurrenceId) ?? null
		: null;

	// Popup goes right for columns 0–3, left for columns 4–6
	const popupOnLeft = dayIndex >= 4;

	// VisitClickPopup renders through a portal on document.body, so it needs viewport
	// coordinates. Recomputed on scroll/resize so it stays beside its card.
	const clickedCardTop = clickedVisit ? calcCardTop(visitSpan(clickedVisit)) : null;
	const [visitPopupPos, setVisitPopupPos] = useState<{ top: number; left: number } | null>(null);
	useLayoutEffect(() => {
		if (clickedCardTop === null) {
			setVisitPopupPos(null);
			return;
		}
		function reposition() {
			const col = columnRef.current;
			if (!col || clickedCardTop === null) return;
			const colRect = col.getBoundingClientRect();
			const next = getAnchoredPopupPos(
				{ left: colRect.left, right: colRect.right, top: colRect.top + clickedCardTop },
				{ popupH: CLICK_POPUP_H },
			);
			setVisitPopupPos((prev) =>
				prev && prev.top === next.top && prev.left === next.left ? prev : next
			);
		}
		reposition();
		window.addEventListener("scroll", reposition, true); // capture: inner scroll containers too
		window.addEventListener("resize", reposition);
		return () => {
			window.removeEventListener("scroll", reposition, true);
			window.removeEventListener("resize", reposition);
		};
	}, [clickedCardTop, colWidth]);

	const dropIndicatorTop =
		dragOverMinutes !== null
			? Math.max(0, (dragOverMinutes / 60) * SLOT_H)
			: null;

	return (
		<>
			<div
				ref={columnRef}
				style={{
					position: "relative",
					height: columnHeight,
					backgroundColor: isToday ? "var(--color-grid-today-tint)" : "transparent",
					borderLeft: "1px solid var(--color-grid-line-strong)",
					borderBottom: "1px solid var(--color-grid-line-strong)",
					overflow: "visible",
				}}
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
			>
				{/* Hour grid lines */}
				{Array.from({ length: totalSlots }, (_, i) => (
					<div
						key={i}
						style={{
							position: "absolute",
							top: i * SLOT_H,
							left: 0,
							right: 0,
							height: 1,
							backgroundColor: "var(--color-grid-line-strong)",
						}}
					/>
				))}

				{/* Half-hour grid lines */}
				{Array.from({ length: totalSlots }, (_, i) => (
					<div
						key={`half-${i}`}
						style={{
							position: "absolute",
							top: i * SLOT_H + halfSlotH,
							left: 0,
							right: 0,
							height: 1,
							backgroundColor: "var(--color-grid-line-minor)",
						}}
					/>
				))}

				{/* Drop indicator */}
				{dropIndicatorTop !== null && (
					<>
						<div
							style={{
								position: "absolute",
								top: dropIndicatorTop,
								left: LEFT_PAD,
								right: RIGHT_PAD,
								height: 2,
								backgroundColor: "var(--color-primary)",
								borderRadius: 1,
								zIndex: 50,
								pointerEvents: "none",
							}}
						/>
						<span
							style={{
								position: "absolute",
								top: dropIndicatorTop - 9,
								left: LEFT_PAD,
								fontSize: 8,
								fontWeight: 700,
								color: "var(--color-visit-driving-text)",
								lineHeight: 1,
								pointerEvents: "none",
								zIndex: 51,
							}}
						>
							{minutesToLabel(dragOverMinutes!)}
						</span>
					</>
				)}

				{/* Visit cards */}
				{showVisits && uniqueVisits.map((visit) => {
					const { left, width } = visitPositions.get(visit.id) ?? { left: LEFT_PAD, width: colWidth - LEFT_PAD - RIGHT_PAD };
					const isHovered = hoveredCardId === visit.id;
					const span      = visitSpan(visit);
					const top       = calcCardTop(span);
					const height    = calcCardHeight(span);
					const zIndex = isHovered ? 30 : 1;

					const assignedTechs: AssignedTech[] = (visit.visit_techs ?? []).map((vt) => ({
						id: vt.tech_id,
						name: technicians.find((t) => t.id === vt.tech_id)?.name ?? vt.tech_id,
						color: techColorMap.get(vt.tech_id) ?? "var(--color-tech-unassigned)",
						inFilter: isAllSelected || selectedTechs.has(vt.tech_id),
					}));

					return (
						<ScheduleBoardCard
							key={visit.id}
							cardId={visit.id}
							model={toCardModel(
								{ kind: "visit", visit },
								{
									techs: assignedTechs,
									stockWarning: conflictsByVisitId.get(visit.id),
									isAllSelected,
								}
							)}
							isHovered={isHovered}
							opacity={
								pendingDrop?.id === visit.id ? 0
								: draggingId === visit.id ? 0.35
								: 1
							}
							top={top}
							height={height}
							left={left}
							width={width}
							zIndex={zIndex}
							onClick={(e) => {
								setClickedOccurrenceId(null);
								setClickedOccurrenceRect(null);
								const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
								const next = clickedCardId === visit.id ? null : visit.id;
								setClickedCardId(next);
								setClickedCardRect(next ? rect : null);
							}}
							onMouseEnter={() => setHoveredCardId(visit.id)}
							onMouseLeave={(e) => {
								const related = e.relatedTarget as Node | null;
								const card = e.currentTarget as HTMLElement;
								if (!related || !card.contains(related)) setHoveredCardId(null);
							}}
							onDragStart={(e) => handleDragStart(e, visit)}
						/>
					);
				})}

				{/* Occurrence cards */}
				{showOccurrences && occurrences.map((occ) => {
					const span = occurrenceSpan(occ);
					const { left: occLeft, width: occWidth } = occPositions.get(occ.id) ?? { left: LEFT_PAD, width: colWidth - LEFT_PAD - RIGHT_PAD };
					const isHov        = hoveredOccurrenceId === occ.id;
					const isClicked    = clickedOccurrenceId === occ.id;
					const isGenerating = generatingVisitId === occ.id;

					return (
						<ScheduleBoardCard
							key={`occ-${occ.id}`}
							cardId={occ.id}
							model={toCardModel(
								{ kind: "occurrence", occurrence: occ },
								{ techs: [], isAllSelected }
							)}
							isHovered={isHov}
							busy={isGenerating}
							opacity={
								pendingDrop?.id === occ.id ? 0
								: draggingId === occ.id ? 0.35
								: isGenerating ? 0.5
								: 1
							}
							top={calcCardTop(span)}
							height={calcCardHeight(span)}
							left={occLeft}
							width={occWidth}
							zIndex={isHov ? 30 : 1}
							onClick={(e) => {
								setClickedCardId(null);
								setClickedCardRect(null);
								const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
								const next = isClicked ? null : occ.id;
								setClickedOccurrenceId(next);
								setClickedOccurrenceRect(next ? rect : null);
							}}
							onMouseEnter={() => setHoveredOccurrenceId(occ.id)}
							onMouseLeave={() => setHoveredOccurrenceId(null)}
							onDragStart={(e) => handleOccurrenceDragStart(e, occ)}
						/>
					);
				})}

				{/* Visit click popup */}
				{clickedVisit && visitPopupPos && (
					<VisitClickPopup
						visit={clickedVisit}
						popupRef={popupRef}
						technicians={technicians}
						techColorMap={techColorMap}
						style={{
							position: "fixed",
							top: visitPopupPos.top,
							left: visitPopupPos.left,
						}}
						onClose={() => setClickedCardId(null)}
						onViewVisit={() => navigate(`/dispatch/jobs/${clickedVisit.job_obj.id}/visits/${clickedVisit.id}`)}
						onViewJob={() => navigate(`/dispatch/jobs/${clickedVisit.job_obj.id}`)}
						onRescheduleClick={handleVisitRescheduleClick}
					/>
				)}

				{/* Occurrence click popup */}
				{clickedOccurrence && (
					<OccurrenceClickPopup
						occurrence={clickedOccurrence}
						popupRef={occurrencePopupRef}
						isGenerating={generatingVisitId === clickedOccurrence.id}
						style={{
							position: "absolute",
							top: Math.min(calcCardTop(occurrenceSpan(clickedOccurrence)), columnHeight - CLICK_POPUP_H),
							...(popupOnLeft
								? { right: colWidth + 4 }
								: { left: colWidth + 4 }),
						}}
						onClose={() => setClickedOccurrenceId(null)}
						onViewPlan={() => navigate(`/dispatch/recurring-plans/${clickedOccurrence.plan.id}`)}
						onGenerate={() => handleGenerateVisitFromOccurrence(clickedOccurrence)}
						onRescheduleClick={handleOccurrenceRescheduleClick}
					/>
				)}

				{/* Above-fold overflow pill */}
				{aboveCount > 0 && visibleHeight > 0 && (
					<button
						onClick={() => onScrollToY(topmostAboveTop - 8)}
						style={{
							position: "absolute",
							left: "50%",
							transform: "translateX(-50%)",
							top: scrollTop + 4,
							zIndex: 50,
							display: "flex",
							alignItems: "center",
							gap: 3,
							height: 20,
							padding: "0 7px",
							background: "var(--color-grid-float-bg)",
							border: "1px solid var(--color-grid-line-strong)",
							borderRadius: 999,
							fontSize: 10,
							fontWeight: 600,
							color: "var(--color-text-tertiary)",
							cursor: "pointer",
							whiteSpace: "nowrap",
							boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
							fontFamily: "inherit",
						}}
					>
						<ChevronUp size={10} strokeWidth={2.5} />
						{aboveCount}
					</button>
				)}

				{/* Below-fold overflow pill */}
				{belowCount > 0 && visibleHeight > 0 && (
					<button
						onClick={() => onScrollToY(bottommostBelowTop - 8)}
						style={{
							position: "absolute",
							left: "50%",
							transform: "translateX(-50%)",
							top: scrollTop + visibleHeight - 28,
							zIndex: 50,
							display: "flex",
							alignItems: "center",
							gap: 3,
							height: 20,
							padding: "0 7px",
							background: "var(--color-grid-float-bg)",
							border: "1px solid var(--color-grid-line-strong)",
							borderRadius: 999,
							fontSize: 10,
							fontWeight: 600,
							color: "var(--color-text-tertiary)",
							cursor: "pointer",
							whiteSpace: "nowrap",
							boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
							fontFamily: "inherit",
						}}
					>
						<ChevronDown size={10} strokeWidth={2.5} />
						{belowCount}
					</button>
				)}

				{/* Ghost card at drop target position */}
				{pendingDrop && (() => {
					const ghostStart = pendingDrop.type === "visit"
						? pendingDrop.updateData?.scheduled_start_at
						: pendingDrop.occurrenceInput?.new_start_at;
					const ghostEnd = pendingDrop.type === "visit"
						? pendingDrop.updateData?.scheduled_end_at
						: pendingDrop.occurrenceInput?.new_end_at;
					if (!ghostStart) return null;

					// Same span rules as the real cards, so the ghost is exactly as tall as what lands.
					const ghostSpan = cardSpan({
						start: ghostStart,
						end: ghostEnd ?? ghostStart,
						finish_constraint:
							pendingDrop.type === "visit"
								? (pendingDrop.updateData?.finish_constraint ??
									pendingDrop.visitObj?.finish_constraint)
								: pendingDrop.occurrenceObj?.finish_constraint,
					});
					const ghostTop    = calcCardTop(ghostSpan);
					const ghostHeight = calcCardHeight(ghostSpan);

					const origSlot = combinedSlots.find((s) => s.visit.id === pendingDrop.id);
					const ghostLeft = origSlot?.left ?? LEFT_PAD;
					const ghostWidth = origSlot?.width ?? (colWidth - LEFT_PAD - RIGHT_PAD);

					return (
						<div
							key="ghost-drop"
							style={{
								position: "absolute",
								top: ghostTop,
								left: pendingDrop.type === "occurrence" ? LEFT_PAD : ghostLeft,
								width: pendingDrop.type === "occurrence" ? colWidth - LEFT_PAD - RIGHT_PAD : ghostWidth,
								height: ghostHeight,
								opacity: 0.5,
								border: "1px dashed var(--color-primary)",
								borderRadius: 4,
								backgroundColor: pendingDrop.type === "occurrence" ? "var(--color-occurrence-bg)" : "var(--color-sched-today-bg)",
								boxShadow: "inset 0 0 0 999px rgba(59,130,246,0.08)",
								zIndex: 25,
								pointerEvents: "none",
								display: "flex",
								alignItems: "stretch",
								overflow: "hidden",
								boxSizing: "border-box",
							}}
						>
							{/* Priority strip */}
							<div style={{
								width: 4,
								flexShrink: 0,
								backgroundColor: pendingDrop.priorityColor,
								opacity: 0.7,
							}} />
							{/* Name + time */}
							<div style={{
								flex: 1,
								minWidth: 0,
								padding: "4px 6px",
								display: "flex",
								flexDirection: "column",
								gap: 2,
								overflow: "hidden",
							}}>
								<span style={{
									fontSize: 10,
									fontWeight: 600,
									color: pendingDrop.type === "occurrence" ? "var(--color-sched-occurrence-title)" : "var(--color-text-on-surface)",
									fontStyle: pendingDrop.type === "occurrence" ? "italic" : "normal",
									overflow: "hidden",
									whiteSpace: "nowrap",
									textOverflow: "ellipsis",
									lineHeight: 1.2,
								}}>
									{pendingDrop.entityName}
								</span>
								{ghostHeight >= 34 && (
									<span style={{
										fontSize: 9,
										color: "var(--color-visit-driving-text)",
										lineHeight: 1.2,
										whiteSpace: "nowrap",
									}}>
										{pendingDrop.newTimeLabel}
									</span>
								)}
							</div>
						</div>
					);
				})()}
			</div>

			{/* ── Fixed-position overlays (escape column bounds) ────────────────── */}

			{/* Drag-triggered visit reschedule */}
			{pendingDrop?.type === "visit" && pendingDrop.visitObj && (() => {
				const vObj = pendingDrop.visitObj!;
				const ud = pendingDrop.updateData!;
				const syntheticVisit: VisitWithJob = {
					...vObj,
					scheduled_start_at: ud.scheduled_start_at ?? vObj.scheduled_start_at,
					scheduled_end_at:   ud.scheduled_end_at   ?? vObj.scheduled_end_at,
					arrival_constraint: ud.arrival_constraint  ?? vObj.arrival_constraint,
					arrival_time:       ud.arrival_time !== undefined ? ud.arrival_time : vObj.arrival_time,
					arrival_window_start: ud.arrival_window_start !== undefined ? ud.arrival_window_start : vObj.arrival_window_start,
					arrival_window_end:   ud.arrival_window_end   !== undefined ? ud.arrival_window_end   : vObj.arrival_window_end,
					finish_constraint:  ud.finish_constraint ?? vObj.finish_constraint,
					finish_time:        ud.finish_time !== undefined ? ud.finish_time : vObj.finish_time,
				};
				const origDateStr = localDateKey(vObj.scheduled_start_at);
				const anchorRect = {
					top: pendingDrop.clientY - 20, bottom: pendingDrop.clientY + 20,
					left: pendingDrop.clientX, right: pendingDrop.clientX + 1,
					width: 1, height: 40, x: pendingDrop.clientX, y: pendingDrop.clientY - 20,
					toJSON: () => ({}),
				} as DOMRect;
				return (
					<ReschedulePopup
						visit={syntheticVisit}
						oldDateStr={origDateStr}
						newDateStr={dateStr}
						allVisitsOnNewDay={visits}
						technicians={technicians}
						techColorMap={techColorMap}
						anchorRect={anchorRect}
						fromLabel={pendingDrop.oldTimeLabel}
						toLabel={pendingDrop.newTimeLabel}
						onSave={handleDragRescheduleVisitSave}
						onUndo={() => setPendingDrop(null)}
					/>
				);
			})()}

			{/* Drag-triggered occurrence reschedule */}
			{pendingDrop?.type === "occurrence" && pendingDrop.occurrenceObj && (() => {
				const oObj = pendingDrop.occurrenceObj!;
				const oi = pendingDrop.occurrenceInput!;
				const syntheticOcc: OccurrenceWithPlan = (() => {
					const deltaMin =
						minutesOfDay(new Date(oi.new_start_at ?? oObj.occurrence_start_at)) -
						minutesOfDay(new Date(oObj.occurrence_start_at));
					return {
						...oObj,
						occurrence_start_at: oi.new_start_at ?? oObj.occurrence_start_at,
						occurrence_end_at:   oi.new_end_at   ?? oObj.occurrence_end_at,
						...shiftConstraintTimes(oObj, deltaMin),
					};
				})();
				const origDateStr = localDateKey(oObj.occurrence_start_at);
				const anchorRect = {
					top: pendingDrop.clientY - 20, bottom: pendingDrop.clientY + 20,
					left: pendingDrop.clientX, right: pendingDrop.clientX + 1,
					width: 1, height: 40, x: pendingDrop.clientX, y: pendingDrop.clientY - 20,
					toJSON: () => ({}),
				} as DOMRect;
				return (
					<OccurrenceReschedulePopup
						occurrence={syntheticOcc}
						oldDateStr={origDateStr}
						newDateStr={dateStr}
						allOccurrencesOnNewDay={occurrences}
						anchorRect={anchorRect}
						fromLabel={pendingDrop.oldTimeLabel}
						toLabel={pendingDrop.newTimeLabel}
						onReschedule={handleDragRescheduleOccurrenceSave}
						onGenerate={handleDragRescheduleOccurrenceGenerate}
						onCancel={() => setPendingDrop(null)}
						isGenerating={generatingVisitId === pendingDrop.id}
					/>
				);
			})()}

			{/* Clock-button triggered visit reschedule */}
			{pendingClickReschedule?.type === "visit" && pendingClickReschedule.visit && (
				<ReschedulePopup
					visit={pendingClickReschedule.visit}
					oldDateStr={dateStr}
					newDateStr={localDateKey(pendingClickReschedule.visit.scheduled_start_at)}
					allVisitsOnNewDay={visits}
					technicians={technicians}
					techColorMap={techColorMap}
					anchorRect={pendingClickReschedule.anchorRect}
					onSave={handleClickRescheduleVisitSave}
					onUndo={() => setPendingClickReschedule(null)}
				/>
			)}

			{/* Clock-button triggered occurrence reschedule */}
			{pendingClickReschedule?.type === "occurrence" && pendingClickReschedule.occurrence && (
				<OccurrenceReschedulePopup
					occurrence={pendingClickReschedule.occurrence}
					oldDateStr={dateStr}
					newDateStr={dateStr}
					anchorRect={pendingClickReschedule.anchorRect}
					onReschedule={handleClickRescheduleOccurrenceSave}
					onGenerate={handleClickRescheduleOccurrenceGenerate}
					onCancel={() => setPendingClickReschedule(null)}
					isGenerating={generatingVisitId === pendingClickReschedule.occurrence.id}
				/>
			)}
		</>
	);
}
