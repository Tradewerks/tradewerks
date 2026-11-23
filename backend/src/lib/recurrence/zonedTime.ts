/**
 * Wall-clock helpers for the recurrence engine. A plan's "08:00 every Monday"
 * means 08:00 on the org's wall, so occurrences are computed as local dates and
 * times and converted to UTC instants only at the edge.
 */

/** A calendar date with no zone, "YYYY-MM-DD". */
export type LocalDate = string;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(tz, f);
	}
	return f;
}

interface WallParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function wallParts(at: Date, tz: string): WallParts {
	const out: Record<string, number> = {};
	for (const p of formatterFor(tz).formatToParts(at)) {
		if (p.type !== "literal") out[p.type] = Number(p.value);
	}
	return {
		year: out.year,
		month: out.month,
		day: out.day,
		hour: out.hour,
		minute: out.minute,
		second: out.second,
	};
}

/** Zone offset at `at`, in ms (local minus UTC). */
function offsetMs(at: Date, tz: string): number {
	const p = wallParts(at, tz);
	const asUtc = Date.UTC(
		p.year,
		p.month - 1,
		p.day,
		p.hour,
		p.minute,
		p.second,
	);
	const whole = at.getTime() - (at.getTime() % 1000);
	return asUtc - whole;
}

function parseLocalDate(d: LocalDate): [number, number, number] {
	const m = LOCAL_DATE_RE.exec(d);
	if (!m) throw new RangeError(`Invalid local date: ${d}`);
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const day = Number(m[3]);
	if (mo < 1 || mo > 12 || day < 1 || day > daysInMonth(y, mo)) {
		throw new RangeError(`Invalid local date: ${d}`);
	}
	return [y, mo, day];
}

function pad(n: number, width = 2): string {
	return String(n).padStart(width, "0");
}

function fromUtcMidnight(ms: number): LocalDate {
	const d = new Date(ms);
	return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(
		d.getUTCDate(),
	)}`;
}

function utcMidnight(d: LocalDate): number {
	const [y, mo, day] = parseLocalDate(d);
	return Date.UTC(y, mo - 1, day);
}

export function toLocalDate(at: Date, tz: string): LocalDate {
	const p = wallParts(at, tz);
	return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function localWallTime(
	at: Date,
	tz: string,
): { date: LocalDate; hhmm: string } {
	const p = wallParts(at, tz);
	return {
		date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`,
		hhmm: `${pad(p.hour)}:${pad(p.minute)}`,
	};
}

/**
 * The UTC instant at which the wall clock in `tz` reads `date hhmm`.
 * Two-pass: guess the offset at the naive instant, then re-check it at the
 * candidate. A wall time skipped by spring-forward resolves forward (02:30 ->
 * 03:30); one repeated by fall-back resolves to the earlier instant.
 */
export function zonedWallTimeToUtc(
	date: LocalDate,
	hhmm: string,
	tz: string,
): Date {
	const t = HHMM_RE.exec(hhmm);
	if (!t) throw new RangeError(`Invalid wall time: ${hhmm}`);
	const naive =
		utcMidnight(date) + (Number(t[1]) * 60 + Number(t[2])) * MINUTE_MS;

	const off1 = offsetMs(new Date(naive), tz);
	const off2 = offsetMs(new Date(naive - off1), tz);

	// Also probe a day either side: the two passes alone only see one side
	// of an overlap for zones east of UTC, where the naive guess lands after
	// the real instant, and would return the later reading.
	const offsets = new Set([
		off1,
		off2,
		offsetMs(new Date(naive - DAY_MS), tz),
		offsetMs(new Date(naive + DAY_MS), tz),
	]);
	const valid: number[] = [];
	const all: number[] = [];
	for (const off of offsets) {
		const c = naive - off;
		all.push(c);
		if (offsetMs(new Date(c), tz) === off) valid.push(c);
	}
	if (valid.length > 0) return new Date(Math.min(...valid));
	// No offset reproduces this wall time: it fell in a spring-forward gap.
	// Reading it with the pre-transition offset lands just past the gap.
	return new Date(Math.max(...all));
}

export function addLocalDays(d: LocalDate, n: number): LocalDate {
	return fromUtcMidnight(utcMidnight(d) + n * DAY_MS);
}

export function daysInMonth(year: number, month1: number): number {
	return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

export function isoWeekday(d: LocalDate): 1 | 2 | 3 | 4 | 5 | 6 | 7 {
	const js = new Date(utcMidnight(d)).getUTCDay();
	return (js === 0 ? 7 : js) as 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

export function isoWeekStart(d: LocalDate): LocalDate {
	return addLocalDays(d, 1 - isoWeekday(d));
}

/**
 * Whole calendar days `a - b` (positive when `a` is later), the date-fns
 * differenceInDays(left, right) convention.
 */
export function diffLocalDays(a: LocalDate, b: LocalDate): number {
	return Math.round((utcMidnight(a) - utcMidnight(b)) / DAY_MS);
}
