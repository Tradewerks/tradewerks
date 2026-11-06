import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Force a DST-observing zone so the spring-forward / fall-back cases below are real.
// Must run before dateRangeUtils (and any Date math) is evaluated.
process.env.TZ = "America/New_York";

const {
	resolveDateRange,
	matchesDateRange,
	overlapsDateRange,
	parseDateRangeFromParams,
	serializeDateRange,
	formatTriggerLabel,
	toLocalDate,
} = await import("../dateRangeUtils");

type Parts = [year: number, month: number, day: number];

/** Local-time calendar parts of a Date, for readable assertions. */
const ymd = (d: Date): Parts => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
const startOfDay = (d: Date) =>
	d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
const endOfDay = (d: Date) =>
	d.getHours() === 23 && d.getMinutes() === 59 && d.getSeconds() === 59 && d.getMilliseconds() === 999;

const freeze = (local: string) => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date(local)); // no "Z" → parsed as local time
};

beforeAll(() => {
	// Sanity: the zone override took effect (Jan is UTC-5 → offset 300).
	expect(new Date(2026, 0, 15, 12).getTimezoneOffset()).toBe(300);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("resolveDateRange — month-end rollover (Jan 31)", () => {
	it("tomorrow is Feb 1", () => {
		freeze("2026-01-31T10:00:00");
		const r = resolveDateRange({ option: "tomorrow" })!;
		expect(ymd(r.start)).toEqual([2026, 2, 1]);
		expect(ymd(r.end)).toEqual([2026, 2, 1]);
		expect(startOfDay(r.start)).toBe(true);
		expect(endOfDay(r.end)).toBe(true);
	});

	it("next_7_days is Jan 31 … Feb 6 inclusive (7 calendar days)", () => {
		freeze("2026-01-31T10:00:00");
		const r = resolveDateRange({ option: "next_7_days" })!;
		expect(ymd(r.start)).toEqual([2026, 1, 31]);
		expect(ymd(r.end)).toEqual([2026, 2, 6]);
	});

	it("next_30_days is Jan 31 … Mar 1 inclusive (30 calendar days, 2026 not leap)", () => {
		freeze("2026-01-31T10:00:00");
		const r = resolveDateRange({ option: "next_30_days" })!;
		expect(ymd(r.start)).toEqual([2026, 1, 31]);
		expect(ymd(r.end)).toEqual([2026, 3, 1]);
	});

	it("next_month is Feb 1 … Feb 28 (does not skip to March when today is the 31st)", () => {
		freeze("2026-01-31T10:00:00");
		const r = resolveDateRange({ option: "next_month" })!;
		expect(ymd(r.start)).toEqual([2026, 2, 1]);
		expect(ymd(r.end)).toEqual([2026, 2, 28]);
		expect(startOfDay(r.start)).toBe(true);
		expect(endOfDay(r.end)).toBe(true);
	});

	it("this_month is Jan 1 … end of today", () => {
		freeze("2026-01-31T10:00:00");
		const r = resolveDateRange({ option: "this_month" })!;
		expect(ymd(r.start)).toEqual([2026, 1, 1]);
		expect(ymd(r.end)).toEqual([2026, 1, 31]);
		expect(endOfDay(r.end)).toBe(true);
	});

	it("last_7_days / last_30_days count today as day 1", () => {
		freeze("2026-01-31T10:00:00");
		expect(ymd(resolveDateRange({ option: "last_7_days" })!.start)).toEqual([2026, 1, 25]);
		expect(ymd(resolveDateRange({ option: "last_30_days" })!.start)).toEqual([2026, 1, 2]);
	});
});

describe("resolveDateRange — year rollover (Dec 15)", () => {
	it("next_month is Jan 1 … Jan 31 of the following year", () => {
		freeze("2026-12-15T10:00:00");
		const r = resolveDateRange({ option: "next_month" })!;
		expect(ymd(r.start)).toEqual([2027, 1, 1]);
		expect(ymd(r.end)).toEqual([2027, 1, 31]);
	});

	it("next_30_days crosses into January", () => {
		freeze("2026-12-15T10:00:00");
		const r = resolveDateRange({ option: "next_30_days" })!;
		expect(ymd(r.start)).toEqual([2026, 12, 15]);
		expect(ymd(r.end)).toEqual([2027, 1, 13]);
	});

	it("this_month starts Dec 1", () => {
		freeze("2026-12-15T10:00:00");
		expect(ymd(resolveDateRange({ option: "this_month" })!.start)).toEqual([2026, 12, 1]);
	});

	it("tomorrow on Dec 31 is Jan 1 next year", () => {
		freeze("2026-12-31T23:30:00");
		const r = resolveDateRange({ option: "tomorrow" })!;
		expect(ymd(r.start)).toEqual([2027, 1, 1]);
		expect(ymd(r.end)).toEqual([2027, 1, 1]);
	});
});

describe("resolveDateRange — DST boundaries (America/New_York)", () => {
	it("spring forward (Mar 8 2026): tomorrow / next_7_days land on exact local midnights", () => {
		freeze("2026-03-07T22:00:00"); // the night before the 23-hour day
		const tomorrow = resolveDateRange({ option: "tomorrow" })!;
		expect(ymd(tomorrow.start)).toEqual([2026, 3, 8]);
		expect(startOfDay(tomorrow.start)).toBe(true);
		expect(endOfDay(tomorrow.end)).toBe(true);

		const week = resolveDateRange({ option: "next_7_days" })!;
		expect(ymd(week.start)).toEqual([2026, 3, 7]);
		expect(ymd(week.end)).toEqual([2026, 3, 13]);
		expect(endOfDay(week.end)).toBe(true);
		// The zone actually shifted inside the window.
		expect(week.start.getTimezoneOffset()).toBe(300);
		expect(week.end.getTimezoneOffset()).toBe(240);
	});

	it("fall back (Nov 1 2026): next_30_days / next_month keep calendar-day semantics", () => {
		freeze("2026-10-31T09:00:00");
		const month = resolveDateRange({ option: "next_30_days" })!;
		expect(ymd(month.start)).toEqual([2026, 10, 31]);
		expect(ymd(month.end)).toEqual([2026, 11, 29]);
		expect(endOfDay(month.end)).toBe(true);

		const next = resolveDateRange({ option: "next_month" })!;
		expect(ymd(next.start)).toEqual([2026, 11, 1]);
		expect(ymd(next.end)).toEqual([2026, 11, 30]);
		expect(startOfDay(next.start)).toBe(true);
	});

	it("today on the fall-back day spans the full 25-hour local day", () => {
		freeze("2026-11-01T12:00:00");
		const r = resolveDateRange({ option: "today" })!;
		expect(ymd(r.start)).toEqual([2026, 11, 1]);
		expect(ymd(r.end)).toEqual([2026, 11, 1]);
		expect(r.end.getTime() - r.start.getTime()).toBe(25 * 60 * 60 * 1000 - 1);
	});
});

describe("resolveDateRange — custom / all", () => {
	it("returns null for all and for custom without both dates", () => {
		expect(resolveDateRange({ option: "all" })).toBeNull();
		expect(resolveDateRange({ option: "custom", startDate: new Date() })).toBeNull();
	});

	it("custom expands to local start/end of the given calendar days", () => {
		const r = resolveDateRange({
			option: "custom",
			startDate: new Date(2026, 4, 3),
			endDate: new Date(2026, 4, 9),
		})!;
		expect(ymd(r.start)).toEqual([2026, 5, 3]);
		expect(ymd(r.end)).toEqual([2026, 5, 9]);
		expect(startOfDay(r.start)).toBe(true);
		expect(endOfDay(r.end)).toBe(true);
	});
});

describe("matchesDateRange", () => {
	it("all matches everything, including null dates", () => {
		expect(matchesDateRange(null, { option: "all" })).toBe(true);
	});

	it("null dates never match a concrete range", () => {
		freeze("2026-01-31T10:00:00");
		expect(matchesDateRange(null, { option: "today" })).toBe(false);
	});

	it("is inclusive at both ends of the day", () => {
		freeze("2026-01-31T10:00:00");
		expect(matchesDateRange(new Date(2026, 0, 31, 0, 0, 0, 0), { option: "today" })).toBe(true);
		expect(matchesDateRange(new Date(2026, 0, 31, 23, 59, 59, 999), { option: "today" })).toBe(true);
		expect(matchesDateRange(new Date(2026, 1, 1, 0, 0, 0, 0), { option: "today" })).toBe(false);
	});
});

describe("URL round trip", () => {
	it("serializes custom ranges as YYYY-MM-DD and parses them back to the same local days", () => {
		const value = {
			option: "custom" as const,
			startDate: new Date(2026, 0, 31),
			endDate: new Date(2026, 1, 2),
		};
		const params = serializeDateRange(value, "date", new URLSearchParams("x=1"));
		expect(params.get("date")).toBe("custom");
		expect(params.get("dateFrom")).toBe("2026-01-31");
		expect(params.get("dateTo")).toBe("2026-02-02");

		const parsed = parseDateRangeFromParams(params, "date");
		expect(parsed.option).toBe("custom");
		expect(ymd(parsed.startDate!)).toEqual([2026, 1, 31]);
		expect(ymd(parsed.endDate!)).toEqual([2026, 2, 2]);
		expect(formatTriggerLabel(parsed)).toBe("Jan 31 – Feb 2");
	});

	it("falls back to all for unknown options or incomplete custom params", () => {
		expect(parseDateRangeFromParams(new URLSearchParams("date=bogus"), "date")).toEqual({ option: "all" });
		expect(parseDateRangeFromParams(new URLSearchParams("date=custom&dateFrom=2026-01-01"), "date")).toEqual({
			option: "all",
		});
		expect(
			parseDateRangeFromParams(new URLSearchParams("date=custom&dateFrom=nope&dateTo=2026-01-02"), "date"),
		).toEqual({ option: "all" });
	});

	it("toLocalDate maps a UTC-midnight date to the same calendar day in local time", () => {
		const d = toLocalDate(new Date("2026-01-01")); // UTC midnight = Dec 31 19:00 in New York
		expect(ymd(d)).toEqual([2026, 1, 1]);
	});
});

describe("overlapsDateRange (a span in effect during the range)", () => {
	const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);
	const custom = (from: Date, to: Date) => ({ option: "custom" as const, startDate: from, endDate: to });

	it("matches everything for All", () => {
		expect(overlapsDateRange(day(2026, 1, 1), day(2026, 1, 2), { option: "all" })).toBe(true);
	});

	it("matches an open-ended span that started before the range", () => {
		expect(overlapsDateRange(day(2026, 1, 1), null, custom(day(2026, 3, 1), day(2026, 3, 31)))).toBe(true);
	});

	it("matches a span that ends inside the range", () => {
		expect(overlapsDateRange(day(2026, 1, 1), day(2026, 3, 10), custom(day(2026, 3, 1), day(2026, 3, 31)))).toBe(true);
	});

	it("excludes a span that ended before the range", () => {
		expect(overlapsDateRange(day(2026, 1, 1), day(2026, 2, 27), custom(day(2026, 3, 1), day(2026, 3, 31)))).toBe(false);
	});

	it("excludes a span that starts after the range", () => {
		expect(overlapsDateRange(day(2026, 4, 2), null, custom(day(2026, 3, 1), day(2026, 3, 31)))).toBe(false);
	});
});
