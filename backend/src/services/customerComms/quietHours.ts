import { DAY_MS, localTimeOnDay } from "../../lib/dayRange.js";

const OPEN = "08:00";
const CLOSE = "20:00";

/**
 * Moves `at` into the 08:00–20:00 window of `tz`. "defer" goes to the next
 * 08:00; "advance" goes back to the previous 20:00, so a reminder never lands
 * after the visit it announces. Times inside the window come back unchanged.
 */
export function holdForQuietHours(
	at: Date,
	tz: string,
	mode: "defer" | "advance",
): Date {
	const open = localTimeOnDay(at, OPEN, tz);
	const close = localTimeOnDay(at, CLOSE, tz);
	if (at >= open && at <= close) return at;
	const early = at < open;
	if (mode === "defer")
		return early ? open : localTimeOnDay(shiftDay(at, tz, 1), OPEN, tz);
	return early ? localTimeOnDay(shiftDay(at, tz, -1), CLOSE, tz) : close;
}

// An instant on the neighbouring local calendar day. Steps from local noon:
// a 23- or 25-hour day moves noon by an hour, never across midnight.
function shiftDay(at: Date, tz: string, days: 1 | -1): Date {
	const noon = localTimeOnDay(at, "12:00", tz);
	return new Date(noon.getTime() + days * DAY_MS);
}
