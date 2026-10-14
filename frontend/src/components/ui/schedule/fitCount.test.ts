import { describe, it, expect } from "vitest";
import { computeFitCount } from "./fitCount";

const GAP = 2;
const MORE = 16;

describe("computeFitCount", () => {
	it("returns 0 for an empty day", () => {
		expect(computeFitCount([], GAP, 100, MORE)).toBe(0);
	});

	it("shows everything, with no more-row, when all fit exactly", () => {
		expect(computeFitCount([20, 20, 20], GAP, 64, MORE)).toBe(3);
	});

	it("reserves the more-row when one pixel short", () => {
		// budget = 63 - 16 - 2 = 45 → 20 + 2 + 20 = 42 fits, a third does not
		expect(computeFitCount([20, 20, 20], GAP, 63, MORE)).toBe(2);
	});

	it("uses real, variable heights", () => {
		// total 100 > 60; budget 42 → 18 fits, 18 + 2 + 40 = 60 does not
		expect(computeFitCount([18, 40, 18, 18], GAP, 60, MORE)).toBe(1);
	});

	it("returns 0 when even the first card does not fit", () => {
		expect(computeFitCount([100], GAP, 50, MORE)).toBe(0);
	});

	it("returns 0 for zero available height", () => {
		expect(computeFitCount([10, 10], GAP, 0, MORE)).toBe(0);
	});

	it("shows a single item that fits", () => {
		expect(computeFitCount([30], GAP, 30, MORE)).toBe(1);
	});
});
