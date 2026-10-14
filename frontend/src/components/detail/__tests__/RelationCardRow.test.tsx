import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import RelationCardRow from "../RelationCardRow";

/**
 * The column count is the whole point of the component, and it is only
 * observable as a class, so these assert on className rather than on rendered
 * text.
 */
function rowOf(container: HTMLElement) {
	return container.firstElementChild as HTMLElement;
}

describe("RelationCardRow", () => {
	it("renders a single column for one card", () => {
		const { container } = render(
			<RelationCardRow>
				<div>one</div>
			</RelationCardRow>
		);

		expect(rowOf(container).className).toContain("grid-cols-1");
		expect(rowOf(container).className).not.toContain("sm:grid-cols-2");
	});

	it("renders two columns for two cards", () => {
		const { container } = render(
			<RelationCardRow>
				<div>one</div>
				<div>two</div>
			</RelationCardRow>
		);

		expect(rowOf(container).className).toContain("sm:grid-cols-2");
	});

	// Three in a two-column grid is what wrapped to a second row and inflated
	// the Job page's main column by 138px.
	it("renders three columns for three cards, so the row never wraps", () => {
		const { container } = render(
			<RelationCardRow>
				<div>one</div>
				<div>two</div>
				<div>three</div>
			</RelationCardRow>
		);

		expect(rowOf(container).className).toContain("sm:grid-cols-3");
	});

	it("caps at three columns rather than inventing a fourth", () => {
		const { container } = render(
			<RelationCardRow>
				<div>one</div>
				<div>two</div>
				<div>three</div>
				<div>four</div>
			</RelationCardRow>
		);

		expect(rowOf(container).className).toContain("sm:grid-cols-3");
		expect(rowOf(container).className).not.toContain("sm:grid-cols-4");
	});

	// The pages pass fragments of conditionally-rendered cards, so the count has
	// to survive that shape.
	it("counts through fragments and ignores falsy children", () => {
		const { container } = render(
			<RelationCardRow>
				<>
					<div>one</div>
					<div>two</div>
				</>
				{null}
				{false}
			</RelationCardRow>
		);

		expect(rowOf(container).className).toContain("sm:grid-cols-2");
	});

	it("renders nothing when there are no cards", () => {
		const { container } = render(<RelationCardRow>{null}</RelationCardRow>);

		expect(container.firstElementChild).toBeNull();
	});

	// In the rail the row is a third of the grid wide, where two cards side by
	// side would each be too narrow to read. Stacking is the same cards, one per
	// row, and it is what the placement hook predicts the height from.
	it("stacks into a single column when stacked is set", () => {
		const { container } = render(
			<RelationCardRow stacked>
				<div>one</div>
				<div>two</div>
			</RelationCardRow>
		);

		expect(rowOf(container).className).toContain("grid-cols-1");
		expect(rowOf(container).className).not.toContain("sm:grid-cols-2");
	});
});
