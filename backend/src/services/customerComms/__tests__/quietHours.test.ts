import { describe, it, expect } from "vitest";
import { holdForQuietHours } from "../quietHours.js";

const TZ = "America/Chicago";

describe("holdForQuietHours", () => {
	it("leaves a time inside 08:00–20:00 unchanged", () => {
		const at = new Date("2026-06-10T17:00:00Z"); // 12:00 CDT
		expect(holdForQuietHours(at, TZ, "defer")).toEqual(at);
		expect(holdForQuietHours(at, TZ, "advance")).toEqual(at);
	});

	it("defers 22:30 to 08:00 the next morning and advances it to 20:00 the same evening", () => {
		const at = new Date("2026-06-11T03:30:00Z"); // Jun 10 22:30 CDT
		expect(holdForQuietHours(at, TZ, "defer").toISOString()).toBe(
			"2026-06-11T13:00:00.000Z",
		);
		expect(holdForQuietHours(at, TZ, "advance").toISOString()).toBe(
			"2026-06-11T01:00:00.000Z",
		);
	});

	it("defers 06:00 to 08:00 the same day and advances it to 20:00 the evening before", () => {
		const at = new Date("2026-06-10T11:00:00Z"); // 06:00 CDT
		expect(holdForQuietHours(at, TZ, "defer").toISOString()).toBe(
			"2026-06-10T13:00:00.000Z",
		);
		expect(holdForQuietHours(at, TZ, "advance").toISOString()).toBe(
			"2026-06-10T01:00:00.000Z",
		);
	});

	it("holdForQuietHours across the spring-forward night returns a real instant", () => {
		// 2026-03-08 01:30 CST; clocks jump 02:00 -> 03:00, so 08:00 that
		// morning is CDT (UTC-5), not CST.
		const before = new Date("2026-03-08T07:30:00Z");
		const deferred = holdForQuietHours(before, TZ, "defer");
		expect(deferred.toISOString()).toBe("2026-03-08T13:00:00.000Z");
		// Saturday 20:00 was still CST.
		expect(holdForQuietHours(before, TZ, "advance").toISOString()).toBe(
			"2026-03-08T02:00:00.000Z",
		);
		// From the evening before, deferring crosses the jump overnight.
		const evening = new Date("2026-03-08T04:00:00Z"); // Mar 7 22:00 CST
		expect(holdForQuietHours(evening, TZ, "defer").toISOString()).toBe(
			"2026-03-08T13:00:00.000Z",
		);
		const wall = new Intl.DateTimeFormat("en-US", {
			timeZone: TZ,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).format(deferred);
		expect(wall).toBe("08:00");
	});
	it("steps calendar days, not 24 hours, across 23- and 25-hour days", () => {
		const at = (iso: string, mode: "defer" | "advance") =>
			holdForQuietHours(new Date(iso), TZ, mode).toISOString();
		// Sat 03-07 23:30 CST -> Sun 03-08 08:00 CDT (not Monday).
		expect(at("2026-03-08T05:30:00Z", "defer")).toBe(
			"2026-03-08T13:00:00.000Z",
		);
		// Mon 03-09 00:30 CDT -> Sun 03-08 20:00 CDT (not Saturday).
		expect(at("2026-03-09T05:30:00Z", "advance")).toBe(
			"2026-03-09T01:00:00.000Z",
		);
		// Fall back: Sat 10-31 23:30 CDT -> Sun 11-01 08:00 CST.
		expect(at("2026-11-01T04:30:00Z", "defer")).toBe(
			"2026-11-01T14:00:00.000Z",
		);
		// Mon 11-02 00:30 CST -> Sun 11-01 20:00 CST.
		expect(at("2026-11-02T06:30:00Z", "advance")).toBe(
			"2026-11-02T02:00:00.000Z",
		);
		// Sun 11-01 21:00 CST -> Mon 11-02 08:00 CST.
		expect(at("2026-11-02T03:00:00Z", "defer")).toBe(
			"2026-11-02T14:00:00.000Z",
		);
	});
});
