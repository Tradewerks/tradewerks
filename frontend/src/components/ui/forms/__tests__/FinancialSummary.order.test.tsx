import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import FinancialSummary from "../FinancialSummary";
import type { TaxSnapshot } from "../../../../types/tax";

const base = {
	subtotal: 3995,
	discountType: "amount" as const,
	discountValue: 100,
	discountAmount: 100,
	total: 4100,
	isLoading: false,
	onDiscountTypeChange: vi.fn(),
	onDiscountValueChange: vi.fn(),
};

const snapshot = {
	version: 2,
	locked_at: "2026-10-01T00:00:00Z",
	client_exempt: false,
	groups: [
		{
			id: "g1",
			name: "Address rate",
			rates: [{ id: "r1", name: "WI", rate: 0.055 }],
			taxable_amount_cents: 399500,
			tax_amount_cents: 21973,
		},
	],
	non_taxable_amount_cents: 0,
	total_tax_cents: 21973,
	subtotal_cents: 399500,
	discount_cents: 10000,
	total_cents: 411473,
	effective_rate: 0.055,
	source: null,
	rounding: "line_floor",
} as unknown as TaxSnapshot;

const before = (a: Node, b: Node) =>
	Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe("FinancialSummary row order and formatting", () => {
	test("snapshot mode shows Discount exactly once, above the first Tax row", () => {
		render(<FinancialSummary {...base} snapshot={snapshot} />);
		const discounts = screen.getAllByText("Discount");
		expect(discounts).toHaveLength(1);
		expect(before(discounts[0], screen.getByText(/^Tax — Address rate/))).toBe(true);
	});

	test("live mode puts Discount above the Tax row", () => {
		render(<FinancialSummary {...base} taxRate={5} onTaxRateChange={vi.fn()} taxAmount={10} />);
		expect(before(screen.getByText("Discount"), screen.getByText("Tax Rate"))).toBe(true);
	});

	test("subtotal gets thousands separators", () => {
		render(<FinancialSummary {...base} />);
		expect(screen.getAllByText("$3,995.00").length).toBeGreaterThan(0);
		expect(screen.getByText("-$100.00")).toBeTruthy();
	});
});
