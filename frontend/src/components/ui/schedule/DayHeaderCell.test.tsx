import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DayHeaderCell from "./DayHeaderCell";

describe("DayHeaderCell", () => {
	it("renders weekday and date on the header hook", () => {
		const { container } = render(
			<DayHeaderCell dateStr="2026-09-29" isToday={false} isZoomed={false} height={44} />
		);
		expect(container.querySelector('[data-day-header="2026-09-29"]')).not.toBeNull();
		expect(screen.getByText("Tue")).toHaveAttribute("data-day-weekday");
		expect(screen.getByText("29")).toHaveAttribute("data-day-num");
	});

	it("has no zoom button without a handler", () => {
		render(<DayHeaderCell dateStr="2026-09-29" isToday={false} isZoomed={false} height={32} />);
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("labels and toggles zoom", async () => {
		const onToggleZoom = vi.fn();
		const { rerender } = render(
			<DayHeaderCell dateStr="2026-09-29" isToday isZoomed={false} height={44} onToggleZoom={onToggleZoom} />
		);
		const btn = screen.getByRole("button", { name: "Expand Tue 29" });
		expect(btn).toHaveAttribute("aria-pressed", "false");
		await userEvent.click(btn);
		expect(onToggleZoom).toHaveBeenCalledOnce();
		rerender(<DayHeaderCell dateStr="2026-09-29" isToday isZoomed height={44} onToggleZoom={onToggleZoom} />);
		expect(screen.getByRole("button", { name: "Collapse Tue 29" })).toHaveAttribute("aria-pressed", "true");
	});

	it("renders actions before the zoom button", () => {
		render(
			<DayHeaderCell
				dateStr="2026-09-29"
				isToday
				isZoomed
				height={32}
				onToggleZoom={() => {}}
				actions={<button type="button">Open Tue 29 in schedule</button>}
			/>
		);
		const buttons = screen.getAllByRole("button");
		expect(buttons.map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual([
			"Open Tue 29 in schedule",
			"Collapse Tue 29",
		]);
	});

	it("renders actions without a zoom handler", () => {
		render(
			<DayHeaderCell
				dateStr="2026-09-29"
				isToday
				isZoomed
				height={32}
				actions={<button type="button">Open Tue 29 in schedule</button>}
			/>
		);
		expect(screen.getAllByRole("button")).toHaveLength(1);
	});
});
