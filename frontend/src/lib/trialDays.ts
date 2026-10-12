export const trialEndsInDays = (endsAt: string, now = Date.now()) =>
	Math.max(1, Math.ceil((Date.parse(endsAt) - now) / 86_400_000));

// Trial and invite dates are the org's calendar day, so the customer's rail, the staff
// screens and the emails (backend, org timezone) all name the same date.
export const shortDateIn = (iso: string, timeZone: string, withYear = false) =>
	new Date(iso).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(withYear && { year: "numeric" }),
		timeZone,
	});

function zoneOffsetMs(at: Date, timeZone: string) {
	const p = Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		})
			.formatToParts(at)
			.map((x) => [x.type, x.value]),
	);
	const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
	return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** 23:59:59 on `date` (YYYY-MM-DD) by the org's clock, as an ISO instant. */
export function endOfDayIn(date: string, timeZone: string): string {
	const wall = Date.parse(`${date}T23:59:59Z`);
	// Second pass: the offset at the guess can differ from the answer's across a DST switch.
	const guess = wall - zoneOffsetMs(new Date(wall), timeZone);
	return new Date(wall - zoneOffsetMs(new Date(guess), timeZone)).toISOString();
}
