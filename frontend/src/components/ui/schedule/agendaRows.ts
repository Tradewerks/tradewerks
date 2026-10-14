import { itemStart, type AgendaGroup } from "./dashboardCalendarUtils";

export type AgendaEntry = AgendaGroup["items"][number];

export interface AgendaRowModel {
	key: string;
	entry: AgendaEntry;
	anytime: boolean;
	time: string;
	suffix: string;
	/** False when the previous row starts at the same time; the rail prints it once. */
	showTime: boolean;
	startMs: number;
}

/** Local h:mm plus am/pm, built by hand so the rail never depends on the locale's clock format. */
export function railTimeFromMs(ms: number): { time: string; suffix: string } {
	const d = new Date(ms);
	const h = d.getHours();
	const mm = String(d.getMinutes()).padStart(2, "0");
	return { time: `${h % 12 || 12}:${mm}`, suffix: h < 12 ? "am" : "pm" };
}

export function isAnytimeEntry(entry: AgendaEntry): boolean {
	if (entry.type === "visit") return entry.item.arrival_constraint === "anytime";
	// The backend stores anytime occurrences at 09:00; midnight only covers rows without a constraint.
	if (entry.item.arrival_constraint) return entry.item.arrival_constraint === "anytime";
	const d = new Date(entry.item.occurrence_start_at);
	return d.getHours() === 0 && d.getMinutes() === 0;
}

/** Rows in display order: Anytime first, then the caller's (chronological) order. */
export function buildAgendaRows(items: AgendaEntry[], keyPrefix: string): AgendaRowModel[] {
	const ordered = items
		.map((entry, i) => ({ entry, i, anytime: isAnytimeEntry(entry) }))
		.sort((a, b) => (a.anytime === b.anytime ? a.i - b.i : a.anytime ? -1 : 1));
	let prev: string | null = null;
	return ordered.map(({ entry, anytime }) => {
		const ms = itemStart(entry);
		// Same instant the rows sort and the now rule place by, so label and position agree.
		const { time, suffix } = anytime ? { time: "", suffix: "" } : railTimeFromMs(ms);
		const stamp = anytime ? "anytime" : time + suffix;
		const showTime = stamp !== prev;
		prev = stamp;
		return {
			key: `${keyPrefix}:${entry.type}:${entry.item.id}`,
			entry,
			anytime,
			time,
			suffix,
			showTime,
			startMs: ms,
		};
	});
}

/** Index the now rule is inserted before (rows.length = after all); null without timed rows. */
export function nowRuleIndex(rows: AgendaRowModel[], nowMs: number): number | null {
	if (!rows.some((r) => !r.anytime)) return null;
	let index = 0;
	rows.forEach((r, i) => {
		if (r.anytime || r.startMs <= nowMs) index = i + 1;
	});
	return index;
}

function shortName(full: string): string {
	const parts = full.trim().split(/\s+/);
	if (parts.length < 2) return parts[0] ?? "";
	return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export function whoLabel(names: string[]): string {
	if (names.length === 0) return "Unassigned";
	if (names.length === 1) return names[0];
	if (names.length === 2) return names.map(shortName).join(", ");
	return `${names.length} techs`;
}

export function countAgenda(groups: AgendaGroup[]): { visits: number; occs: number } {
	const visits = new Set<string>();
	const occs = new Set<string>();
	for (const g of groups) {
		for (const e of g.items) (e.type === "visit" ? visits : occs).add(e.item.id);
	}
	return { visits: visits.size, occs: occs.size };
}

export function agendaCountLabel(visits: number, occs: number): string {
	if (visits === 0 && occs === 0) return "No visits";
	const v = `${visits} ${visits === 1 ? "visit" : "visits"}`;
	if (occs === 0) return v;
	if (visits === 0) return `${occs} recurring`;
	return `${v}, ${occs} recurring`;
}

/** Everything that changes the agenda's height; the overflow hook recounts when it changes. */
export function agendaSignature(
	groups: AgendaGroup[],
	sortMode: "tech" | "time",
	showNow: boolean
): string {
	const body = groups
		.map(
			(g) =>
				`${g.techId}:${g.items
					.map((e) => `${e.type}.${e.item.id}.${e.item.job_obj?.name ?? ""}`)
					.join(",")}`
		)
		.join(";");
	return `${sortMode}|${showNow ? 1 : 0}|${body}`;
}
