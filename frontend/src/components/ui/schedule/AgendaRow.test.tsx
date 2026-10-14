import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import AgendaRow, { type AgendaRowProps } from "./AgendaRow";

function setup(overrides: Partial<AgendaRowProps> = {}) {
	const props: AgendaRowProps = {
		anytime: false,
		showTime: true,
		time: "7:00",
		suffix: "am",
		title: "Rooftop Unit Replacement — Smith Commercial Building 2",
		priorityColor: "#ea580c",
		isOccurrence: false,
		techs: [{ id: "t1", color: "#3b82f6" }],
		who: "John Smith",
		onClick: vi.fn(),
		onDragStart: vi.fn(),
		onDragEnd: vi.fn(),
		...overrides,
	};
	const utils = render(<AgendaRow {...props} />);
	return { props, ...utils };
}

describe("AgendaRow", () => {
	it("shows time, suffix and the full title, clamped to two lines", () => {
		const { container } = setup();
		expect(container.querySelector("[data-agenda-rail]")!.textContent).toBe("7:00am");
		const title = container.querySelector("[data-agenda-title]")!;
		expect(title.textContent).toBe("Rooftop Unit Replacement — Smith Commercial Building 2");
		expect(title.className).toContain("line-clamp-2");
	});

	it("names the row by time, title and who, and exposes the full title on hover", () => {
		setup();
		const row = screen.getByRole("button", {
			name: "7:00 am, Rooftop Unit Replacement — Smith Commercial Building 2, John Smith",
		});
		expect(row).toHaveAttribute("title", "Rooftop Unit Replacement — Smith Commercial Building 2");
		expect(row).toHaveAttribute("draggable", "true");
	});

	it("labels Anytime rows and blanks a repeated time", () => {
		const { container, rerender, props } = setup({ anytime: true, time: "", suffix: "" });
		expect(container.querySelector("[data-agenda-rail]")!.textContent).toBe("Anytime");
		expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/^Anytime, /);
		rerender(<AgendaRow {...props} anytime={false} time="8:00" suffix="am" showTime={false} />);
		expect(container.querySelector("[data-agenda-rail]")!.textContent).toBe("");
		expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(/^8:00 am, /);
	});

	it("hides dots and leaves who out of the name when who is null", () => {
		const { container } = setup({ who: null });
		expect(container.querySelector("[data-agenda-dots]")).toBeNull();
		expect(screen.getByRole("button").getAttribute("aria-label")).toBe(
			"7:00 am, Rooftop Unit Replacement — Smith Commercial Building 2"
		);
	});

	it("dims a dragging row like MonthMiniCard", () => {
		setup({ isDragging: true });
		const row = screen.getByRole("button");
		expect(row.style.opacity).toBe("0.4");
		expect(row.style.outline).toBe("");
	});

	it("marks a ghost row with the dashed primary outline", () => {
		setup({ isGhost: true });
		const row = screen.getByRole("button");
		expect(row.style.opacity).toBe("0.5");
		expect(row.style.outline).toBe("1px dashed var(--color-primary)");
		expect(row.style.outlineOffset).toBe("1px");
		expect(row.style.boxShadow).toBe("inset 0 0 0 999px var(--color-primary-bg-dim)");
	});

	it("is fully opaque at rest", () => {
		setup();
		expect(screen.getByRole("button").style.opacity).toBe("1");
	});

	it("activates on click, Enter and Space", () => {
		const { props } = setup();
		const row = screen.getByRole("button");
		fireEvent.click(row);
		fireEvent.keyDown(row, { key: "Enter" });
		fireEvent.keyDown(row, { key: " " });
		expect(props.onClick).toHaveBeenCalledTimes(3);
	});

	describe("tech dots", () => {
		const dots = (c: HTMLElement) =>
			c.querySelectorAll("[data-agenda-dots] > span.rounded-full").length;

		it("shows one dot per tech", () => {
			const { container } = setup();
			expect(dots(container)).toBe(1);
		});

		it("caps dots at 3 and counts the rest", () => {
			const techs = ["a", "b", "c", "d"].map((id) => ({ id, color: "#3b82f6" }));
			const { container } = setup({ techs, who: "4 techs" });
			expect(dots(container)).toBe(3);
			expect(container.querySelector("[data-agenda-dots]")!.textContent).toBe("+1");
		});

		it("shows one unassigned dot for an unassigned visit", () => {
			const { container } = setup({ techs: [], who: "Unassigned" });
			const dot = container.querySelector<HTMLElement>("[data-agenda-dots] > span.rounded-full")!;
			expect(dot.style.backgroundColor).toBe("var(--color-tech-unassigned)");
		});
	});
});
