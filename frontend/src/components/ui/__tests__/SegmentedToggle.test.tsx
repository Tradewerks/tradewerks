import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import SegmentedToggle from "../SegmentedToggle";

const OPTIONS = [
	{ id: "all" as const, label: "All", badge: 3 },
	{ id: "a" as const, label: "Alpha", badge: 0 },
];

describe("SegmentedToggle", () => {
	it("md size uses the 36px track", () => {
		render(
			<SegmentedToggle ariaLabel="Type" value="all" options={OPTIONS} onChange={() => {}} size="md" />
		);
		expect(screen.getByRole("group", { name: "Type" })).toHaveClass("h-9");
	});

	it("default size keeps the compact track", () => {
		render(<SegmentedToggle ariaLabel="Type" value="all" options={OPTIONS} onChange={() => {}} />);
		expect(screen.getByRole("group", { name: "Type" })).not.toHaveClass("h-9");
	});

	it("marks the active option pressed and reports clicks", () => {
		const onChange = vi.fn();
		render(
			<SegmentedToggle ariaLabel="Type" value="all" options={OPTIONS} onChange={onChange} size="md" />
		);
		expect(screen.getByRole("button", { name: /^All/ })).toHaveAttribute("aria-pressed", "true");
		fireEvent.click(screen.getByRole("button", { name: /^Alpha/ }));
		expect(onChange).toHaveBeenCalledWith("a");
	});
});
