import { describe, expect, it } from "vitest";
import { formatShortDate } from "../util";

const TZ = "America/Chicago";

describe("formatShortDate", () => {
	it("omits the year inside the current year", () => {
		expect(formatShortDate("2026-10-01T15:00:00Z", TZ, new Date("2026-06-01T12:00:00Z"))).toBe(
			"Oct 1",
		);
	});

	it("adds the year outside the current year", () => {
		expect(formatShortDate("2026-10-01T15:00:00Z", TZ, new Date("2025-06-01T12:00:00Z"))).toBe(
			"Oct 1, 2026",
		);
	});

	it("reads both dates in the org timezone, not UTC", () => {
		// 03:00Z on Jan 1 2027 is still Dec 31 2026 in Chicago.
		expect(formatShortDate("2027-01-01T03:00:00Z", TZ, new Date("2026-12-01T12:00:00Z"))).toBe(
			"Dec 31",
		);
	});
});
