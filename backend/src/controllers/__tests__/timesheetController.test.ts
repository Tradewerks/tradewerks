import { describe, it, expect } from "vitest";
import { buildShiftSegments } from "../timesheetController.js";
import { weekRangeIn, weekStartOf } from "../../lib/dayRange.js";

describe("weekStartOf", () => {
	it("snaps any day to that week's Monday", () => {
		expect(weekStartOf("2026-09-28").toISOString()).toBe("2026-09-28T00:00:00.000Z"); // Monday
		expect(weekStartOf("2026-10-01").toISOString()).toBe("2026-09-28T00:00:00.000Z"); // Thursday
		expect(weekStartOf("2026-10-04").toISOString()).toBe("2026-09-28T00:00:00.000Z"); // Sunday
		expect(weekStartOf("2027-01-01").toISOString()).toBe("2026-12-28T00:00:00.000Z"); // across year
	});
});

describe("weekRangeIn", () => {
	it("spans the org's local Monday to next Monday", () => {
		const { start, end } = weekRangeIn(weekStartOf("2026-10-01"), "America/Chicago");
		expect(start.toISOString()).toBe("2026-09-28T05:00:00.000Z");
		expect(end.toISOString()).toBe("2026-10-05T05:00:00.000Z");
	});

	it("handles zones ahead of UTC", () => {
		const { start } = weekRangeIn(weekStartOf("2026-10-01"), "Asia/Tokyo");
		expect(start.toISOString()).toBe("2026-09-27T15:00:00.000Z");
	});
});

describe("buildShiftSegments", () => {
	const at = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 28, h, m));
	const job = (label: string, from: Date, to: Date) => ({ start: from, end: to, label, sub: "" });
	const shift = { start: at(8), end: at(12) };
	const summary = (segs: ReturnType<typeof buildShiftSegments>) =>
		segs.map((s) => `${s.start.toISOString().slice(11, 16)}-${s.end.toISOString().slice(11, 16)} ${s.type} ${s.label}`);
	const coversShift = (segs: ReturnType<typeof buildShiftSegments>) => {
		expect(segs[0].start).toEqual(shift.start);
		expect(segs[segs.length - 1].end).toEqual(shift.end);
		segs.slice(1).forEach((s, i) => expect(s.start).toEqual(segs[i].end));
	};

	it("splits a job around a break and fills gaps as unassigned", () => {
		const segs = buildShiftSegments(
			shift,
			[job("A", at(8, 30), at(11))],
			[],
			[{ start: at(10), end: at(10, 30), label: "Lunch", sub: "Unpaid", paid: false }],
		);
		expect(summary(segs)).toEqual([
			"08:00-08:30 unassigned No job or status recorded",
			"08:30-10:00 job A",
			"10:00-10:30 break Lunch",
			"10:30-11:00 job A",
			"11:00-12:00 unassigned No job or status recorded",
		]);
		expect(segs[2].paid).toBe(false);
		coversShift(segs);
	});

	it("keeps back-to-back jobs separate and clips to the shift", () => {
		const segs = buildShiftSegments(shift, [job("A", at(7), at(10)), job("B", at(10), at(11))], [], []);
		expect(summary(segs)).toEqual([
			"08:00-10:00 job A",
			"10:00-11:00 job B",
			"11:00-12:00 unassigned No job or status recorded",
		]);
		coversShift(segs);
	});

	it("gives an overlap to the earlier job", () => {
		const segs = buildShiftSegments(shift, [job("A", at(8), at(10)), job("B", at(9), at(11))], [], []);
		expect(summary(segs)).toEqual([
			"08:00-10:00 job A",
			"10:00-11:00 job B",
			"11:00-12:00 unassigned No job or status recorded",
		]);
		coversShift(segs);
	});

	it("ranks a job over a drive", () => {
		const segs = buildShiftSegments(shift, [job("A", at(9), at(10))], [job("Drive", at(8), at(9, 30))], []);
		expect(summary(segs)).toEqual([
			"08:00-09:00 drive Drive",
			"09:00-10:00 job A",
			"10:00-12:00 unassigned No job or status recorded",
		]);
		coversShift(segs);
	});

	it("drops items entirely outside the shift", () => {
		const segs = buildShiftSegments(shift, [job("A", at(13), at(14))], [], []);
		expect(summary(segs)).toEqual(["08:00-12:00 unassigned No job or status recorded"]);
	});
});
