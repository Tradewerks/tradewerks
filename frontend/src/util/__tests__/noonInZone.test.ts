import { describe, expect, it } from "vitest";
import { noonInZone } from "../util";

describe("noonInZone", () => {
	it("is 12:00 on the picked day in the plan's zone, whatever the browser's", () => {
		expect(noonInZone(new Date(2026, 11, 20), "America/Chicago").toISOString()).toBe(
			"2026-12-20T18:00:00.000Z",
		);
		expect(noonInZone(new Date(2026, 11, 20), "Pacific/Auckland").toISOString()).toBe(
			"2026-12-19T23:00:00.000Z",
		);
	});

	it("follows daylight saving on the picked day", () => {
		expect(noonInZone(new Date(2026, 6, 4), "America/Chicago").toISOString()).toBe(
			"2026-07-04T17:00:00.000Z",
		);
	});
});
