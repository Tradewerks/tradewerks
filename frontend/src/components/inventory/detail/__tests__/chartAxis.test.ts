import { describe, it, expect } from "vitest";
import { resolveTimeDomain } from "../chartAxis";

describe("resolveTimeDomain", () => {
	it("passes through an explicit xDomain untouched", () => {
		expect(resolveTimeDomain([{ ts: 5 }, { ts: 9 }], [0, 100])).toEqual([0, 100]);
	});

	it("falls back to a fixed range when there are no points", () => {
		expect(resolveTimeDomain([])).toEqual([0, 1]);
	});

	it("spans min to max when the series already covers more than a day", () => {
		const day = 24 * 60 * 60 * 1000;
		expect(resolveTimeDomain([{ ts: 0 }, { ts: 3 * day }])).toEqual([0, 3 * day]);
	});

	// The bug: a single point (or several sharing a timestamp) collapses
	// min === max, which — left unpadded — makes Recharts render duplicate,
	// fully overlapping x-axis tick labels instead of hiding the collision.
	it("pads a single-point series so the domain isn't zero-width", () => {
		const [min, max] = resolveTimeDomain([{ ts: 1_000_000 }]);
		expect(max - min).toBeGreaterThan(0);
		expect(min).toBeLessThan(1_000_000);
		expect(max).toBeGreaterThan(1_000_000);
	});

	it("pads several points sharing one timestamp the same way", () => {
		const [min, max] = resolveTimeDomain([{ ts: 500 }, { ts: 500 }, { ts: 500 }]);
		expect(max - min).toBeGreaterThan(0);
	});

	it("pads a series spanning less than a day", () => {
		const hour = 60 * 60 * 1000;
		const [min, max] = resolveTimeDomain([{ ts: 0 }, { ts: 3 * hour }]);
		expect(max - min).toBeGreaterThan(3 * hour);
	});
});
