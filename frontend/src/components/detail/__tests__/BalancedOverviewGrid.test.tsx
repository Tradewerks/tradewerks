import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ColumnPlacement } from "../useColumnBalance";

const placement = vi.hoisted(() => ({ current: "main" as ColumnPlacement }));
vi.mock("../useColumnBalance", () => ({
	default: () => ({ placement: placement.current, ready: true }),
}));

import BalancedOverviewGrid from "../BalancedOverviewGrid";

/**
 * Which column a card ends up in is only observable through the DOM tree, since
 * the columns are two sibling divs distinguished by their span class.
 */
function columnOf(node: HTMLElement) {
	const cell = node.closest('[class*="col-span"]');
	return cell?.className.includes("lg:col-span-2") ? "main" : "rail";
}

function renderGrid(block?: ReactNode) {
	return render(
		<BalancedOverviewGrid
			recordId="r1"
			infoCard={<div>Info Card</div>}
			railCard={<div>Client Card</div>}
			block={block}
		/>
	);
}

describe("BalancedOverviewGrid", () => {
	beforeEach(() => {
		placement.current = "main";
	});

	it("puts the relation block under the info card by default", () => {
		renderGrid(
			<>
				<div>Related Quote</div>
				<div>Related Job</div>
			</>
		);

		expect(columnOf(screen.getByText("Info Card"))).toBe("main");
		expect(columnOf(screen.getByText("Client Card"))).toBe("rail");
		expect(columnOf(screen.getByText("Related Quote"))).toBe("main");
	});

	it("moves the relation block into the rail when the hook says so", () => {
		placement.current = "rail";
		renderGrid(
			<>
				<div>Related Quote</div>
				<div>Related Job</div>
			</>
		);

		expect(columnOf(screen.getByText("Related Quote"))).toBe("rail");
		expect(columnOf(screen.getByText("Related Job"))).toBe("rail");
		// The info card does not follow it.
		expect(columnOf(screen.getByText("Info Card"))).toBe("main");
	});

	// A card rendered twice would duplicate DOM ids and double every click
	// handler, so the move has to be a move, not a copy.
	it("renders the block exactly once", () => {
		placement.current = "rail";
		renderGrid(<div>Related Quote</div>);

		expect(screen.getAllByText("Related Quote")).toHaveLength(1);
	});

	it("renders no relation row when there is no block", () => {
		renderGrid(null);

		expect(screen.getByText("Info Card")).toBeInTheDocument();
		expect(screen.getByText("Client Card")).toBeInTheDocument();
		expect(screen.queryByText("Related Quote")).toBeNull();
	});
});
