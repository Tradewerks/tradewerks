import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QbTaxEstimate } from "../QbTaxEstimate";
import type { TaxSnapshotRate, TaxSnapshotV2 } from "../../../types/tax";

const r = (id: string, name: string, rate: number, jurisdiction_type?: string): TaxSnapshotRate => ({
	id,
	name,
	rate,
	jurisdiction_type,
});

const qb = (rates: TaxSnapshotRate[], estimateCents: number): TaxSnapshotV2 => ({
	locked_at: "draft",
	client_exempt: false,
	non_taxable_amount_cents: 0,
	subtotal_cents: 0,
	discount_cents: 0,
	total_cents: 0,
	effective_rate: 0,
	version: 2,
	source: "qb_ast",
	rounding: "line_floor",
	qb_tax_cents: 812,
	total_tax_cents: estimateCents,
	groups: [{ id: "g1", name: "Std", rates, taxable_amount_cents: 10000, tax_amount_cents: estimateCents }],
});

describe("QbTaxEstimate", () => {
	it("collapses our estimate under 'Our estimate' even for a single rate", () => {
		render(<QbTaxEstimate snapshot={qb([r("a", "Sales", 0.075)], 750)} />);
		expect(screen.getByText("Our estimate $7.50")).toBeInTheDocument();
	});

	it("lists the estimate's jurisdictions inside the disclosure", () => {
		render(<QbTaxEstimate snapshot={qb([r("2", "City", 0.025, "city"), r("1", "State", 0.05, "state")], 750)} />);
		expect(screen.getAllByTestId("qb-estimate-name").map((n) => n.textContent)).toEqual(["State", "City"]);
	});
});
