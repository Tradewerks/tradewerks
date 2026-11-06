import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import FinancialSummary from "../FinancialSummary";

const base = {
	subtotal: 420,
	discountType: "amount" as const,
	discountValue: 0,
	discountAmount: 0,
	total: 420,
	isLoading: false,
	onDiscountTypeChange: vi.fn(),
	onDiscountValueChange: vi.fn(),
	taxRate: 3,
	onTaxRateChange: vi.fn(),
};

const EST = {
	rate: 0.055,
	rates: [0.055],
	place: "La Crosse, WI",
	rounding: "line_floor" as const,
};

describe("FinancialSummary kept address rate", () => {
	test("shows the exact kept-rate row with no approximation or Tax Rate input", () => {
		render(
			<FinancialSummary
				{...base}
				keptRate
				groupsSummary={[]}
				autoTax={{ autoTaxableAmount: 420, estimate: EST }}
			/>,
		);
		expect(screen.getByText(/Tax — Address rate \(kept\)/)).toBeTruthy();
		expect(screen.getByText("$23.10")).toBeTruthy();
		expect(screen.queryByText("Tax Rate")).toBeNull();
		expect(screen.queryByText(/≈/)).toBeNull();
		expect(screen.getByText("$443.10")).toBeTruthy();
		expect(screen.queryByText(/Est\./)).toBeNull();
	});

	test("an exempt client shows only the Exempt pill", () => {
		render(
			<FinancialSummary
				{...base}
				keptRate
				clientExempt
				autoTax={{ autoTaxableAmount: 420, estimate: EST }}
			/>,
		);
		expect(screen.getByText("Exempt")).toBeTruthy();
		expect(screen.queryByText(/Address rate \(kept\)/)).toBeNull();
	});
});

describe("FinancialSummary address changed on a kept rate", () => {
	const props = {
		...base,
		keptRate: true,
		groupsSummary: [],
		autoTax: { autoTaxableAmount: 420, estimate: null },
	};

	test("before an answer: asks, shows no figure and leaves tax out of the total", () => {
		render(<FinancialSummary {...props} totalLabel="Total" chosenTax="pending" />);
		expect(screen.getByText("Choose a tax above")).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
		expect(screen.getByText("Total (before tax)")).toBeTruthy();
		expect(screen.getByText("$420.00", { selector: "span.text-lg" })).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/auto/i);
	});

	test("after Default or Pick: the group's row, included in the total", () => {
		render(
			<FinancialSummary
				{...props}
				totalLabel="Total"
				chosenTax={{ label: "WI Standard", cents: 3465 }}
			/>,
		);
		expect(screen.getByText("Tax — WI Standard")).toBeTruthy();
		expect(screen.getByText("$34.65")).toBeTruthy();
		expect(screen.getByText("$454.65")).toBeTruthy();
		expect(screen.getByText("Total")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/auto|≈/i);
	});

	test("with no answer state in manual mode it never says Auto", () => {
		render(<FinancialSummary {...props} totalLabel="Total" />);
		expect(screen.getByText(/Calculated on save/)).toBeTruthy();
		expect(screen.getByText("Total (before tax)")).toBeTruthy();
		expect(document.body.textContent).not.toMatch(/auto/i);
	});
});
