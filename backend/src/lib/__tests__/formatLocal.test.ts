import { describe, it, expect } from "vitest";
import {
	formatArrivalWindow,
	formatLocalDate,
	formatLocalTime,
} from "../formatLocal.js";

const TZ = "America/Chicago";
const base = {
	scheduled_start_at: new Date("2026-11-18T14:00:00Z"),
	arrival_time: null as string | null,
	arrival_window_start: null as string | null,
	arrival_window_end: null as string | null,
};

describe("formatLocal", () => {
	it("formats date and time in the org timezone", () => {
		expect(formatLocalDate(base.scheduled_start_at, TZ)).toBe(
			"Wednesday, November 18",
		);
		expect(formatLocalTime(base.scheduled_start_at, TZ)).toBe("8:00 AM");
	});

	describe("formatArrivalWindow", () => {
		it("at", () => {
			expect(
				formatArrivalWindow(
					{
						...base,
						arrival_constraint: "at",
						arrival_time: "08:00",
					},
					TZ,
				),
			).toBe("at 8:00 AM");
		});
		it("between", () => {
			expect(
				formatArrivalWindow(
					{
						...base,
						arrival_constraint: "between",
						arrival_window_start: "08:00",
						arrival_window_end: "10:00",
					},
					TZ,
				),
			).toBe("between 8:00 AM and 10:00 AM");
		});
		it("by", () => {
			expect(
				formatArrivalWindow(
					{
						...base,
						arrival_constraint: "by",
						arrival_window_end: "10:00",
					},
					TZ,
				),
			).toBe("by 10:00 AM");
		});
		it("falls back to the scheduled start when times are null", () => {
			expect(formatArrivalWindow({ ...base, arrival_constraint: "at" }, TZ)).toBe("at 8:00 AM");
			expect(formatArrivalWindow({ ...base, arrival_constraint: "between" }, TZ)).toBe(
				"between 8:00 AM and 8:00 AM",
			);
			expect(formatArrivalWindow({ ...base, arrival_constraint: "by" }, TZ)).toBe("by 8:00 AM");
		});
		it("anytime", () => {
			expect(
				formatArrivalWindow(
					{ ...base, arrival_constraint: "anytime" },
					TZ,
				),
			).toBe("during the day");
		});
	});
});

describe("formatLocal DST", () => {
	it("formatLocalDate/Time across the 2026-11-01 US fall-back: 2026-11-01T06:30:00Z in America/Chicago is \"1:30 AM\", 07:30Z is \"1:30 AM\" again, 08:30Z is \"2:30 AM\"", () => {
		const tz = "America/Chicago";
		const t = (iso: string) => formatLocalTime(new Date(iso), tz);
		expect(t("2026-11-01T06:30:00Z")).toBe("1:30 AM");
		expect(t("2026-11-01T07:30:00Z")).toBe("1:30 AM");
		expect(t("2026-11-01T08:30:00Z")).toBe("2:30 AM");
		expect(formatLocalDate(new Date("2026-11-01T07:30:00Z"), tz)).toBe(
			"Sunday, November 1",
		);
	});
});
