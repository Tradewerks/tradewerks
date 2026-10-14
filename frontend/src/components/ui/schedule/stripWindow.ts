import { dateKeyAt, getWeekDays, localDateKey } from "./scheduleBoardUtils";

export type ColMode = "full" | "three" | "one";

// ≥ STRIP_ZOOMED_MIN_W + 6 × STRIP_DAY_MIN_W (624): narrower than this, a 7-day
// strip cannot give the zoomed day a readable agenda.
export const FULL_MIN_W = 640;
const THREE_MIN_W = 350;

function addDays(key: string, n: number): string {
	const d = dateKeyAt(key);
	d.setDate(d.getDate() + n);
	return localDateKey(d);
}

export function colModeForWidth(width: number): ColMode {
	return width >= FULL_MIN_W ? "full" : width >= THREE_MIN_W ? "three" : "one";
}

export function visibleWindow(anchor: string, mode: ColMode): string[] {
	if (mode === "one") return [anchor];
	if (mode === "three") return [addDays(anchor, -1), anchor, addDays(anchor, 1)];
	return getWeekDays(dateKeyAt(anchor));
}

const STEP: Record<ColMode, number> = { full: 7, three: 3, one: 1 };

export function shiftAnchor(anchor: string, mode: ColMode, dir: -1 | 1): string {
	return addDays(anchor, dir * STEP[mode]);
}

const shortMonth = (d: Date) => d.toLocaleDateString("en-US", { month: "short" });

export function windowLabel(days: string[], mode: ColMode): string {
	const first = dateKeyAt(days[0]);
	if (mode === "one") {
		return first.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
	}
	const last = dateKeyAt(days[days.length - 1]);
	const sameMonth =
		first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
	const range = sameMonth
		? `${shortMonth(first)} ${first.getDate()} – ${last.getDate()}`
		: `${shortMonth(first)} ${first.getDate()} – ${shortMonth(last)} ${last.getDate()}`;
	return mode === "full" ? `${range}, ${last.getFullYear()}` : range;
}

const NAV: Record<ColMode, { prev: string; next: string }> = {
	full: { prev: "Previous week", next: "Next week" },
	three: { prev: "Previous 3 days", next: "Next 3 days" },
	one: { prev: "Previous day", next: "Next day" },
};

export function navLabels(mode: ColMode): { prev: string; next: string } {
	return NAV[mode];
}

export function defaultZoom(days: string[], today: string, mode: ColMode): string | null {
	if (mode === "one") return days[0];
	return days.includes(today) ? today : null;
}

export function effectiveZoom(
	days: string[],
	zoomedDay: string | null,
	mode: ColMode
): string | null {
	if (mode === "one") return days[0];
	return zoomedDay !== null && days.includes(zoomedDay) ? zoomedDay : null;
}

const KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Monday key of the week containing a `?week=` value; null when absent or not a real date. */
export function weekParamToMonday(value: string | null): string | null {
	if (!value || !KEY_RE.test(value)) return null;
	// Date rolls 2026-02-31 over to Mar 3; the round-trip catches it.
	if (localDateKey(dateKeyAt(value)) !== value) return null;
	return visibleWindow(value, "full")[0];
}
