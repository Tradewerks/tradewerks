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

	it("pins the rail without letting the grid stretch it", () => {
		// `items-start` is what makes `sticky` able to move at all — a
		// stretched grid item silently ignores it.
		panel();
		const rail = screen.getByText("note surface").parentElement!;
		expect(rail.className).toContain("lg:sticky");
		expect(rail.className).toContain("lg:self-start");
		expect(rail.parentElement!.className).toContain("items-start");
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
