import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ActivityPanel from "../ActivityPanel";

const panel = (over: Partial<Parameters<typeof ActivityPanel>[0]> = {}) =>
	render(
		<ActivityPanel
			notes={<div>note surface</div>}
			lifecycle={<div>dispute record</div>}
			history={<div>change log</div>}
			{...over}
		/>
	);

// The lg: assertions check the className string, not rendered layout: jsdom has
// no viewport, so they catch a dropped class, not a broken breakpoint.
describe("ActivityPanel", () => {
	it("wires the panel to its tab", () => {
		panel();
		const region = screen.getByRole("tabpanel");
		expect(region.id).toBe("tabpanel-activity");
		expect(region.getAttribute("aria-labelledby")).toBe("tab-activity");
	});

	it("names the section for screen readers only", () => {
		panel();
		const heading = screen.getByRole("heading", { level: 2, name: "Activity" });
		expect(heading.className).toContain("sr-only");
	});

	it("reads record first, write surface last, in both directions", () => {
		panel();
		// DOM order is the reading order at every width, so focus order and
		// layout can never point opposite ways.
		const order = ["dispute record", "change log", "note surface"].map(
			(t) => screen.getByText(t)
		);
		expect(order[0].compareDocumentPosition(order[1])).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING
		);
		expect(order[1].compareDocumentPosition(order[2])).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING
		);
	});

	it("keeps the record and the rail in separate columns", () => {
		panel();
		const main = screen.getByText("dispute record").parentElement!;
		const rail = screen.getByText("note surface").parentElement!;
		expect(main).not.toBe(rail);
		expect(main.className).toContain("lg:col-span-2");
		expect(main).toContainElement(screen.getByText("change log"));
		expect(rail.className).toContain("lg:col-span-1");
	});

	it("lets the grid stretch both columns and keeps the rail out of the row's sizing", () => {
		panel();
		const rail = screen.getByText("note surface").parentElement!;
		const grid = rail.parentElement!;
		expect(grid.className).not.toContain("items-start");
		expect(rail.className).not.toContain("lg:sticky");
		expect(rail.className).not.toContain("lg:self-start");
		expect(rail.className).toContain("lg:contain-size"); // many notes can't grow the row
		expect(rail.className).toContain("lg:min-h-104"); // floor: header + composer + ~1 note
	});

	it("grows the main column's last card into any extra height", () => {
		panel();
		const main = screen.getByText("change log").parentElement!;
		expect(main.className).toContain("flex-col");
		expect(main.className).toContain("[&>:last-child]:flex-1");
	});

	it("still fills the main column when there is nothing to record", () => {
		// LifecycleRecord returns null with no disputes and no chain refs, but
		// ChangeHistory always renders, so the main column keeps its weight.
		panel({ lifecycle: null });
		const main = screen.getByText("change log").parentElement!;
		expect(main.className).toContain("lg:col-span-2");
		expect(main.textContent).toBe("change log");
	});
});
