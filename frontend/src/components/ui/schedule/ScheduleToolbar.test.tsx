import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScheduleToolbar, { type ScheduleToolbarProps } from "./ScheduleToolbar";

function setup(overrides: Partial<ScheduleToolbarProps> = {}) {
	const props: ScheduleToolbarProps = {
		periodLabel: "Sep 28 – Oct 4, 2026",
		prevLabel: "Previous week",
		nextLabel: "Next week",
		onToday: vi.fn(),
		onPrev: vi.fn(),
		onNext: vi.fn(),
		showVisits: true,
		onToggleVisits: vi.fn(),
		showOccurrences: false,
		onToggleOccurrences: vi.fn(),
		techFilter: <span>filter</span>,
		...overrides,
	};
	render(<ScheduleToolbar {...props} />);
	return props;
}

describe("ScheduleToolbar", () => {
	it("gives the chevrons accessible names", async () => {
		const p = setup();
		await userEvent.click(screen.getByRole("button", { name: "Previous week" }));
		await userEvent.click(screen.getByRole("button", { name: "Next week" }));
		expect(p.onPrev).toHaveBeenCalledOnce();
		expect(p.onNext).toHaveBeenCalledOnce();
	});

	it("exposes layer toggle state via aria-pressed", () => {
		setup();
		expect(screen.getByRole("button", { name: "Visits" })).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByRole("button", { name: "Recurring" })).toHaveAttribute("aria-pressed", "false");
	});

	it("keeps the resting border on an unselected toggle", () => {
		setup();
		expect(screen.getByRole("button", { name: "Recurring" }).className).toContain("border-border");
	});

	it("omits the view switch without viewMode", () => {
		setup();
		expect(screen.queryByRole("button", { name: "Month" })).toBeNull();
	});

	it("renders week/month segments with state", async () => {
		const onViewModeChange = vi.fn();
		setup({ viewMode: "month", onViewModeChange });
		expect(screen.getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(screen.getByRole("button", { name: "Week" }));
		expect(onViewModeChange).toHaveBeenCalledWith("week");
	});

	it("compact mode hides toggle text but keeps accessible names", () => {
		setup({ compact: true });
		expect(screen.getByRole("button", { name: "Visits" })).toBeInTheDocument();
		expect(screen.queryByText("Visits")).toBeNull();
	});
});
