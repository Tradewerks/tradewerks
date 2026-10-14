import { describe, it, expect } from "vitest";
import { utcDayRange, localDateString, localTimeOnDay } from "../dayRange.js";

describe("utcDayRange", () => {
	it("keeps UTC behaviour byte-identical when no timezone is asked for", () => {
		const at = new Date("2026-08-21T15:00:00Z");
		expect(utcDayRange(at).start.toISOString()).toBe("2026-08-21T00:00:00.000Z");
		expect(utcDayRange(at).end.toISOString()).toBe("2026-08-22T00:00:00.000Z");
		expect(utcDayRange(at, 1, "UTC").start.toISOString()).toBe("2026-08-21T00:00:00.000Z");
	});

	it("returns the instant local midnight happened, not UTC midnight of the local date", () => {
		// 02:00Z on the 21st is 21:00 on the 20th in Chicago (CDT, UTC-5), so the
		// day containing it began at 05:00Z on the 20th.
		const w = utcDayRange(new Date("2026-08-21T02:00:00Z"), 1, "America/Chicago");
		expect(w.start.toISOString()).toBe("2026-08-20T05:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-08-21T05:00:00.000Z");
	});

	it("spans a whole local day east of UTC, where UTC midnight is the day before", () => {
		// 09:00 on the 21st in Tokyo (UTC+9) is 00:00Z on the 21st; the local day
		// began nine hours earlier.
		const w = utcDayRange(new Date("2026-08-21T00:00:00Z"), 1, "Asia/Tokyo");
		expect(w.start.toISOString()).toBe("2026-08-20T15:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-08-21T15:00:00.000Z");
	});

	it("gives a spring-forward day 23 hours, not 24", () => {
		// US DST began 2026-03-08: Chicago went UTC-6 to UTC-5 at 02:00 local.
		const w = utcDayRange(new Date("2026-03-08T12:00:00Z"), 1, "America/Chicago");
		expect(w.start.toISOString()).toBe("2026-03-08T06:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-03-09T05:00:00.000Z");
		expect(w.end.getTime() - w.start.getTime()).toBe(23 * 3_600_000);
	});

	it("gives a fall-back day 25 hours", () => {
		// US DST ended 2026-11-01: Chicago went UTC-5 to UTC-6 at 02:00 local.
		const w = utcDayRange(new Date("2026-11-01T12:00:00Z"), 1, "America/Chicago");
		expect(w.start.toISOString()).toBe("2026-11-01T05:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-11-02T06:00:00.000Z");
		expect(w.end.getTime() - w.start.getTime()).toBe(25 * 3_600_000);
	});

	it("counts days in calendar space, so a multi-day window crosses a DST edge whole", () => {
		const w = utcDayRange(new Date("2026-03-07T12:00:00Z"), 2, "America/Chicago");
		expect(w.start.toISOString()).toBe("2026-03-07T06:00:00.000Z");
		expect(w.end.toISOString()).toBe("2026-03-09T05:00:00.000Z");
	});
});

describe("localDateString", () => {
	it("names the local calendar date west of UTC", () => {
		expect(localDateString(new Date("2026-08-21T02:00:00Z"), "America/Chicago")).toBe("2026-08-20");
	});

	it("names the local calendar date east of UTC", () => {
		expect(localDateString(new Date("2026-08-20T16:00:00Z"), "Asia/Tokyo")).toBe("2026-08-21");
	});

	it("offsets in calendar days, not in 86400-second jumps", () => {
		// The day after a spring-forward day is the 9th, even though only 23 hours
		// of wall clock separate the two midnights.
		expect(localDateString(new Date("2026-03-08T12:00:00Z"), "America/Chicago", 1)).toBe("2026-03-09");
	});

	it("defaults to UTC", () => {
		expect(localDateString(new Date("2026-08-21T23:00:00Z"))).toBe("2026-08-21");
	});
});

describe("localTimeOnDay", () => {
	it("resolves a wall-clock time in CDT", () => {
		const d = localTimeOnDay(new Date("2026-10-01T13:00:00Z"), "10:30", "America/Chicago");
		expect(d.toISOString()).toBe("2026-10-01T15:30:00.000Z");
	});

	it("uses CST after the fall-back, not the offset of the night before", () => {
		// DST ended 02:00 local on 2026-11-01
		const d = localTimeOnDay(new Date("2026-11-01T14:00:00Z"), "10:30", "America/Chicago");
		expect(d.toISOString()).toBe("2026-11-01T16:30:00.000Z");
	});

	it("keeps an evening visit on its local day, not the UTC day", () => {
		// 7 PM CDT on Oct 1 is 00:00Z Oct 2
		const d = localTimeOnDay(new Date("2026-10-02T00:00:00Z"), "19:45", "America/Chicago");
		expect(d.toISOString()).toBe("2026-10-02T00:45:00.000Z");
	});

	it("works with UTC", () => {
		const d = localTimeOnDay(new Date("2026-10-01T23:00:00Z"), "08:05", "UTC");
		expect(d.toISOString()).toBe("2026-10-01T08:05:00.000Z");
	});
});
