export const DAY_MIN_W = 150;
export const ZOOMED_MIN_W = 300;
// Dashboard strip: no gutter, no horizontal scroll. Below 240px DayAgenda's
// header cannot hold its two controls even stacked.
export const STRIP_DAY_MIN_W = 64;
export const STRIP_ZOOMED_MIN_W = 240;

function dayTrack(isZoomed: boolean, dayMin: number, zoomedMin: number): string {
	return isZoomed ? `minmax(${zoomedMin}px, 2fr)` : `minmax(${dayMin}px, 1fr)`;
}

// Explicit tracks rather than repeat(): the browser only animates
// grid-template-columns between track lists of identical shape.
export function buildWeekTemplate(
	weekDays: string[],
	zoomedDay: string | null,
	gutterW: number
): { gridTemplateColumns: string; gridMinWidth: number } {
	const zoomed = zoomedDay !== null && weekDays.includes(zoomedDay) ? zoomedDay : null;
	const tracks = weekDays.map((d) => dayTrack(d === zoomed, DAY_MIN_W, ZOOMED_MIN_W));
	const gridMinWidth =
		gutterW + weekDays.length * DAY_MIN_W + (zoomed ? ZOOMED_MIN_W - DAY_MIN_W : 0);
	return { gridTemplateColumns: `${gutterW}px ${tracks.join(" ")}`, gridMinWidth };
}

export function buildStripTemplate(days: string[], zoomedDay: string | null): string {
	return days
		.map((d) => dayTrack(d === zoomedDay, STRIP_DAY_MIN_W, STRIP_ZOOMED_MIN_W))
		.join(" ");
}
