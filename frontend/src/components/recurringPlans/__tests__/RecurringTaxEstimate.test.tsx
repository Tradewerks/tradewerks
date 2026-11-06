import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RecurringTaxEstimate from "../RecurringTaxEstimate";

describe("RecurringTaxEstimate", () => {
	it("shows the figure line and rate note for an estimate", () => {
		render(
			<RecurringTaxEstimate
				estimate={{
					status: "estimate",
					subtotal_cents: 18900,
					tax_cents: 1040,
					total_cents: 19940,
					place: "La Crosse, WI",
				}}
			/>
		);
		expect(
			screen.getByText("Plan price $189.00 · Est. tax $10.40 · Est. total $199.40")
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Estimated at today's La Crosse, WI rate. Each job is taxed when it's created."
			)
		).toBeInTheDocument();
	});

	it("omits the rate note when nothing is taxable", () => {
		render(
			<RecurringTaxEstimate
				estimate={{
					status: "estimate",
					subtotal_cents: 5000,
					tax_cents: 0,
					total_cents: 5000,
					place: "",
				}}
			/>
		);
		expect(
			screen.getByText("Plan price $50.00 · Est. tax $0.00 · Est. total $50.00")
		).toBeInTheDocument();
		expect(screen.queryByText(/Estimated at today's/)).toBeNull();
	});

	it("shows exempt copy", () => {
		render(<RecurringTaxEstimate estimate={{ status: "exempt" }} />);
		expect(screen.getByText("Client is tax exempt")).toBeInTheDocument();
	});

	it("shows unknown copy without a zero figure", () => {
		const { container } = render(<RecurringTaxEstimate estimate={{ status: "unknown" }} />);
		expect(
			screen.getByText("Tax is added to each job at the service address rate.")
		).toBeInTheDocument();
		expect(container.textContent).not.toContain("$0.00");
	});

	it("renders nothing while loading", () => {
		const { container } = render(<RecurringTaxEstimate estimate={undefined} />);
		expect(container).toBeEmptyDOMElement();
	});
});
