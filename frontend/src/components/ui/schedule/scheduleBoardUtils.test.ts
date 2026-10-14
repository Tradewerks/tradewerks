import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	CLICK_POPUP_W,
	LEFT_PAD,
	RIGHT_PAD,
	alignScheduleToConstraints,
	calcCardHeight,
	calcCardTop,
	cardSpan,
	getAnchoredPopupPos,
	getWeekDays,
	groupVisitsByDay,
	localDateKey,
	occurrenceSpan,
	resolveOverlapLayout,
	shiftConstraintTimes,
	visitDropLabel,
	occurrenceDropLabel,
	visitDropUpdate,
	visitSpan,
	WHEN_DONE_DEFAULT_H,
} from "./scheduleBoardUtils";
import type { JobVisit } from "../../../types/jobs";

const VIEWPORT = { width: 1200, height: 800 };

// The day-key tests are only meaningful west of UTC (a 9pm local visit is already "tomorrow" in
// UTC), so pin the zone instead of trusting the CI host's.
const originalTZ = process.env.TZ;
beforeAll(() => {
	process.env.TZ = "America/Chicago";
});
afterAll(() => {
	if (originalTZ === undefined) delete process.env.TZ;
	else process.env.TZ = originalTZ;
});

it("runs under a zone west of UTC", () => {
	expect(new Date(2026, 8, 29, 23, 30).getTimezoneOffset()).toBeGreaterThan(0);
});

describe("getAnchoredPopupPos", () => {
	it("places the popup to the right of the anchor when there is room", () => {
		const pos = getAnchoredPopupPos(
			{ left: 200, right: 340, top: 300 },
			{ popupH: 240, viewport: VIEWPORT },
		);
		expect(pos).toEqual({ top: 300, left: 344 });
	});

	it("flips to the left of the anchor when the right side would overflow", () => {
		const pos = getAnchoredPopupPos(
			{ left: 1000, right: 1140, top: 300 },
			{ popupH: 240, viewport: VIEWPORT },
		);
		expect(pos.left).toBe(1000 - CLICK_POPUP_W - 4);
	});

	it("clamps a bottom-edge anchor so the popup stays on screen", () => {
		const pos = getAnchoredPopupPos(
			{ left: 200, right: 340, top: 790 },
			{ popupH: 240, viewport: VIEWPORT },
		);
		expect(pos.top).toBe(VIEWPORT.height - 240 - 8);
	});

	it("never positions the popup off the top or left edge", () => {
		const pos = getAnchoredPopupPos(
			{ left: 2, right: 6, top: -50 },
			{ popupH: 240, viewport: { width: 200, height: 800 } },
		);
		expect(pos.top).toBe(8);
		expect(pos.left).toBe(8);
	});
});

describe("localDateKey", () => {
	it("keys a late-evening instant to its local day", () => {
		expect(localDateKey(new Date(2026, 8, 29, 23, 30))).toBe("2026-09-29");
	});

	it("keys an early-morning instant to its local day", () => {
		expect(localDateKey(new Date(2026, 8, 29, 0, 15))).toBe("2026-09-29");
	});

	it("accepts an ISO timestamp", () => {
		expect(localDateKey(new Date(2026, 8, 29, 23, 30).toISOString())).toBe("2026-09-29");
	});
});

describe("groupVisitsByDay", () => {
	it("groups a 9pm visit under its local day", () => {
		const visit = {
			scheduled_start_at: new Date(2026, 8, 29, 21, 0).toISOString(),
		} as unknown as JobVisit;
		expect(Object.keys(groupVisitsByDay([visit]))).toEqual(["2026-09-29"]);
	});
});

describe("getWeekDays", () => {
	it("returns local Monday–Sunday keys", () => {
		expect(getWeekDays(new Date(2026, 8, 30, 12))).toEqual([
			"2026-09-28",
			"2026-09-29",
			"2026-09-30",
			"2026-10-01",
			"2026-10-02",
			"2026-10-03",
			"2026-10-04",
		]);
	});
});

// Local wall-clock instant on 2026-09-29 unless another day is given. Called inside tests so the
// TZ pin above is already in effect.
function at(h: number, m = 0, day = 29, month = 8): string {
	return new Date(2026, month, day, h, m).toISOString();
}

describe("cardSpan", () => {
	const arrivals = ["at", "between", "by", "anytime"] as const;
	const finishes = ["at", "by", "when_done"] as const;
	for (const arrival of arrivals) {
		for (const finish of finishes) {
			it(`reads the stored schedule for ${arrival} + ${finish}, never constraint fields`, () => {
				const visit = {
					arrival_constraint: arrival,
					arrival_time: "13:00",
					arrival_window_start: "13:00",
					arrival_window_end: "15:00",
					finish_constraint: finish,
					finish_time: "16:00",
					scheduled_start_at: at(8),
					scheduled_end_at: at(10, 30),
				};
				expect(visitSpan(visit)).toEqual({
					startH: 8,
					endH: finish === "when_done" ? 10 : 10.5,
					openEnded: finish === "when_done",
				});
			});
		}
	}

	it("draws when_done at the fixed default estimate, whatever end is stored", () => {
		for (const end of [at(17), at(10), at(9)]) {
			const span = visitSpan({
				scheduled_start_at: at(7),
				scheduled_end_at: end,
				finish_constraint: "when_done",
			});
			expect(span).toEqual({ startH: 7, endH: 7 + WHEN_DONE_DEFAULT_H, openEnded: true });
			expect(calcCardHeight(span)).toBe(WHEN_DONE_DEFAULT_H * 56);
		}
	});

	it("clips a late when_done default at midnight", () => {
		const span = cardSpan({ start: at(23), end: at(23, 30), finish_constraint: "when_done" });
		expect(span.endH).toBe(24);
	});

	it("clips a span that crosses midnight to the end of the day", () => {
		const span = cardSpan({ start: at(22), end: at(1, 0, 30) });
		expect(span.endH).toBe(24);
		expect(calcCardHeight(span)).toBe(2 * 56);
	});

	it("treats an end of exactly next-day midnight as 24", () => {
		expect(cardSpan({ start: at(21), end: at(0, 0, 30) }).endH).toBe(24);
	});

	it("keeps the 28px minimum for very short visits", () => {
		expect(calcCardHeight(cardSpan({ start: at(9), end: at(9, 10) }))).toBe(28);
	});

	it("falls back to the minimum when the stored end is before the start", () => {
		const span = cardSpan({ start: at(9), end: at(8) });
		expect(span.endH).toBe(9);
		expect(calcCardHeight(span)).toBe(28);
	});

	it("survives a null or unparseable end without NaN or a midnight stretch", () => {
		for (const end of [null, "not-a-date"]) {
			const span = cardSpan({ start: at(9), end: end as unknown as string });
			expect(span).toEqual({ startH: 9, endH: 9, openEnded: false });
			expect(calcCardTop(span)).toBe(9 * 56);
			expect(calcCardHeight(span)).toBe(28);
		}
	});

	it("uses wall-clock hours on a spring-forward day", () => {
		// 2026-03-08 02:00 CST → 03:00 CDT: 01:00–04:00 local is 2 elapsed hours, 3 grid hours.
		const span = cardSpan({ start: at(1, 0, 8, 2), end: at(4, 0, 8, 2) });
		expect(span).toEqual({ startH: 1, endH: 4, openEnded: false });
		expect(calcCardHeight(span)).toBe(3 * 56);
	});

	it("places the top at the stored start", () => {
		expect(calcCardTop(cardSpan({ start: at(8, 15), end: at(9) }))).toBe(8.25 * 56);
	});

	it("reads occurrence_* fields for occurrences", () => {
		expect(
			occurrenceSpan({
				occurrence_start_at: at(13),
				occurrence_end_at: at(14, 30),
				finish_constraint: "at",
			})
		).toEqual({ startH: 13, endH: 14.5, openEnded: false });
	});
});

describe("resolveOverlapLayout", () => {
	const usable = 200 - LEFT_PAD - RIGHT_PAD;
	const widthOf = (slots: { visit: { id: string }; width: number }[], id: string) =>
		slots.find((s) => s.visit.id === id)!.width;

	it("lays out lanes from the rendered span, mixing visits and occurrences", () => {
		// A `by` visit is stored 08:00–10:00 with its deadline at 12:00; it must collide with 09:00.
		const byVisit = {
			id: "v-by",
			span: visitSpan({
				scheduled_start_at: at(8),
				scheduled_end_at: at(10),
				finish_constraint: "when_done",
			}),
		};
		const occ = {
			id: "o-1",
			span: occurrenceSpan({
				occurrence_start_at: at(9),
				occurrence_end_at: at(11),
				finish_constraint: "at",
			}),
		};
		const noon = {
			id: "v-noon",
			span: visitSpan({ scheduled_start_at: at(12), scheduled_end_at: at(13) }),
		};
		const slots = resolveOverlapLayout([noon, occ, byVisit], 200);
		expect(widthOf(slots, "v-by")).toBeCloseTo((usable - 2) / 2);
		expect(widthOf(slots, "o-1")).toBeCloseTo((usable - 2) / 2);
		expect(widthOf(slots, "v-noon")).toBeCloseTo(usable);
	});

	it("ends an open-ended visit at its drawn default, not its stored end", () => {
		const long = {
			id: "wd",
			span: visitSpan({
				scheduled_start_at: at(8),
				scheduled_end_at: at(17),
				finish_constraint: "when_done",
			}),
		};
		const late = { id: "late", span: cardSpan({ start: at(11), end: at(12) }) };
		const slots = resolveOverlapLayout([long, late], 200);
		expect(widthOf(slots, "late")).toBeCloseTo(usable);
	});

	it("lets a minimum-height card claim its drawn 30 minutes", () => {
		const blip = { id: "blip", span: cardSpan({ start: at(9), end: at(9, 5) }) };
		const next = { id: "next", span: cardSpan({ start: at(9, 15), end: at(10) }) };
		const slots = resolveOverlapLayout([blip, next], 200);
		expect(widthOf(slots, "blip")).toBeCloseTo((usable - 2) / 2);
		expect(widthOf(slots, "next")).toBeCloseTo((usable - 2) / 2);
	});
});

describe("shiftConstraintTimes", () => {
	const base = {
		arrival_time: null,
		arrival_window_start: null,
		arrival_window_end: null,
		finish_time: null,
	};

	it("shifts an at arrival and a fixed finish", () => {
		expect(
			shiftConstraintTimes(
				{ ...base, arrival_constraint: "at", arrival_time: "09:00", finish_constraint: "at", finish_time: "11:00" },
				90
			)
		).toEqual({ arrival_time: "10:30", finish_time: "12:30" });
	});

	it("moves a between window as a unit", () => {
		expect(
			shiftConstraintTimes(
				{
					...base,
					arrival_constraint: "between",
					arrival_window_start: "08:00",
					arrival_window_end: "10:00",
					finish_constraint: "when_done",
				},
				-60
			)
		).toEqual({ arrival_window_start: "07:00", arrival_window_end: "09:00" });
	});

	it("shifts a by deadline by the delta instead of snapping it to the drop point", () => {
		expect(
			shiftConstraintTimes(
				{ ...base, arrival_constraint: "by", arrival_window_end: "12:00", finish_constraint: "by", finish_time: "15:00" },
				45
			)
		).toEqual({ arrival_window_end: "12:45", finish_time: "15:45" });
	});

	it("touches nothing for anytime + when_done", () => {
		expect(
			shiftConstraintTimes({ ...base, arrival_constraint: "anytime", finish_constraint: "when_done" }, 120)
		).toEqual({});
	});

	it("leaves null fields out rather than inventing times", () => {
		expect(
			shiftConstraintTimes(
				{ ...base, arrival_constraint: "between", arrival_window_start: "08:00", finish_constraint: "at" },
				30
			)
		).toEqual({ arrival_window_start: "08:30" });
	});

	it("ignores stale fields that do not belong to the constraint", () => {
		expect(
			shiftConstraintTimes(
				{ ...base, arrival_constraint: "at", arrival_time: "09:00", arrival_window_end: "12:00", finish_constraint: "when_done", finish_time: "11:00" },
				60
			)
		).toEqual({ arrival_time: "10:00" });
	});

	it("clamps shifts to the day edges", () => {
		expect(
			shiftConstraintTimes(
				{ ...base, arrival_constraint: "between", arrival_window_start: "22:30", arrival_window_end: "23:30", finish_constraint: "at", finish_time: "23:00" },
				120
			)
		).toEqual({ arrival_window_start: "23:59", arrival_window_end: "23:59", finish_time: "23:59" });
		expect(
			shiftConstraintTimes({ ...base, arrival_constraint: "at", arrival_time: "01:00", finish_constraint: "when_done" }, -120)
		).toEqual({ arrival_time: "00:00" });
	});
});

describe("visitDropUpdate", () => {
	const drag = (fields: Partial<Parameters<typeof visitDropUpdate>[0]>) => ({
		startMs: new Date(2026, 8, 29, 8, 0).getTime(),
		durationMs: 2 * 3_600_000,
		...fields,
	});

	it("moves the schedule and shifts a by deadline by the same delta", () => {
		const newStart = new Date(2026, 8, 30, 9, 30);
		const data = visitDropUpdate(
			drag({ arrival_constraint: "by", arrival_window_end: "12:00", finish_constraint: "when_done" }),
			newStart,
			9 * 60 + 30
		);
		expect(data).toEqual({
			scheduled_start_at: newStart.toISOString(),
			scheduled_end_at: new Date(2026, 8, 30, 11, 30).toISOString(),
			arrival_window_end: "13:30",
		});
	});

	it("converts an anytime visit dropped on the grid to at + when_done", () => {
		const newStart = new Date(2026, 8, 29, 14, 15);
		const data = visitDropUpdate(drag({ arrival_constraint: "anytime" }), newStart, 14 * 60 + 15);
		expect(data).toMatchObject({
			arrival_constraint: "at",
			arrival_time: "14:15",
			finish_constraint: "when_done",
			finish_time: null,
		});
	});

	it("sends only the schedule when the payload has no constraint", () => {
		const newStart = new Date(2026, 8, 29, 10, 0);
		expect(Object.keys(visitDropUpdate(drag({}), newStart, 600)).sort()).toEqual([
			"scheduled_end_at",
			"scheduled_start_at",
		]);
	});
});

describe("alignScheduleToConstraints", () => {
	const none = { arrival_time: null, arrival_window_start: null, arrival_window_end: null, finish_time: null };
	const orig = () => ({ start: at(8), end: at(10) });
	const local = (d: Date) => [d.getDate(), d.getHours(), d.getMinutes()];

	it("keeps the stored clock time when nothing was edited (by stays 4h ahead of its deadline)", () => {
		const c = { ...none, arrival_constraint: "by", arrival_window_end: "12:00", finish_constraint: "when_done" };
		const { start, end } = alignScheduleToConstraints("2026-09-30", orig(), c, c);
		expect(local(start)).toEqual([30, 8, 0]);
		expect(local(end)).toEqual([30, 10, 0]);
	});

	it("moves the schedule by the edited anchor delta for the same constraint", () => {
		const before = { ...none, arrival_constraint: "by", arrival_window_end: "12:00", finish_constraint: "when_done" };
		const after = { ...before, arrival_window_end: "13:30" };
		const { start, end } = alignScheduleToConstraints("2026-09-29", orig(), before, after);
		expect(local(start)).toEqual([29, 9, 30]);
		expect(local(end)).toEqual([29, 11, 30]);
	});

	it("snaps to the new anchor when the constraint type changes", () => {
		const before = { ...none, arrival_constraint: "at", arrival_time: "08:00", finish_constraint: "when_done" };
		const between = { ...none, arrival_constraint: "between", arrival_window_start: "13:00", arrival_window_end: "15:00", finish_constraint: "when_done" };
		expect(local(alignScheduleToConstraints("2026-09-29", orig(), before, between).start)).toEqual([29, 13, 0]);
		const by = { ...none, arrival_constraint: "by", arrival_window_end: "14:00", finish_constraint: "when_done" };
		expect(local(alignScheduleToConstraints("2026-09-29", orig(), before, by).start)).toEqual([29, 10, 0]);
	});

	it("keeps the stored start when the same constraint had no anchor before", () => {
		const before = { ...none, arrival_constraint: "by", finish_constraint: "when_done" };
		const after = { ...before, arrival_window_end: "09:00" };
		expect(local(alignScheduleToConstraints("2026-09-29", orig(), before, after).start)).toEqual([29, 8, 0]);
	});

	it("ends at a fixed finish time, and ignores one that lands before the start", () => {
		const before = { ...none, arrival_constraint: "at", arrival_time: "08:00", finish_constraint: "when_done" };
		const fixed = { ...before, finish_constraint: "at", finish_time: "17:00" };
		expect(local(alignScheduleToConstraints("2026-09-29", orig(), before, fixed).end)).toEqual([29, 17, 0]);
		const early = { ...before, finish_constraint: "by", finish_time: "07:00" };
		expect(local(alignScheduleToConstraints("2026-09-29", orig(), before, early).end)).toEqual([29, 10, 0]);
	});

	it("keeps the clock time for anytime", () => {
		const c = { ...none, arrival_constraint: "anytime", finish_constraint: "when_done" };
		expect(local(alignScheduleToConstraints("2026-10-01", orig(), c, c).start)).toEqual([1, 8, 0]);
	});
});

describe("visitDropLabel", () => {
	const base = { startMs: new Date(2026, 8, 29, 8, 0).getTime(), durationMs: 2 * 3_600_000 };
	const label = (fields: Partial<Parameters<typeof visitDropUpdate>[0]>, h: number, m = 0) => {
		const drag = { ...base, ...fields };
		const newStart = new Date(2026, 8, 30, h, m);
		const newEnd = new Date(newStart.getTime() + drag.durationMs);
		const data = visitDropUpdate(drag, newStart, h * 60 + m);
		return visitDropLabel(drag, data, newStart, newEnd);
	};

	it("shows a dragged by visit's shifted deadline, not the drop start", () => {
		expect(
			label(
				{ arrival_constraint: "by", arrival_window_end: "12:00", finish_constraint: "when_done" },
				11
			)
		).toBe("3:00 PM · WD");
	});

	it("keeps the start-end range for at", () => {
		expect(
			label(
				{ arrival_constraint: "at", arrival_time: "08:00", finish_constraint: "at", finish_time: "10:00" },
				10,
				30
			)
		).toBe("10:30 AM – 12:30 PM");
	});

	it("shifts both between ends", () => {
		expect(
			label(
				{
					arrival_constraint: "between",
					arrival_window_start: "08:00",
					arrival_window_end: "09:00",
					finish_constraint: "when_done",
				},
				7,
				30
			)
		).toBe("7:30 AM · WD");
	});

	it("labels an anytime drop at the drop time", () => {
		expect(label({ arrival_constraint: "anytime", finish_constraint: "when_done" }, 9)).toBe(
			"9:00 AM · WD"
		);
	});
});

describe("occurrenceDropLabel", () => {
	const base = { startMs: new Date(2026, 8, 29, 8, 0).getTime(), durationMs: 2 * 3_600_000 };
	const label = (fields: Partial<Parameters<typeof occurrenceDropLabel>[0]>, h: number, m = 0) => {
		const drag = { ...base, ...fields };
		const newStart = new Date(2026, 8, 30, h, m);
		return occurrenceDropLabel(drag, newStart, new Date(newStart.getTime() + drag.durationMs));
	};

	it("shows a dragged by occurrence's shifted deadline, not the drop start", () => {
		expect(
			label(
				{ arrival_constraint: "by", arrival_window_end: "12:00", finish_constraint: "when_done" },
				10
			)
		).toBe("2:00 PM · WD");
	});

	it("keeps the shifted start-end range for at", () => {
		expect(
			label(
				{ arrival_constraint: "at", arrival_time: "08:00", finish_constraint: "at", finish_time: "10:00" },
				10,
				30
			)
		).toBe("10:30 AM – 12:30 PM");
	});

	it("labels an anytime drop at the drop time", () => {
		expect(label({ arrival_constraint: "anytime", finish_constraint: "when_done" }, 9)).toBe(
			"9:00 AM · WD"
		);
	});
});
