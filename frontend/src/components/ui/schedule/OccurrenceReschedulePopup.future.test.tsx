import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import OccurrenceReschedulePopup from "./OccurrenceReschedulePopup";
import type { OccurrenceWithPlan } from "./dashboardCalendarUtils";

const anchorRect = {
	top: 100, bottom: 140, left: 100, right: 101, width: 1, height: 40, x: 100, y: 100,
	toJSON: () => ({}),
} as DOMRect;

const occurrence = {
	id: "o1",
	recurring_plan_id: "p1",
	occurrence_start_at: new Date(2026, 8, 29, 9, 0).toISOString(),
	occurrence_end_at: new Date(2026, 8, 29, 11, 0).toISOString(),
	status: "planned",
	arrival_constraint: "at",
	arrival_time: "09:00",
	finish_constraint: "when_done",
	template_version: 1,
	created_at: "",
	plan: { id: "p1", name: "Quarterly PM" },
} as unknown as OccurrenceWithPlan;

const mount = (newDateStr: string, onReschedule = vi.fn()) =>
	render(
		<OccurrenceReschedulePopup
			occurrence={occurrence}
			oldDateStr="2026-09-29"
			newDateStr={newDateStr}
			anchorRect={anchorRect}
			onReschedule={onReschedule}
			onGenerate={() => {}}
			onCancel={() => {}}
		/>
	);

describe("OccurrenceReschedulePopup scope", () => {
	it("all-future is disabled when the date changes", () => {
		mount("2026-09-30");
		const future = screen.getByRole("button", { name: /this & all future/i }) as HTMLButtonElement;
		expect(future.disabled).toBe(true);
		expect(
			screen.getByText("To move every future visit to another day, edit the plan's schedule.")
		).toBeTruthy();
	});

	it("future scope locks the window and finish editors and sends only the times", () => {
		const onReschedule = vi.fn();
		mount("2026-09-29", onReschedule);
		fireEvent.click(screen.getByRole("button", { name: /this & all future/i }));
		for (const select of screen.getAllByRole("combobox")) {
			expect((select as HTMLSelectElement).disabled).toBe(true);
		}
		expect(screen.getByText(/only the start time moves for future visits/i)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		const input = onReschedule.mock.calls[0][0];
		expect(input.scope).toBe("future");
		expect(input).toHaveProperty("new_start_at");
		expect(input).not.toHaveProperty("arrival_constraint");
		expect(input).not.toHaveProperty("arrival_time");
		expect(input).not.toHaveProperty("finish_constraint");
		expect(input).not.toHaveProperty("finish_time");
	});

	it("resets edited editors when the scope switches to future", () => {
		const onReschedule = vi.fn();
		mount("2026-09-29", onReschedule);
		const [arrival] = screen.getAllByRole("combobox") as HTMLSelectElement[];
		fireEvent.change(arrival, { target: { value: "anytime" } });
		expect(arrival.value).toBe("anytime");
		fireEvent.click(screen.getByRole("button", { name: /this & all future/i }));
		expect(arrival.value).toBe("at");
		fireEvent.click(screen.getByRole("button", { name: "Save" }));
		const input = onReschedule.mock.calls[0][0];
		expect(new Date(input.new_start_at).getHours()).toBe(9);
	});
});
