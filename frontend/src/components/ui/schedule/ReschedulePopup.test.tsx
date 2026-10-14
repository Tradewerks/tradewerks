import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import ReschedulePopup from "./ReschedulePopup";
import type { VisitWithJob } from "./dashboardCalendarUtils";

const originalTZ = process.env.TZ;
beforeAll(() => {
	process.env.TZ = "America/Chicago";
});
afterAll(() => {
	process.env.TZ = originalTZ;
});
afterEach(() => {
	vi.useRealTimers();
});

// What a drag of a `by` visit from 08:00 to 10:00 hands the popup: schedule and deadline both +2h.
function draggedByVisit(): VisitWithJob {
	return {
		id: "v1",
		job_id: "j1",
		arrival_constraint: "by",
		arrival_time: null,
		arrival_window_start: null,
		arrival_window_end: "14:00",
		finish_constraint: "when_done",
		finish_time: null,
		scheduled_start_at: new Date(2026, 8, 29, 10, 0).toISOString(),
		scheduled_end_at: new Date(2026, 8, 29, 12, 0).toISOString(),
		status: "Scheduled",
		visit_techs: [],
		job_obj: { id: "j1", name: "RTU Replacement", recurring_plan: null },
	} as unknown as VisitWithJob;
}

describe("ReschedulePopup", () => {
	it("saves a dragged by visit at its dropped start, not at its deadline", () => {
		vi.useFakeTimers();
		const onSave = vi.fn();
		render(
			<ReschedulePopup
				visit={draggedByVisit()}
				oldDateStr="2026-09-29"
				newDateStr="2026-09-29"
				allVisitsOnNewDay={[]}
				technicians={[]}
				techColorMap={new Map()}
				anchorRect={{ top: 100, bottom: 140, left: 100, right: 101, width: 1, height: 40, x: 100, y: 100, toJSON: () => ({}) } as DOMRect}
				onSave={onSave}
				onUndo={() => {}}
			/>
		);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(onSave).toHaveBeenCalledTimes(1);
		const data = onSave.mock.calls[0][0];
		expect(new Date(data.scheduled_start_at).getHours()).toBe(10);
		expect(new Date(data.scheduled_end_at).getHours()).toBe(12);
		expect(data.arrival_window_end).toBe("14:00");
	});
});
