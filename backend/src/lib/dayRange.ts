/**
 * Day-boundary math, in whichever timezone the caller means. Single source of
 * truth: every consumer that passes an org timezone gets the day its users see on
 * the wall, so a purchase at 21:00 local counts against that day's ceiling and a
 * seven-day window covers seven of them.
 */

/** The local calendar date in `timezone` at the instant `at`. Month is 0-based. */
function localParts(at: Date, timezone?: string): { year: number; month: number; day: number } {
	if (!timezone || timezone === "UTC") {
		return { year: at.getUTCFullYear(), month: at.getUTCMonth(), day: at.getUTCDate() };
	}
	// formatToParts is the only reliable way to read year/month/day in an
	// arbitrary IANA zone; en-CA gives zero-padded numeric parts.
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(at);
	const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value, 10);
	return { year: get("year"), month: get("month") - 1, day: get("day") };
}

/** How far ahead of UTC `timezone` is at the instant `at`, in milliseconds. */
function offsetMsAt(at: Date, timezone: string): number {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).formatToParts(at);
	const p: Record<string, number> = {};
	for (const part of parts) {
		if (part.type !== "literal") p[part.type] = parseInt(part.value, 10);
	}
	// Some engines render midnight as hour 24 under hour12:false.
	const hour = p.hour === 24 ? 0 : p.hour!;
	const wallAsUtc = Date.UTC(p.year!, p.month! - 1, p.day!, hour, p.minute!, p.second!);
	// The formatted wall clock has no sub-second part, so drop it from both sides
	// or the offset comes back off by up to 999ms.
	return wallAsUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The instant midnight happened in `timezone` on the given calendar date. Month
 * and day overflow the way Date.UTC allows, so callers can add days directly.
 */
function localMidnight(year: number, month: number, day: number, timezone: string): Date {
	return localWallClock(year, month, day, 0, 0, timezone);
}

// generalized local midnight
function localWallClock(year: number, month: number, day: number, hour:number, minute: number, timezone: string): Date {
	// Guessed as if the zone were UTC, then corrected by the offset actually in
	// force. The correction is re-checked once because the guess can land on the
	// wrong side of a DST transition; one repeat settles every zone whose midnight
	// exists. In a zone whose DST gap starts at midnight (e.g. America/Havana),
	// midnight itself is skipped, and the settled instant resolves to the moment
	// just before the gap — the last real instant of that calendar date.
	const asIfUtc = Date.UTC(year, month, day, hour, minute);
	const firstGuess = asIfUtc - offsetMsAt(new Date(asIfUtc), timezone);
	const settled = offsetMsAt(new Date(firstGuess), timezone);
	return new Date(asIfUtc - settled);
}

// `hhmm` on the calendar day `at` falls on in `timezone`, as an instant
export function localTimeOnDay(at: Date, hhmm: string, timezone: string): Date {
	const { year, month, day } = localParts(at, timezone);
	const [hour, minute] = hhmm.split(":").map(Number);
	return localWallClock(year, month, day, hour, minute, timezone);
}

/**
 * Midnight of `base`'s day through midnight `days` later, both as instants.
 *
 * With `timezone` omitted or "UTC" these are UTC midnights, unchanged from the
 * original implementation. With an IANA zone they are that zone's midnights, so a
 * day is 23 or 25 hours long across a DST edge and `days` counts calendar days.
 */
export function utcDayRange(
	base: Date = new Date(),
	days = 1,
	timezone?: string,
): { start: Date; end: Date } {
	const { year, month, day } = localParts(base, timezone);
	if (!timezone || timezone === "UTC") {
		return {
			start: new Date(Date.UTC(year, month, day)),
			end: new Date(Date.UTC(year, month, day + days)),
		};
	}
	return {
		start: localMidnight(year, month, day, timezone),
		end: localMidnight(year, month, day + days, timezone),
	};
}

/**
 * The YYYY-MM-DD the wall clock in `timezone` reads, `offsetDays` calendar days
 * from `base`. Resolved in calendar space rather than by adding milliseconds to an
 * instant: the answer is a date on a calendar, and a DST day is not 24 hours.
 */
export function localDateString(
	base: Date = new Date(),
	timezone = "UTC",
	offsetDays = 0,
): string {
	const { year, month, day } = localParts(base, timezone);
	return new Date(Date.UTC(year, month, day + offsetDays)).toISOString().slice(0, 10);
}

// "YYYY-MM-DD" -> that week's Monday at UTC midnight, matching the @db.Date column.
export function weekStartOf(date: string): Date {
	const d = new Date(`${date}T00:00:00.000Z`);
	d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
	return d;
}

export function weekRangeIn(weekStart: Date, timezone: string) {
	return utcDayRange(new Date(weekStart.getTime() + 12 * 3_600_000), 7, timezone);
}
