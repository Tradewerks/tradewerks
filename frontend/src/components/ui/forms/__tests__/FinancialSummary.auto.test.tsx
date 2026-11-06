import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import FinancialSummary from "../FinancialSummary";

const base = {
	subtotal: 100,
	discountType: "amount" as const,
	discountValue: 10,
	discountAmount: 10,
	total: 90,
	isLoading: false,
	onDiscountTypeChange: vi.fn(),
	onDiscountValueChange: vi.fn(),
	taxRate: 3,
	onTaxRateChange: vi.fn(),
};

const EST = {
	rate: 0.055,
	rates: [0.05, 0.005],
	place: "Madison, WI",
	rounding: "line_floor" as const,
};

describe("FinancialSummary auto tax row", () => {
	test("shows the estimate, amount and Est. footer", () => {
		render(
			<FinancialSummary
				{...base}
				autoTax={{ autoTaxableAmount: 90, estimate: EST }}
			/>,
		);
		expect(screen.getByText(/est\. 5\.5% · Madison, WI/)).toBeTruthy();
		expect(screen.getByText("≈ $4.95")).toBeTruthy();
		expect(screen.getByText("Est. Total Amount")).toBeTruthy();
		expect(screen.getByText("$94.95")).toBeTruthy();
	});

	test("without an estimate shows calculated-on-save and the before-tax footer", () => {
		render(<FinancialSummary {...base} autoTax={{ autoTaxableAmount: 90, estimate: null }} />);
		const muted = screen.getByText("Auto — calculated on save");
		expect(muted.parentElement?.textContent).not.toMatch(/Auto\s+Auto/);
		expect(screen.getAllByText(/Auto — calculated on save/)).toHaveLength(1);
		expect(screen.getByText("Total Amount (before auto tax)")).toBeTruthy();
		expect(screen.getByText("$90.00")).toBeTruthy();
	});

	test("with zero tax groups the legacy totalTax is not added to the auto footer", () => {
		render(
			<FinancialSummary
				{...base}
				taxRate={5.5}
				totalTax={5.5}
				groupsSummary={[]}
				autoTax={{ autoTaxableAmount: 90, estimate: EST }}
			/>,
		);
		expect(screen.getByText("$94.95")).toBeTruthy();
		expect(screen.queryByText("$100.45")).toBeNull();
	});

	test("hides the editable tax rate row even when onTaxRateChange is passed", () => {
		render(<FinancialSummary {...base} autoTax={{ autoTaxableAmount: 90, estimate: null }} />);
		expect(screen.queryByText("Tax Rate")).toBeNull();
	});

	test("without autoTax the legacy row renders", () => {
		render(<FinancialSummary {...base} />);
		expect(screen.getByText("Tax Rate")).toBeTruthy();
		expect(screen.queryByText(/Tax — Auto/)).toBeNull();
	});

	test("does not double count legacy tax that is already inside total", () => {
		render(
			<FinancialSummary
				{...base}
				taxRate={5.5}
				taxAmount={5.5}
				total={95.5}
				autoTax={{ autoTaxableAmount: 90, estimate: EST }}
			/>,
		);
		expect(screen.getByText("$94.95")).toBeTruthy();
		expect(screen.queryByText("$5.50")).toBeNull();
		expect(screen.queryByText("$100.45")).toBeNull();
	});

	test("includes group override tax in the base, never the legacy amount", () => {
		render(
			<FinancialSummary
				{...base}
				taxRate={5.5}
				taxAmount={5.5}
				total={95.5}
				totalTax={2}
				groupsSummary={[
					{
						group: { id: "g1", name: "Override", rates: [], combined_rate: 0.04 },
						tax_amount: 2,
					} as never,
				]}
				autoTax={{ autoTaxableAmount: 90, estimate: null }}
			/>,
		);
		expect(screen.getByText("$92.00")).toBeTruthy();
		expect(screen.queryByText("$5.50")).toBeNull();
	});
});
