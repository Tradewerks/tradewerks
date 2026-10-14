import { describe, expect, it } from "vitest";
import { formatElapsed, resolveWorkTimerStart } from "../elapsedUtil";
import type { JobVisit, VisitTechTimeEntry } from "../../types/jobs";

const entry = (over: Partial<VisitTechTimeEntry>): VisitTechTimeEntry => ({
	id: "e1",
	visit_id: "v1",
	tech_id: "t1",
	tech: { id: "t1", name: "Tech One" },
	clocked_in_at: "2026-08-24T15:00:00.000Z",
	clocked_out_at: null,
	hours_worked: null,
	line_item_id: null,
	pause_reason: null,
	created_at: "2026-08-24T15:00:00.000Z",
	...over,
});

const visit = (over: Partial<JobVisit>): JobVisit =>
	({
		id: "v1",
		job_id: "j1",
		arrival_constraint: "anytime",
		finish_constraint: "when_done",
		scheduled_start_at: "2026-08-24T18:00:00.000Z",
		scheduled_end_at: "2026-08-24T20:00:00.000Z",
		status: "InProgress",
		visit_techs: [],
		...over,
	}) as JobVisit;

describe("formatElapsed", () => {
	it("clamps negative elapsed to zero instead of rendering mixed-sign parts", () => {
		expect(formatElapsed(-1082)).toBe("0:00");
		expect(formatElapsed(-7868)).toBe("0:00");
	});

	it("formats sub-hour durations as m:ss", () => {
		expect(formatElapsed(0)).toBe("0:00");
		expect(formatElapsed(65)).toBe("1:05");
	});

	it("formats hour-plus durations as h:mm:ss", () => {
		expect(formatElapsed(3725)).toBe("1:02:05");
	});
});

describe("resolveWorkTimerStart", () => {
	it("prefers the viewing tech's open time entry over the visit arrival time", () => {
		const v = visit({
			actual_start_at: "2026-08-24T18:05:00.000Z",
			time_entries: [entry({ clocked_in_at: "2026-08-24T15:40:00.000Z" })],
		});
		expect(resolveWorkTimerStart(v, "t1")).toBe("2026-08-24T15:40:00.000Z");
	});

	it("ignores closed entries and other techs' open entries", () => {
		const v = visit({
			actual_start_at: "2026-08-24T14:00:00.000Z",
			time_entries: [
				entry({ id: "e0", clocked_out_at: "2026-08-24T15:00:00.000Z" }),
				entry({ id: "e2", tech_id: "t2", tech: { id: "t2", name: "Other" } }),
			],
		});
		expect(resolveWorkTimerStart(v, "t1")).toBe("2026-08-24T14:00:00.000Z");
	});

	it("falls back to actual_start_at when the tech has no open entry", () => {
		const v = visit({ actual_start_at: "2026-08-24T14:00:00.000Z" });
		expect(resolveWorkTimerStart(v, "t1")).toBe("2026-08-24T14:00:00.000Z");
	});

	it("returns null when there is nothing to count from", () => {
		expect(resolveWorkTimerStart(visit({}), "t1")).toBeNull();
	});
});
