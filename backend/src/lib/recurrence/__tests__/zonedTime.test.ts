import { describe, it, expect } from "vitest";
import {
	addLocalDays,
	daysInMonth,
	diffLocalDays,
	isoWeekday,
	isoWeekStart,
	localWallTime,
	toLocalDate,
	zonedWallTimeToUtc,
} from "../zonedTime.js";

const CHI = "America/Chicago";
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

describe("zonedWallTimeToUtc", () => {
	it("zonedWallTimeToUtc keeps 08:00 Chicago on both sides of 2026-03-08", () => {
		expect(iso(zonedWallTimeToUtc("2026-03-07", "08:00", CHI))).toBe(
			"2026-03-07T14:00:00Z",
		);
		expect(iso(zonedWallTimeToUtc("2026-03-09", "08:00", CHI))).toBe(
			"2026-03-09T13:00:00Z",
		);
	});

	it("zonedWallTimeToUtc on 2026-11-01 08:00 Chicago is 14:00Z", () => {
		expect(iso(zonedWallTimeToUtc("2026-11-01", "08:00", CHI))).toBe(
			"2026-11-01T14:00:00Z",
		);
		expect(iso(zonedWallTimeToUtc("2026-10-31", "08:00", CHI))).toBe(
			"2026-10-31T13:00:00Z",
		);
	});

	it("zonedWallTimeToUtc resolves the spring-forward gap 02:30 forward", () => {
		expect(iso(zonedWallTimeToUtc("2026-03-08", "02:30", CHI))).toBe(
			"2026-03-08T08:30:00Z",
		);
	});

	it("zonedWallTimeToUtc picks the earlier instant for 01:30 on fall-back day", () => {
		expect(iso(zonedWallTimeToUtc("2026-11-01", "01:30", CHI))).toBe(
			"2026-11-01T06:30:00Z",
		);
	});

	// East-of-UTC zones: the naive UTC guess lands after the real instant,
	// so the gap/overlap resolution must not depend on which side it lands.
	it("resolves gap forward and overlap earlier east of UTC", () => {
		const BER = "Europe/Berlin";
		expect(iso(zonedWallTimeToUtc("2026-03-29", "02:30", BER))).toBe(
			"2026-03-29T01:30:00Z",
		);
		expect(iso(zonedWallTimeToUtc("2026-10-25", "02:30", BER))).toBe(
			"2026-10-25T00:30:00Z",
		);
	});

	it("rejects malformed input", () => {
		expect(() => zonedWallTimeToUtc("2026-3-8", "08:00", CHI)).toThrow();
		expect(() => zonedWallTimeToUtc("2026-03-08", "8:00", CHI)).toThrow();
		expect(() => zonedWallTimeToUtc("2026-03-08", "24:00", CHI)).toThrow();
	});
});

describe("toLocalDate / localWallTime", () => {
	it("toLocalDate uses the zone, not UTC", () => {
		expect(toLocalDate(new Date("2026-11-18T03:00:00Z"), CHI)).toBe(
			"2026-11-17",
		);
	});

	it("localWallTime round-trips zonedWallTimeToUtc", () => {
		expect(localWallTime(new Date("2026-11-01T06:30:00Z"), CHI)).toEqual({
			date: "2026-11-01",
			hhmm: "01:30",
		});
		expect(localWallTime(new Date("2026-03-08T08:30:00Z"), CHI)).toEqual({
			date: "2026-03-08",
			hhmm: "03:30",
		});
		expect(localWallTime(new Date("2026-11-18T05:59:00Z"), CHI)).toEqual({
			date: "2026-11-17",
			hhmm: "23:59",
		});
	});
});

describe("calendar arithmetic", () => {
	it("daysInMonth handles leap years", () => {
		expect(daysInMonth(2028, 2)).toBe(29);
		expect(daysInMonth(2026, 2)).toBe(28);
		expect(daysInMonth(2100, 2)).toBe(28);
		expect(daysInMonth(2026, 12)).toBe(31);
	});

	it("isoWeekStart returns the Monday", () => {
		expect(isoWeekStart("2026-11-18")).toBe("2026-11-16");
		expect(isoWeekStart("2026-11-16")).toBe("2026-11-16");
		expect(isoWeekStart("2026-11-22")).toBe("2026-11-16");
	});

	it("isoWeekday is 1 for Monday and 7 for Sunday", () => {
		expect(isoWeekday("2026-11-16")).toBe(1);
		expect(isoWeekday("2026-11-22")).toBe(7);
	});

	it("addLocalDays and diffLocalDays cross month, year and DST", () => {
		expect(addLocalDays("2026-12-30", 3)).toBe("2027-01-02");
		expect(addLocalDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(addLocalDays("2026-03-07", 2)).toBe("2026-03-09");
		expect(diffLocalDays("2026-03-31", "2026-03-01")).toBe(30);
		expect(diffLocalDays("2026-12-30", "2027-01-02")).toBe(-3);
	});
});
