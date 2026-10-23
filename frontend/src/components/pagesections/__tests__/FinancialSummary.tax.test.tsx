import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import FinancialSummary from "../FinancialSummary";
import type { TaxSnapshot } from "../../../types/tax";

const base = {
	locked_at: "draft",
	client_exempt: false,
	non_taxable_amount_cents: 0,
	total_tax_cents: 550,
	subtotal_cents: 10000,
	discount_cents: 0,
	total_cents: 10550,
	effective_rate: 0.055,
};

const rates = [
	{ id: "r1", name: "State", rate: 0.05, jurisdiction_type: "state" },
	{ id: "r2", name: "County", rate: 0.005, jurisdiction_type: "county" },
];

const v2: TaxSnapshot = {
	...base,
	version: 2,
	source: "provider",
	rounding: "line_floor",
	groups: [
		{
			id: "g1",
			name: "Madison, WI (auto)",
			rates,
			taxable_amount_cents: 10000,
			tax_amount_cents: 550,
		},
	],
};

const v1: TaxSnapshot = {
	...base,
	version: 1,
	groups: [
		{
			id: "g1",
			name: "Standard",
			rates: [rates[0]],
			taxable_amount_cents: 10000,
			tax_amount_cents: 500,
		},
	],
};

const props = {
	lineItems: [{ name: "Repair", quantity: 1, unit_price: 100 }],
	metaLabel: "Quote #",
	metaValue: "Q-1",
	totalsContent: null,
};

describe("FinancialSummary tax provenance", () => {
	it("shows the source chip and lookup location for a v2 snapshot", () => {
		render(<FinancialSummary {...props} taxSnapshot={v2} taxSource="provider" />);
		expect(screen.getByTitle("Rate looked up from the service address")).toBeInTheDocument();
		expect(screen.getByText("Rates for Madison, WI")).toBeInTheDocument();
	});

	it("renders a single tax breakdown in auto mode", () => {
		const reviewed: TaxSnapshot = {
			...v2,
			review_reason: "Not registered to collect in IL",
			non_taxable_amount_cents: 5000,
		};
		render(
			<FinancialSummary
				{...props}
				lineItems={[
					{ name: "Repair", quantity: 1, unit_price: 100, taxable: true },
					{ name: "Labor", quantity: 1, unit_price: 50, taxable: false },
				]}
				subtotal={150}
				taxSnapshot={reviewed}
				taxSource="provider"
			/>,
		);
		// Each jurisdiction, and its amount, appears exactly once.
		expect(screen.getAllByText(/^State\b/)).toHaveLength(1);
		expect(screen.getAllByText(/^County\b/)).toHaveLength(1);
		expect(screen.getAllByText("$5.00")).toHaveLength(1);
		expect(screen.getAllByText("$0.50")).toHaveLength(1);
		expect(screen.getAllByText("$5.50")).toHaveLength(1);
		expect(screen.queryByText(/Jurisdictions/)).not.toBeInTheDocument();
	});

	it("orders jurisdiction rows state, county, city", () => {
		const snap: TaxSnapshot = {
			...v2,
			groups: [{ ...v2.groups[0], rates: [rates[1], { id: "r3", name: "City", rate: 0, jurisdiction_type: "city" }, rates[0]] }],
		};
		const { container } = render(<FinancialSummary {...props} taxSnapshot={snap} taxSource="provider" />);
		const text = container.textContent ?? "";
		expect(text.indexOf("State (")).toBeLessThan(text.indexOf("County ("));
		expect(text.indexOf("County (")).toBeLessThan(text.indexOf("City ("));
	});

	it("states the taxable basis and what was left out", () => {
		render(
			<FinancialSummary
				{...props}
				taxSnapshot={{ ...v2, subtotal_cents: 15000, non_taxable_amount_cents: 5000 }}
				taxSource="provider"
			/>,
		);
		expect(screen.getByText("Taxable lines $100.00 · $50.00 not taxed")).toBeInTheDocument();
	});

	it("lists the discount before tax, matching how tax is computed", () => {
		const { container } = render(
			<FinancialSummary {...props} subtotal={100} discountAmount={10} taxSnapshot={v2} taxSource="provider" />,
		);
		const text = container.textContent ?? "";
		expect(text.indexOf("Discount")).toBeGreaterThan(-1);
		expect(text.indexOf("Discount")).toBeLessThan(text.indexOf("State ("));
	});

	it("says the client is exempt instead of showing no tax line", () => {
		render(
			<FinancialSummary
				{...props}
				taxSnapshot={{ ...v1, client_exempt: true, groups: [] }}
				taxSource={null}
			/>,
		);
		expect(screen.getByText("Client is tax exempt")).toBeInTheDocument();
	});

	it("shows No Tax on a non-taxable line even when a group is stamped on it", () => {
		render(
			<FinancialSummary
				{...props}
				lineItems={[
					{ name: "Labor", quantity: 1, unit_price: 50, taxable: false, tax_group: { name: "Standard" } },
				]}
				taxSnapshot={v1}
				taxSource="org_default"
			/>,
		);
		expect(screen.getByText("No Tax")).toBeInTheDocument();
		expect(screen.queryByText(/^Standard/)).not.toBeInTheDocument();
	});

	it("renders neither for a v1 snapshot with no source", () => {
		render(<FinancialSummary {...props} taxSnapshot={v1} taxSource={null} />);
		expect(screen.queryByText("Auto address rate")).not.toBeInTheDocument();
		expect(screen.queryByText(/Jurisdictions/)).not.toBeInTheDocument();
	});

	it("tags a taxable ungrouped line 'Auto address rate' on an address-sourced document", () => {
		const lineItems = [{ name: "Repair", quantity: 1, unit_price: 100, taxable: true }];
		for (const source of ["provider", "cached_stale"] as const) {
			const { unmount } = render(
				<FinancialSummary {...props} lineItems={lineItems} taxSnapshot={v2} taxSource={source} />,
			);
			expect(screen.getByTitle("Taxed at the service address rate")).toHaveTextContent("Auto address rate");
			expect(screen.queryByText("No Tax")).not.toBeInTheDocument();
			unmount();
		}
	});

	it("keeps No Tax for non-taxable lines and for untaxed documents", () => {
		const { unmount } = render(
			<FinancialSummary
				{...props}
				lineItems={[{ name: "Labor", quantity: 1, unit_price: 50, taxable: false }]}
				taxSnapshot={v2}
				taxSource="provider"
			/>,
		);
		expect(screen.getByText("No Tax")).toBeInTheDocument();
		expect(screen.queryByTitle("Taxed at the service address rate")).not.toBeInTheDocument();
		unmount();

		render(
			<FinancialSummary
				{...props}
				lineItems={[{ name: "Repair", quantity: 1, unit_price: 100, taxable: true }]}
				taxSnapshot={v1}
				taxSource={null}
			/>,
		);
		expect(screen.getByText("No Tax")).toBeInTheDocument();
		expect(screen.queryByTitle("Taxed at the service address rate")).not.toBeInTheDocument();
	});

	it("tags an ungrouped line with the client group that taxed it", () => {
		const clientGroup = {
			id: "cg",
			name: "WI Standard",
			rates: [{ id: "r9", name: "WI State", rate: 0.0825 }],
			taxable_amount_cents: 10000,
			tax_amount_cents: 825,
		};
		const standard = { ...v1.groups[0], taxable_amount_cents: 5000, tax_amount_cents: 250 };
		render(
			<FinancialSummary
				{...props}
				lineItems={[
					{ name: "Repair", quantity: 1, unit_price: 100, taxable: true },
					{ name: "Part", quantity: 1, unit_price: 50, taxable: true, tax_group: { name: "Standard" } },
				]}
				taxSnapshot={{ ...v1, groups: [standard, clientGroup] }}
				taxSource="manual_override"
			/>,
		);
		expect(screen.getByText(/^WI Standard/)).toHaveTextContent("WI Standard · WI State 8.25%");
		expect(screen.queryByText("No Tax")).not.toBeInTheDocument();
	});

	it("renders no per-line taxability note, even for a stored snapshot that still has lines", () => {
		const legacy = {
			...v2,
			lines: [{ id: "li-1", tax_category: "hvac_service", taxability_source: "rule", derived: false }],
		} as TaxSnapshot;
		render(
			<FinancialSummary
				{...props}
				lineItems={[
					{ id: "li-1", name: "Repair", quantity: 1, unit_price: 100, taxable: true },
					{ id: "li-2", name: "Part", quantity: 1, unit_price: 10, taxable: false },
				]}
				taxSnapshot={legacy}
				taxSource="provider"
			/>,
		);
		expect(screen.queryByText(/Taxable —/)).not.toBeInTheDocument();
		expect(screen.queryByText(/hvac_service|HVAC service/)).not.toBeInTheDocument();
		expect(screen.getByText("No Tax")).toBeInTheDocument();
	});
});

describe("FinancialSummary taxIsEstimate", () => {
	it("prefixes Total Tax with an approximation sign when several rates are shown", () => {
		render(<FinancialSummary {...props} taxSnapshot={v2} taxSource="provider" taxIsEstimate />);
		expect(screen.getByText("≈ $5.50")).toBeInTheDocument();
	});

	it("prefixes the only rate row when there is no Total Tax row", () => {
		render(<FinancialSummary {...props} taxSnapshot={v1} taxIsEstimate />);
		expect(screen.getByText("≈ $5.00")).toBeInTheDocument();
	});

	it("shows plain amounts by default", () => {
		render(<FinancialSummary {...props} taxSnapshot={v2} taxSource="provider" />);
		expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
	});
});
