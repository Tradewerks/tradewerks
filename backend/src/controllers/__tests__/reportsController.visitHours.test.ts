import { describe, it, expect } from "vitest";
import { shiftSplitHours } from "../reportsController.js";

const at = (hhmm: string) => new Date(`2026-09-28T${hhmm}:00.000Z`);
const span = (a: string, b: string) => ({ start: at(a), end: at(b) });

describe("shiftSplitHours", () => {
	it("sums entries and clips them to the shift", () => {
		const shift = span("08:00", "16:00");
		expect(
			shiftSplitHours(
				shift,
				[span("08:30", "10:30"), span("07:00", "09:00"), span("15:00", "17:00"), span("17:00", "18:00")],
				[],
				[],
			).visitHours,
		).toBe(3.5);
	});

	it("counts overlapping time once, matching the timeline", () => {
		const shift = span("08:00", "16:00");
		const split = shiftSplitHours(
			shift,
			[span("09:00", "13:00")],
			[span("08:30", "09:30"), span("13:30", "14:30")],
			[{ ...span("12:00", "12:30"), paid: false }, { ...span("14:00", "14:15"), paid: true }],
		);
		expect(split).toEqual({ visitHours: 3.5, driveHours: 1.25 });
	});

	it("is 0 with no entries", () => {
		expect(shiftSplitHours(span("08:00", "16:00"), [], [], [])).toEqual({ visitHours: 0, driveHours: 0 });
	});
});
