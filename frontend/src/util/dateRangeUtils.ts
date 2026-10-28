export type DateRangeOption =
	| "all"
	| "today"
	| "last_7_days"
	| "last_30_days"
	| "this_month"
	| "tomorrow"
	| "next_7_days"
	| "next_30_days"
	| "next_month"
	| "custom";

export interface DateRangeValue {
	option: DateRangeOption;
	startDate?: Date;
	endDate?: Date;
}

const VALID_OPTIONS: DateRangeOption[] = [
	"all",
	"today",
	"last_7_days",
	"last_30_days",
	"this_month",
	"tomorrow",
	"next_7_days",
	"next_30_days",
	"next_month",
	"custom",
];

const MONTH_ABBREVS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Returns start-of-day (00:00:00.000) in local time. */
function localStartOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

/** Returns end-of-day (23:59:59.999) in local time. */
function localEndOfDay(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * Returns a Date representing the UTC calendar date of the input, interpreted
 * as a local Date. For example, new Date("2025-01-01") is UTC midnight which
 * in UTC-5 is Dec 31 local — this returns a local-time date for Jan 1.
 */
export function toLocalDate(d: Date): Date {
	// Use UTC components to extract the intended calendar date,
	// then construct it as a local-time date.
	return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Subtracts `days` from a Date (local calendar days). */
function subDays(d: Date, days: number): Date {
	const result = new Date(d);
	result.setDate(result.getDate() - days);
	return result;
}

/** Adds `days` to a Date (local calendar days). */
function addDays(d: Date, days: number): Date {
	const result = new Date(d);
	result.setDate(result.getDate() + days);
	return result;
}

/** Returns a "MMM D" label (e.g. "Jan 1") from a local-time date. */
function formatMonthDay(d: Date): string {
	return `${MONTH_ABBREVS[d.getMonth()]} ${d.getDate()}`;
}

/** Formats a local-time date as "YYYY-MM-DD". */
function formatISODate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

export function resolveDateRange(value: DateRangeValue): { start: Date; end: Date } | null {
	const now = new Date();
	switch (value.option) {
		case "all":
			return null;
		case "today":
			return { start: localStartOfDay(now), end: localEndOfDay(now) };
		case "last_7_days":
			return { start: localStartOfDay(subDays(now, 6)), end: localEndOfDay(now) };
		case "last_30_days":
			return { start: localStartOfDay(subDays(now, 29)), end: localEndOfDay(now) };
		case "this_month":
			return { start: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0), end: localEndOfDay(now) };
		case "tomorrow":
			return { start: localStartOfDay(addDays(now, 1)), end: localEndOfDay(addDays(now, 1)) };
		case "next_7_days":
			return { start: localStartOfDay(now), end: localEndOfDay(addDays(now, 6)) };
		case "next_30_days":
			return { start: localStartOfDay(now), end: localEndOfDay(addDays(now, 29)) };
		case "next_month":
			// day 0 of month m+2 is the last day of month m+1
			return {
				start: new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0),
				end: new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999),
			};
		case "custom":
			if (!value.startDate || !value.endDate) return null;
			return {
				start: localStartOfDay(toLocalDate(value.startDate)),
				end: localEndOfDay(toLocalDate(value.endDate)),
			};
	}
}

export function matchesDateRange(date: Date | null, value: DateRangeValue): boolean {
	if (value.option === "all") return true;
	if (!date) return false;
	const range = resolveDateRange(value);
	if (!range) return true;
	return date >= range.start && date <= range.end;
}

/** Whether a span (open-ended when `end` is null) is in effect at any point in the range. */
export function overlapsDateRange(start: Date, end: Date | null, value: DateRangeValue): boolean {
	if (value.option === "all") return true;
	const range = resolveDateRange(value);
	if (!range) return true;
	return start <= range.end && (end === null || end >= range.start);
}

export function formatTriggerLabel(value: DateRangeValue): string {
	switch (value.option) {
		case "all":
			return "All";
		case "today":
			return "Today";
		case "last_7_days":
			return "Last 7 days";
		case "last_30_days":
			return "Last 30 days";
		case "this_month":
			return "This month";
		case "tomorrow":
			return "Tomorrow";
		case "next_7_days":
			return "Next 7 days";
		case "next_30_days":
			return "Next 30 days";
		case "next_month":
			return "Next month";
		case "custom":
			if (value.startDate && value.endDate) {
				return `${formatMonthDay(value.startDate)} – ${formatMonthDay(value.endDate)}`;
			}
			return "Custom range";
	}
}

export function parseDateRangeFromParams(params: URLSearchParams, key: string): DateRangeValue {
	const option = params.get(key);
	if (!option || !VALID_OPTIONS.includes(option as DateRangeOption)) {
		return { option: "all" };
	}
	if (option === "custom") {
		const fromStr = params.get(`${key}From`);
		const toStr = params.get(`${key}To`);
		if (!fromStr || !toStr) return { option: "all" };
		// Parse as UTC (ISO date-only strings are UTC by spec)
		const startDate = new Date(fromStr);
		const endDate = new Date(toStr);
		if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return { option: "all" };
		return { option: "custom", startDate: toLocalDate(startDate), endDate: toLocalDate(endDate) };
	}
	return { option: option as DateRangeOption };
}

export function serializeDateRange(
	value: DateRangeValue,
	key: string,
	params: URLSearchParams,
): URLSearchParams {
	const next = new URLSearchParams(params);
	next.delete(key);
	next.delete(`${key}From`);
	next.delete(`${key}To`);
	if (value.option === "all") return next;
	next.set(key, value.option);
	if (value.option === "custom" && value.startDate && value.endDate) {
		next.set(`${key}From`, formatISODate(value.startDate));
		next.set(`${key}To`, formatISODate(value.endDate));
	}
	return next;
}
