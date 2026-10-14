import type { CSSProperties } from "react";
import type { Technician } from "../../../types/technicians";
import type { JobVisit, UpdateJobVisitInput } from "../../../types/jobs";
import type { ArrivalConstraint, FinishConstraint } from "../../../types/recurringPlans";

// ─── Shared constants (scroll zones) ─────────────────────────────────────────

export const SCROLL_ZONE_W = 40; // px — edge zone that triggers week/month scroll during drag
export const SCROLL_DELAY_MS = 1500; // ms — delay before auto-advancing on zone hold

// ─── Constants ────────────────────────────────────────────────────────────────

export const SLOT_H = 56; // px per hour
export const DAY_START = 0; // 12 AM (midnight)
export const DAY_END = 24; // 12 AM next day
export const CARD_W_VW = 0.068;
export const CARD_W_MIN = 72;
export const CARD_W_MAX = 96;
export const LEFT_PAD = 5;
export const RIGHT_PAD = 10;

const TECH_COLOR_PALETTE = [
	"var(--color-sched-tech-1)",
	"var(--color-sched-tech-2)",
	"var(--color-sched-tech-3)",
	"var(--color-sched-tech-4)",
	"var(--color-sched-tech-5)",
	"var(--color-sched-tech-6)",
	"var(--color-sched-tech-7)",
	"var(--color-sched-tech-8)",
	"var(--color-sched-tech-9)",
	"var(--color-sched-tech-10)",
	"var(--color-sched-tech-11)",
	"var(--color-sched-tech-12)",
];

// ─── Priority color ───────────────────────────────────────────────────────────

export function getPriorityColor(priority?: string): string {
	switch (priority?.toLowerCase()) {
		case "emergency": return "var(--color-priority-emergency)";
		case "urgent":    return "var(--color-priority-urgent)";
		case "high":      return "var(--color-priority-high)";
		case "medium":    return "var(--color-priority-medium)";
		case "low":       return "var(--color-priority-low)";
		default:          return "var(--color-priority-default)";
	}
}

// ─── Tech ordering ────────────────────────────────────────────────────────────

/** Stable global ordering: sort techs by id, return array of ids */
export function buildTechOrder(technicians: Technician[]): string[] {
	return [...technicians].sort((a, b) => a.id.localeCompare(b.id)).map((t) => t.id);
}

/** Filter globalOrder to only techs present in activeTechIds, preserving order */
export function dayTechOrder(globalOrder: string[], activeTechIds: Set<string>): string[] {
	return globalOrder.filter((id) => activeTechIds.has(id));
}

// ─── Card geometry ────────────────────────────────────────────────────────────

export function getCardW(viewportWidth: number): number {
	return Math.min(CARD_W_MAX, Math.max(CARD_W_MIN, viewportWidth * CARD_W_VW));
}

// ─── Overlap collision layout ─────────────────────────────────────────────────

export interface OverlapSlot<T> {
	visit: T;
	left: number;
	width: number;
}

/**
 * Time-local overlap layout: assigns each visit a lane via greedy slot-packing,
 * then expands each visit rightward into lanes that are free during its time range.
 *
 * Algorithm:
 *   1. Assign lanes — each visit takes the lowest lane whose last occupant ended
 *      before this visit starts. This is independent per visit, not per group.
 *   2. Build direct-overlap adjacency — two visits overlap iff their time ranges
 *      intersect (start < other.end && other.start < end).
 *   3. Find connected components of the overlap graph — this is the true "cluster"
 *      even when visits are only indirectly connected through a long-spanning visit.
 *      The cluster's max lane + 1 is the width denominator for all members.
 *   4. Per visit, columnSpan = (next lane occupied by a direct overlap to its right)
 *      minus its own lane.  If no directly-overlapping visit sits to its right, it
 *      spans all the way to the end of the cluster — filling unused horizontal space.
 *
 * Example: A(7–17), B(8–10), C(9–10), D(14–15)
 *   Lanes:  A=0, B=1, C=2, D=1   (D reuses lane 1 after B ends at 10)
 *   Cluster max lane = 2  →  totalLanes = 3  (width denominator for all four)
 *   A: direct overlaps B(1),C(2),D(1) → next right = 1 → span=1 → 1/3 width
 *   B: direct overlaps A(0),C(2)      → next right = 2 → span=1 → 1/3 width
 *   C: direct overlaps A(0),B(1)      → no right    → span=1 → 1/3 width
 *   D: direct overlaps A(0) only      → no right    → span=2 → 2/3 width
 */
export function resolveOverlapLayout<T extends { id: string; span: CardSpan }>(
	visits: T[],
	colWidth: number
): OverlapSlot<T>[] {
	if (visits.length === 0) return [];

	const GAP = 2;
	const usableWidth = colWidth - LEFT_PAD - RIGHT_PAD;

	const sorted = [...visits].sort((a, b) => a.span.startH - b.span.startH);
	const n = sorted.length;

	// ── Step 1: assign lanes ───────────────────────────────────────────────────
	// laneEnd[i] = the end-hour of the last visit placed in lane i.
	const laneEnd: number[] = [];
	const lane = new Map<string, number>();
	const sH: number[] = [];
	const eH: number[] = [];

	for (let i = 0; i < n; i++) {
		const s = sorted[i].span.startH;
		const e = Math.max(sorted[i].span.endH, s + MIN_CARD_HOURS);
		sH.push(s);
		eH.push(e);

		let assigned = -1;
		for (let l = 0; l < laneEnd.length; l++) {
			if (laneEnd[l] <= s) {
				laneEnd[l] = e;
				assigned = l;
				break;
			}
		}
		if (assigned === -1) {
			assigned = laneEnd.length;
			laneEnd.push(e);
		}
		lane.set(sorted[i].id, assigned);
	}

	// ── Step 2: direct-overlap adjacency ──────────────────────────────────────
	const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			if (sH[i] < eH[j] && sH[j] < eH[i]) {
				adj[i].add(j);
				adj[j].add(i);
			}
		}
	}

	// ── Step 3: connected components (BFS) ────────────────────────────────────
	const comp = new Int32Array(n).fill(-1);
	let numComp = 0;
	for (let i = 0; i < n; i++) {
		if (comp[i] !== -1) continue;
		const queue = [i];
		comp[i] = numComp;
		for (let qi = 0; qi < queue.length; qi++) {
			for (const nb of adj[queue[qi]]) {
				if (comp[nb] === -1) {
					comp[nb] = numComp;
					queue.push(nb);
				}
			}
		}
		numComp++;
	}

	// max lane per component → totalLanes per component
	const compMaxLane = new Int32Array(numComp).fill(0);
	for (let i = 0; i < n; i++) {
		const l = lane.get(sorted[i].id)!;
		if (l > compMaxLane[comp[i]]) compMaxLane[comp[i]] = l;
	}

	// ── Step 4: compute left + width per visit ─────────────────────────────────
	const result: OverlapSlot<T>[] = [];
	for (let i = 0; i < n; i++) {
		const visit = sorted[i];
		const myLane = lane.get(visit.id)!;
		const totalLanes = compMaxLane[comp[i]] + 1;

		// Find nearest directly-overlapping lane to the right of myLane
		let nextOccupied = totalLanes;
		for (const j of adj[i]) {
			const jl = lane.get(sorted[j].id)!;
			if (jl > myLane && jl < nextOccupied) nextOccupied = jl;
		}
		const span = nextOccupied - myLane;

		const slotW = (usableWidth - GAP * (totalLanes - 1)) / totalLanes;
		result.push({
			visit,
			left: LEFT_PAD + myLane * (slotW + GAP),
			width: slotW * span + GAP * (span - 1),
		});
	}
	return result;
}

/**
 * Parse an "HH:MM" constraint string to fractional hours. Returns null if invalid.
 */
export function hhmmToHours(hhmm: string | null | undefined): number | null {
	if (!hhmm) return null;
	const [h, m] = hhmm.split(":").map(Number);
	if (Number.isNaN(h) || Number.isNaN(m)) return null;
	return h + m / 60;
}

// ─── Card span (single source of truth for top, height and lanes) ─────────────

export interface CardSpan {
	startH: number;
	endH: number;
	openEnded: boolean;
}

/** Drawn minimum in hours; lanes use it too so a 5-minute card still claims its drawn height. */
const MIN_CARD_HOURS = 0.5;

/**
 * Drawn length of a `when_done` card. Its stored end is not a real estimate yet (forms write
 * start + 2h, seed/imports write anything), so it is ignored until an editable estimate exists.
 */
export const WHEN_DONE_DEFAULT_H = 2;

function toDate(at: string | Date | null | undefined): Date {
	if (at == null) return new Date(NaN);
	return typeof at === "string" ? new Date(at) : at;
}

/**
 * Local wall-clock span of a stored schedule. Wall-clock, not elapsed ms, because the grid's
 * hour lines are wall-clock — a DST day must still line up.
 */
export function cardSpan(item: {
	start: string | Date;
	end: string | Date;
	finish_constraint?: string;
}): CardSpan {
	const s = toDate(item.start);
	const e = toDate(item.end);
	const rawStart = s.getHours() + s.getMinutes() / 60;
	const startH = Number.isFinite(rawStart) ? rawStart : DAY_START;
	if (item.finish_constraint === "when_done") {
		return { startH, endH: Math.min(DAY_END, startH + WHEN_DONE_DEFAULT_H), openEnded: true };
	}
	let endH: number;
	// `!(a > b)` also catches an unparseable end (NaN), which would otherwise fail the day check.
	if (!(e.getTime() > s.getTime())) endH = startH;
	else if (localDateKey(e) !== localDateKey(s)) endH = DAY_END;
	else endH = e.getHours() + e.getMinutes() / 60;
	return { startH, endH, openEnded: false };
}

export function visitSpan(v: {
	scheduled_start_at: string | Date;
	scheduled_end_at: string | Date;
	finish_constraint?: string;
}): CardSpan {
	return cardSpan({
		start: v.scheduled_start_at,
		end: v.scheduled_end_at,
		finish_constraint: v.finish_constraint,
	});
}

export function occurrenceSpan(o: {
	occurrence_start_at: string | Date;
	occurrence_end_at: string | Date;
	finish_constraint?: string;
}): CardSpan {
	return cardSpan({
		start: o.occurrence_start_at,
		end: o.occurrence_end_at,
		finish_constraint: o.finish_constraint,
	});
}

/** Top offset in px from the top of the time grid. */
export function calcCardTop(span: CardSpan): number {
	return Math.max(0, (span.startH - DAY_START) * SLOT_H);
}

/** Format a visit's start time from constraint HH:MM fields (timezone-free), falling back to local time from scheduled_start_at. */
export function visitStartLabel(visit: {
	arrival_constraint: string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	scheduled_start_at: string | Date;
}): string {
	let hhmm: string | null | undefined = null;
	if (visit.arrival_constraint === "at") hhmm = visit.arrival_time;
	else if (visit.arrival_constraint === "between") hhmm = visit.arrival_window_start;
	else if (visit.arrival_constraint === "by") hhmm = visit.arrival_window_end;
	if (hhmm) {
		const [h, m] = hhmm.split(":").map(Number);
		const period = h >= 12 ? "PM" : "AM";
		const displayH = h % 12 || 12;
		return `${displayH}:${String(m).padStart(2, "0")} ${period}`;
	}
	const d =
		typeof visit.scheduled_start_at === "string"
			? new Date(visit.scheduled_start_at)
			: visit.scheduled_start_at;
	return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Format a visit's end time from constraint HH:MM fields (timezone-free), falling back to local time from scheduled_end_at. */
export function visitEndLabel(visit: {
	finish_constraint: string;
	finish_time?: string | null;
	scheduled_end_at: string | Date;
}): string {
	if (
		(visit.finish_constraint === "at" || visit.finish_constraint === "by") &&
		visit.finish_time
	) {
		const [h, m] = visit.finish_time.split(":").map(Number);
		const period = h >= 12 ? "PM" : "AM";
		const displayH = h % 12 || 12;
		return `${displayH}:${String(m).padStart(2, "0")} ${period}`;
	}
	const d =
		typeof visit.scheduled_end_at === "string"
			? new Date(visit.scheduled_end_at)
			: visit.scheduled_end_at;
	return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Formats a visit or occurrence as a single time-range string for compact chip display.
 * Uses constraint fields (arrival_constraint, finish_constraint) rather than raw scheduled times.
 * Returns e.g. "7:00 AM · WD" for when_done, "8:00 AM – 3:00 PM" for timed constraints.
 */
export function visitConstraintTimeLabel(visit: {
	arrival_constraint: string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_constraint: string;
	finish_time?: string | null;
	scheduled_start_at: string | Date;
	scheduled_end_at: string | Date;
}): string {
	const start = visitStartLabel(visit);
	if (visit.finish_constraint === "when_done") return `${start} · WD`;
	return `${start} – ${visitEndLabel(visit)}`;
}

/** Height in px. Open-ended cards draw WHEN_DONE_DEFAULT_H; the dashed edge marks them. */
export function calcCardHeight(span: CardSpan): number {
	return Math.max(MIN_CARD_HOURS * SLOT_H, (span.endH - span.startH) * SLOT_H);
}

// ─── Reschedule helpers ───────────────────────────────────────────────────────

export interface ConstraintTimes {
	arrival_constraint: string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_constraint: string;
	finish_time?: string | null;
}

/** Constraint form state; empty strings are unset times. */
export interface ConstraintDraft {
	arrival_constraint: ArrivalConstraint;
	arrival_time: string;
	arrival_window_start: string;
	arrival_window_end: string;
	finish_constraint: FinishConstraint;
	finish_time: string;
}

/** Save payload: times the chosen constraints don't use are nulled so stale values aren't kept. */
export function constraintPayload(c: ConstraintDraft) {
	const arrival = c.arrival_constraint;
	const finish = c.finish_constraint;
	return {
		arrival_constraint: arrival,
		finish_constraint: finish,
		arrival_time: arrival === "at" ? c.arrival_time || null : null,
		arrival_window_start: arrival === "between" ? c.arrival_window_start || null : null,
		arrival_window_end:
			arrival === "between" || arrival === "by" ? c.arrival_window_end || null : null,
		finish_time: finish === "at" || finish === "by" ? c.finish_time || null : null,
	};
}

function hhmmToMinutes(hhmm: string | null | undefined): number | null {
	const h = hhmmToHours(hhmm);
	return h === null ? null : Math.round(h * 60);
}

const LAST_MINUTE = 23 * 60 + 59;

function clampToDay(mins: number): number {
	return Math.max(0, Math.min(mins, LAST_MINUTE));
}

/** Local minutes from midnight. */
export function minutesOfDay(d: Date): number {
	return d.getHours() * 60 + d.getMinutes();
}

/** Local Date on a "YYYY-MM-DD" key at `mins` past midnight (parsed by parts, never as UTC). */
export function dateKeyAt(key: string, mins = 0): Date {
	const [y, mo, d] = key.split("-").map(Number);
	return new Date(y, mo - 1, d, Math.floor(mins / 60), mins % 60, 0, 0);
}

/** Minutes from midnight → "HH:MM", clamped to the day (constraint times cannot cross midnight). */
function minutesToHHMM(mins: number): string {
	const c = clampToDay(mins);
	return `${String(Math.floor(c / 60)).padStart(2, "0")}:${String(c % 60).padStart(2, "0")}`;
}

type ShiftedField = "arrival_time" | "arrival_window_start" | "arrival_window_end" | "finish_time";
export type ShiftedTimes = Partial<Record<ShiftedField, string>>;

/** Moves every constraint time the constraint actually uses by `deltaMin`; null fields stay unset. */
export function shiftConstraintTimes(c: ConstraintTimes, deltaMin: number): ShiftedTimes {
	const out: ShiftedTimes = {};
	const shift = (field: ShiftedField, hhmm: string | null | undefined) => {
		const m = hhmmToMinutes(hhmm);
		if (m !== null) out[field] = minutesToHHMM(m + deltaMin);
	};
	if (c.arrival_constraint === "at") shift("arrival_time", c.arrival_time);
	else if (c.arrival_constraint === "between") {
		shift("arrival_window_start", c.arrival_window_start);
		shift("arrival_window_end", c.arrival_window_end);
	} else if (c.arrival_constraint === "by") shift("arrival_window_end", c.arrival_window_end);
	if (c.finish_constraint === "at" || c.finish_constraint === "by") {
		shift("finish_time", c.finish_time);
	}
	return out;
}

export interface VisitDragPayload {
	startMs: number;
	durationMs: number;
	arrival_constraint?: string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_constraint?: string;
	finish_time?: string | null;
}

/** Update body for a visit dropped on the time grid at `dropMins` (minutes from midnight). */
export function visitDropUpdate(
	drag: VisitDragPayload,
	newStart: Date,
	dropMins: number
): UpdateJobVisitInput {
	const data: UpdateJobVisitInput = {
		scheduled_start_at: newStart.toISOString(),
		scheduled_end_at: new Date(newStart.getTime() + drag.durationMs).toISOString(),
	};
	if (drag.arrival_constraint === "anytime") {
		return {
			...data,
			arrival_constraint: "at",
			arrival_time: minutesToHHMM(dropMins),
			finish_constraint: "when_done",
			finish_time: null,
		};
	}
	if (!drag.arrival_constraint) return data;
	const deltaMin = dropMins - minutesOfDay(new Date(drag.startMs));
	return {
		...data,
		...shiftConstraintTimes(
			{
				...drag,
				arrival_constraint: drag.arrival_constraint,
				finish_constraint: drag.finish_constraint ?? "when_done",
			},
			deltaMin
		),
	};
}

/** "After" time label for a visit drop, on the same basis as the "before" label (by = deadline). */
export function visitDropLabel(
	drag: VisitDragPayload,
	data: UpdateJobVisitInput,
	newStart: Date,
	newEnd: Date
): string {
	return visitConstraintTimeLabel({
		arrival_time: drag.arrival_time,
		arrival_window_start: drag.arrival_window_start,
		arrival_window_end: drag.arrival_window_end,
		finish_time: drag.finish_time,
		...data,
		arrival_constraint: data.arrival_constraint ?? drag.arrival_constraint ?? "anytime",
		finish_constraint: data.finish_constraint ?? drag.finish_constraint ?? "when_done",
		scheduled_start_at: newStart,
		scheduled_end_at: newEnd,
	});
}

/** "After" label for an occurrence drop; shifts constraint times by the start delta, like the popup. */
export function occurrenceDropLabel(drag: VisitDragPayload, newStart: Date, newEnd: Date): string {
	const deltaMin = minutesOfDay(newStart) - minutesOfDay(new Date(drag.startMs));
	const shifted = shiftConstraintTimes(
		{
			...drag,
			arrival_constraint: drag.arrival_constraint ?? "anytime",
			finish_constraint: drag.finish_constraint ?? "when_done",
		},
		deltaMin
	);
	return visitDropLabel(drag, shifted, newStart, newEnd);
}

/** Lead a `by` arrival gets before its deadline, as the create form stores it. */
const BY_LEAD_MIN = 240;

function arrivalAnchorMins(c: ConstraintTimes): number | null {
	if (c.arrival_constraint === "at") return hhmmToMinutes(c.arrival_time);
	if (c.arrival_constraint === "between") return hhmmToMinutes(c.arrival_window_start);
	if (c.arrival_constraint === "by") return hhmmToMinutes(c.arrival_window_end);
	return null;
}

/**
 * Local start/end on `dateStr` after a popup edit. The card is drawn from scheduled_*, so an
 * edited arrival or finish time must move the schedule with it.
 */
export function alignScheduleToConstraints(
	dateStr: string,
	orig: { start: string | Date; end: string | Date },
	before: ConstraintTimes,
	after: ConstraintTimes
): { start: Date; end: Date } {
	const s0 = toDate(orig.start);
	const e0 = toDate(orig.end);
	const durMs = Math.max(0, e0.getTime() - s0.getTime()) || 0;
	let startMins = minutesOfDay(s0);
	const a0 = arrivalAnchorMins(before);
	const a1 = arrivalAnchorMins(after);
	if (a1 !== null) {
		if (after.arrival_constraint === before.arrival_constraint) {
			if (a0 !== null) startMins += a1 - a0;
		} else {
			startMins = after.arrival_constraint === "by" ? a1 - BY_LEAD_MIN : a1;
		}
	}
	const start = dateKeyAt(dateStr, clampToDay(startMins));

	const f =
		after.finish_constraint === "at" || after.finish_constraint === "by"
			? hhmmToMinutes(after.finish_time)
			: null;
	const fixedEnd = f !== null ? dateKeyAt(dateStr, f) : null;
	const end = fixedEnd && fixedEnd > start ? fixedEnd : new Date(start.getTime() + durMs);
	return { start, end };
}

// ─── Tech display ─────────────────────────────────────────────────────────────

export function getTechColor(globalIndex: number): string {
	return TECH_COLOR_PALETTE[globalIndex % TECH_COLOR_PALETTE.length];
}

export function getTechInitials(name: string): string {
	const words = name.trim().split(/\s+/);
	if (words.length === 1) return name.slice(0, 2).toUpperCase();
	return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// ─── Data grouping ────────────────────────────────────────────────────────────

/** Local-calendar day key ("YYYY-MM-DD"). Pass an instant, never a key: a bare
 *  "YYYY-MM-DD" string parses as UTC midnight and lands on the previous day west of UTC. */
export function localDateKey(input: Date | string): string {
	const d = typeof input === "string" ? new Date(input) : input;
	const month = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${month}-${day}`;
}

/** Group visits by their start date "YYYY-MM-DD". Generic so subtypes (VisitWithJob) are preserved. */
export function groupVisitsByDay<T extends JobVisit>(visits: T[]): Record<string, T[]> {
	return visits.reduce(
		(acc, visit) => {
			const dateStr = localDateKey(visit.scheduled_start_at);
			if (!acc[dateStr]) acc[dateStr] = [];
			acc[dateStr].push(visit);
			return acc;
		},
		{} as Record<string, T[]>
	);
}

/** Get the 7 ISO date strings (YYYY-MM-DD) for the week containing `date`, starting Monday */
export function getWeekDays(date: Date): string[] {
	const day = date.getDay(); // 0=Sun
	const monday = new Date(date);
	monday.setDate(date.getDate() - ((day + 6) % 7));
	return Array.from({ length: 7 }, (_, i) => {
		const d = new Date(monday);
		d.setDate(monday.getDate() + i);
		return localDateKey(d);
	});
}

// ─── Popup / reschedule helpers ───────────────────────────────────────────────

/** Format a "YYYY-MM-DD" string as a short display label, e.g. "Mon, Apr 7" */
export function formatDateDisplay(dateStr: string): string {
	const d = new Date(dateStr + "T12:00:00"); // noon avoids DST edge
	return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Date → "HH:MM" 24-hour string */
export function dateToHHMM(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "HH:MM" → a Date set to that time (today's date; used for TimePicker). Returns null on bad input. */
export function hhmmToPickerDate(hhmm: string): Date | null {
	if (!hhmm) return null;
	const [h, m] = hhmm.split(":").map(Number);
	if (Number.isNaN(h) || Number.isNaN(m)) return null;
	const d = new Date();
	d.setHours(h, m, 0, 0);
	return d;
}

/** Rendered width of the click-detail popups (VisitClickPopup / OccurrenceClickPopup) */
export const CLICK_POPUP_W = 280;
/** Tallest the click-detail popups get (2-line title + all facts + description), for viewport clamps. */
export const CLICK_POPUP_H = 320;
/** Rendered width of the drag/click reschedule popups. */
export const RESCHEDULE_POPUP_W = 308;

/** Read once per mount; callers don't react to the OS setting changing mid-session. */
export function prefersReducedMotion(): boolean {
	return (
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * Viewport coordinates for a popup anchored beside an element.
 *
 * VisitClickPopup renders through a portal on document.body, so callers must
 * supply viewport (position: fixed) coordinates — offsets relative to a day
 * column resolve against the page instead and land in the wrong column.
 */
export function getAnchoredPopupPos(
	anchor: { left: number; right: number; top: number },
	{
		popupH,
		popupW = CLICK_POPUP_W,
		viewport,
	}: {
		popupH: number;
		popupW?: number;
		viewport?: { width: number; height: number };
	},
): { top: number; left: number } {
	const PAD = 8;
	const GAP = 4;
	const vw = viewport?.width ?? window.innerWidth;
	const vh = viewport?.height ?? window.innerHeight;

	const fitsRight = anchor.right + GAP + popupW + PAD <= vw;
	const left = fitsRight
		? anchor.right + GAP
		: Math.max(PAD, anchor.left - popupW - GAP);
	const top = Math.max(PAD, Math.min(anchor.top, vh - popupH - PAD));

	return { top, left };
}

/** Shared style for column-label headings inside reschedule popups */
export const POPUP_LABEL_STYLE: CSSProperties = {
	fontSize: 9,
	fontWeight: 700,
	color: "var(--color-text-tertiary)",
	textTransform: "uppercase",
	letterSpacing: "0.06em",
};

/** Shared muted text style inside reschedule popups */
export const POPUP_MUTED_STYLE: CSSProperties = {
	fontSize: 9,
	color: "var(--color-text-tertiary)",
};

/** Shared <select> style inside reschedule popups */
export const POPUP_SELECT_STYLE: CSSProperties = {
	background: "var(--color-surface)",
	border: "1px solid var(--color-border)",
	borderRadius: 4,
	color: "var(--color-sched-text-primary)",
	fontSize: 10,
	padding: "4px 6px",
	cursor: "pointer",
	outline: "none",
	width: "100%",
	transition: "border-color 0.15s ease-out",
};

// ─── Day header ───────────────────────────────────────────────────────────────

/** Format a date string "YYYY-MM-DD" to display label */
export function formatDayHeader(dateStr: string): { weekday: string; day: string } {
	const d = new Date(dateStr + "T12:00:00"); // noon avoids DST edge
	return {
		weekday: d.toLocaleDateString("en-US", { weekday: "short" }),
		day: String(d.getDate()),
	};
}
