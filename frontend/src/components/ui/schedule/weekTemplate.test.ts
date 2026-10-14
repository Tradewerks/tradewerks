import { describe, it, expect } from "vitest";
import {
	buildStripTemplate,
	buildWeekTemplate,
	DAY_MIN_W,
	STRIP_DAY_MIN_W,
	STRIP_ZOOMED_MIN_W,
	ZOOMED_MIN_W,
} from "./weekTemplate";

const WEEK = [
	"2026-09-28",
	"2026-09-29",
	"2026-09-30",
	"2026-10-01",
	"2026-10-02",
	"2026-10-03",
	"2026-10-04",
];
const NORMAL = "minmax(150px, 1fr)";
const ZOOMED = "minmax(300px, 2fr)";

describe("buildWeekTemplate", () => {
	it("emits gutter + 7 equal day tracks when nothing is zoomed", () => {
		const { gridTemplateColumns, gridMinWidth } = buildWeekTemplate(WEEK, null, 64);
		expect(gridTemplateColumns).toBe(`64px ${Array(7).fill(NORMAL).join(" ")}`);
		expect(gridMinWidth).toBe(64 + 7 * DAY_MIN_W);
	});

	it("widens only the zoomed day", () => {
		const { gridTemplateColumns, gridMinWidth } = buildWeekTemplate(WEEK, "2026-09-30", 64);
		const tracks = [NORMAL, NORMAL, ZOOMED, NORMAL, NORMAL, NORMAL, NORMAL];
		expect(gridTemplateColumns).toBe(`64px ${tracks.join(" ")}`);
		expect(gridMinWidth).toBe(64 + 6 * DAY_MIN_W + ZOOMED_MIN_W);
	});

	it("treats a zoomed day outside the week as unzoomed", () => {
		expect(buildWeekTemplate(WEEK, "2026-09-21", 64)).toEqual(buildWeekTemplate(WEEK, null, 64));
	});

	// grid-template-columns only interpolates between track lists of the same shape.
	it("always emits 8 explicit tracks and never repeat()", () => {
		for (const zoom of [null, WEEK[0], WEEK[6]]) {
			const { gridTemplateColumns } = buildWeekTemplate(WEEK, zoom, 64);
			expect(gridTemplateColumns).not.toContain("repeat(");
			expect(gridTemplateColumns.match(/64px|minmax\([^)]*\)/g)).toHaveLength(8);
		}
	});
});

describe("buildStripTemplate", () => {
	const S_NORMAL = `minmax(${STRIP_DAY_MIN_W}px, 1fr)`;
	const S_ZOOMED = `minmax(${STRIP_ZOOMED_MIN_W}px, 2fr)`;

	it("emits one equal track per day when nothing is zoomed", () => {
		expect(buildStripTemplate(WEEK, null)).toBe(Array(7).fill(S_NORMAL).join(" "));
	});

	it("widens only the zoomed day, keeping the track count", () => {
		expect(buildStripTemplate(WEEK, "2026-10-01")).toBe(
			[S_NORMAL, S_NORMAL, S_NORMAL, S_ZOOMED, S_NORMAL, S_NORMAL, S_NORMAL].join(" ")
		);
	});

	it("ignores a zoomed day outside the window", () => {
		expect(buildStripTemplate(WEEK.slice(0, 3), "2026-10-04")).toBe(Array(3).fill(S_NORMAL).join(" "));
	});
});
