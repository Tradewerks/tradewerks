import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import OccurrenceReschedulePopup from "./OccurrenceReschedulePopup";
import type { OccurrenceWithPlan } from "./dashboardCalendarUtils";

const originalTZ = process.env.TZ;
beforeAll(() => {
	process.env.TZ = "America/Chicago";
});
afterAll(() => {
	process.env.TZ = originalTZ;
});

const anchorRect = {
	top: 100,
	bottom: 140,
	left: 100,
	right: 101,
	width: 1,
	height: 40,
	x: 100,
	y: 100,
	toJSON: () => ({}),
} as DOMRect;

function byOccurrence(over: Partial<OccurrenceWithPlan> = {}): OccurrenceWithPlan {
	return {
		id: "o1",
		recurring_plan_id: "p1",
		occurrence_start_at: new Date(2026, 8, 29, 9, 0).toISOString(),
		occurrence_end_at: new Date(2026, 8, 29, 11, 0).toISOString(),
		status: "planned",
		arrival_constraint: "by",
		arrival_time: null,
		arrival_window_start: null,
		arrival_window_end: "13:00",
		finish_constraint: "when_done",
		finish_time: null,
		template_version: 1,
		created_at: "",
		plan: { id: "p1", name: "Quarterly PM" },
		job_obj: { id: "j1", name: "Oak Dental PM" },
		...over,
	} as unknown as OccurrenceWithPlan;
}

describe("OccurrenceReschedulePopup", () => {
	it("keeps a by occurrence at its stored start instead of moving it to the deadline", () => {
		const onReschedule = vi.fn();
		render(
			<OccurrenceReschedulePopup
				occurrence={byOccurrence()}
				oldDateStr="2026-09-29"
				newDateStr="2026-09-29"
				anchorRect={anchorRect}
				onReschedule={onReschedule}
				onGenerate={() => {}}
				onCancel={() => {}}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		expect(onReschedule).toHaveBeenCalledTimes(1);
		const input = onReschedule.mock.calls[0][0];
		expect(new Date(input.new_start_at).getHours()).toBe(9);
		expect(input.arrival_window_end).toBe("13:00");
	});

	it("never sends a fixed finish that lands before the start", () => {
		const onReschedule = vi.fn();
		render(
			<OccurrenceReschedulePopup
				occurrence={byOccurrence({
					arrival_constraint: "at",
					arrival_time: "09:00",
					arrival_window_end: null,
					finish_constraint: "at",
					finish_time: "08:00",
				})}
				oldDateStr="2026-09-29"
				newDateStr="2026-09-29"
				anchorRect={anchorRect}
				onReschedule={onReschedule}
				onGenerate={() => {}}
				onCancel={() => {}}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		const input = onReschedule.mock.calls[0][0];
		expect(new Date(input.new_end_at).getHours()).toBe(11);
	});
});
