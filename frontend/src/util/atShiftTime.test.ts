import { describe, expect, it } from "vitest";
import { atShiftTime } from "./util";

describe("atShiftTime", () => {
	it("keeps times after shift start on the shift's day", () => {
		const d = atShiftTime("2026-10-05", "07:00", "16:30");
		expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([5, 16, 30]);
	});

	it("keeps the shift start itself on the shift's day", () => {
		expect(atShiftTime("2026-10-05", "07:00", "07:00").getDate()).toBe(5);
	});

	it("rolls times before shift start to the next day", () => {
		const d = atShiftTime("2026-10-09", "16:00", "03:30");
		expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([10, 3, 30]);
	});

	it("rolls across month end", () => {
		const d = atShiftTime("2026-10-31", "20:00", "01:00");
		expect([d.getMonth(), d.getDate()]).toEqual([10, 1]);
	});
});
