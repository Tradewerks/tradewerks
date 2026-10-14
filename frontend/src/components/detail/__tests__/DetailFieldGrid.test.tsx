import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DetailFieldGrid from "../DetailFieldGrid";

describe("DetailFieldGrid", () => {
	/**
	 * dt/dd as adjacent siblings in one wrapper is what makes "Address" the
	 * accessible label for its value rather than a heading sitting above it.
	 */
	it("pairs each label with its value as adjacent dt and dd", () => {
		render(<DetailFieldGrid fields={[{ label: "Address", value: "4417 Bell Ave" }]} />);

		const term = screen.getByText("Address");
		const value = screen.getByText("4417 Bell Ave");
		expect(term.tagName).toBe("DT");
		expect(value.tagName).toBe("DD");
		expect(term.nextElementSibling).toBe(value);
	});

	it("renders every field it is given", () => {
		render(
			<DetailFieldGrid
				fields={[
					{ label: "Address", value: "4417 Bell Ave" },
					{ label: "Created", value: "Sep 3, 2026" },
				]}
			/>
		);

		expect(screen.getByText("Created")).toBeInTheDocument();
		expect(screen.getByText("Sep 3, 2026")).toBeInTheDocument();
	});

	// A paragraph at the top of a card titled "Job Information" needs no
	// "Description" heading over it.
	it("renders lead content without a label of its own", () => {
		render(
			<DetailFieldGrid
				lead={<p>Replace condenser fan motor.</p>}
				fields={[{ label: "Address", value: "4417 Bell Ave" }]}
			/>
		);

		expect(screen.getByText("Replace condenser fan motor.")).toBeInTheDocument();
		expect(screen.queryByText("Description")).toBeNull();
	});

	// The rule separates the lead from the pairs. With no lead there is nothing
	// above to separate from, and a rule against the card's own header border
	// reads as a double line.
	it("rules the pairs off from a lead, and omits the rule when there is none", () => {
		const { container: withLead } = render(
			<DetailFieldGrid lead={<p>Lead</p>} fields={[{ label: "A", value: "1" }]} />
		);
		const { container: without } = render(
			<DetailFieldGrid fields={[{ label: "A", value: "1" }]} />
		);

		expect(withLead.querySelector("dl")!.className).toContain("border-t");
		expect(without.querySelector("dl")!.className).not.toContain("border-t");
	});

	// A field name is never the alarming part.
	it("puts tone on the value, not the label", () => {
		render(
			<DetailFieldGrid
				fields={[{ label: "Balance", value: "-$240.00", tone: "error" }]}
			/>
		);

		expect(screen.getByText("-$240.00").className).toContain("text-error-text");
		expect(screen.getByText("Balance").className).not.toContain("text-error-text");
	});

	// A visit with no scheduling fields would otherwise render an empty dl, and
	// an empty dl still takes the rule and the row gap.
	it("renders no list at all when there are no fields", () => {
		const { container } = render(
			<DetailFieldGrid lead={<p>Lead only</p>} fields={[]} />
		);

		expect(container.querySelector("dl")).toBeNull();
		expect(screen.getByText("Lead only")).toBeInTheDocument();
	});

	/**
	 * Without fill the card is top-aligned and a stretched grid cell leaves the
	 * slack pooled at the bottom inside the border. With it, the description
	 * holds the top and the field list holds the base.
	 */
	it("is top-aligned by default", () => {
		const { container } = render(
			<DetailFieldGrid
				lead={<p>A rooftop unit needs replacing.</p>}
				fields={[{ label: "Created", value: "Sep 3, 2026" }]}
			/>
		);

		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.className).toContain("space-y-4");
		expect(wrapper.className).not.toContain("justify-between");
	});

	it("distributes its zones when fill is set", () => {
		const { container } = render(
			<DetailFieldGrid
				fill
				lead={<p>A rooftop unit needs replacing.</p>}
				fields={[{ label: "Created", value: "Sep 3, 2026" }]}
			/>
		);

		const wrapper = container.firstElementChild as HTMLElement;
		expect(wrapper.className).toContain("justify-between");
		expect(wrapper.className).toContain("flex-1");
	});

	it("still renders the same content in fill mode", () => {
		render(
			<DetailFieldGrid
				fill
				lead={<p>A rooftop unit needs replacing.</p>}
				fields={[{ label: "Created", value: "Sep 3, 2026" }]}
			/>
		);

		expect(screen.getByText("A rooftop unit needs replacing.")).toBeInTheDocument();
		expect(screen.getByText("Created")).toBeInTheDocument();
		expect(screen.getByText("Sep 3, 2026")).toBeInTheDocument();
	});
});
