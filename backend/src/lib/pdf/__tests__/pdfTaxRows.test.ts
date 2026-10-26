import { describe, it, expect } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { InvoicePdfTemplate } from "../invoicePdfTemplate.js";
import { QuotePdfTemplate } from "../quotePdfTemplate.js";

function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("|");
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode };
		return textOf(props.children);
	}
	return "";
}

const rates = [
	{ id: "s", name: "WI", rate: 0.05, jurisdiction_type: "state" },
	{ id: "c", name: "LA CROSSE", rate: 0.005, jurisdiction_type: "county" },
	{ id: "t", name: "LA CROSSE", rate: 0, jurisdiction_type: "city" },
];

const snapshot = (over: Record<string, unknown> = {}) => ({
	version: 2,
	source: "provider",
	rounding: "jurisdiction_half_up",
	rate_set_id: "g1",
	locked_at: "draft",
	client_exempt: false,
	subtotal_cents: 61000,
	discount_cents: 0,
	non_taxable_amount_cents: 19000,
	total_tax_cents: 2310,
	total_cents: 63310,
	effective_rate: 0.055,
	groups: [
		{
			id: "g1",
			name: "La Crosse, WI (auto)",
			rates,
			taxable_amount_cents: 42000,
			tax_amount_cents: 2310,
		},
	],
	...over,
});

const lines = [
	{
		id: "a",
		name: "Furnace",
		quantity: 1,
		unit_price: "420",
		total: "420",
		taxable: true,
		tax_group: null,
	},
	{
		id: "b",
		name: "Labor",
		quantity: 1,
		unit_price: "190",
		total: "190",
		taxable: false,
		tax_group: { name: "WI Standard" },
	},
];

const common = (snap: unknown) => ({
	status: "Draft",
	created_at: "2026-10-19T00:00:00.000Z",
	subtotal: "610.00",
	tax_amount: "23.10",
	total: "633.10",
	amount_paid: "0",
	balance_due: "633.10",
	tax_snapshot: snap,
	line_items: lines,
});

const renderInvoice = (snap: unknown) =>
	textOf(
		InvoicePdfTemplate({
			invoice: { ...common(snap), invoice_number: "INV-1" } as never,
			org: { name: "Acme HVAC" },
		})
	);
const renderQuote = (snap: unknown) =>
	textOf(
		QuotePdfTemplate({
			quote: { ...common(snap), quote_number: "Q-1" } as never,
			org: { name: "Acme HVAC" },
		})
	);

describe.each([
	["invoice", renderInvoice],
	["quote", renderQuote],
])("%s PDF tax rows", (_name, render) => {
	it("prints Not taxed for a non-taxable line, not its group name", () => {
		const text = render(snapshot());
		expect(text).toContain("Not taxed");
		expect(text).not.toContain("WI Standard");
	});

	it("names each jurisdiction with its rate and drops the (auto) marker", () => {
		const text = render(snapshot());
		expect(text).toContain("Wisconsin state (5%)");
		expect(text).toContain("La Crosse County (0.5%)");
		expect(text).toContain("La Crosse city (0%)");
		expect(text).not.toContain("(auto)");
	});

	it("prints Total Tax for several rows and the taxability basis line", () => {
		const text = render(snapshot());
		expect(text).toContain("Total Tax");
		expect(text).toContain("Taxable lines $420.00 · $190.00 not taxed");
	});

	it("omits Total Tax when there is a single row", () => {
		const text = render(
			snapshot({
				groups: [
					{
						id: "g1",
						name: "Std",
						rates: [rates[0]],
						taxable_amount_cents: 42000,
						tax_amount_cents: 2100,
					},
				],
			})
		);
		expect(text).not.toContain("Total Tax");
	});

	it("a legacy rate-less group prints its name without a rate or the (auto) marker", () => {
		const text = render(
			snapshot({
				groups: [
					{
						id: "g1",
						name: "La Crosse, WI (auto)",
						rates: [],
						taxable_amount_cents: 42000,
						tax_amount_cents: 2310,
					},
				],
			})
		);
		expect(text).toContain("La Crosse, WI");
		expect(text).not.toContain("(auto)");
		expect(text).not.toContain("(0%)");
	});

	it("prints Tax Exempt for an exempt client", () => {
		const text = render(snapshot({ client_exempt: true }));
		expect(text).toContain("Tax Exempt");
		expect(text).not.toContain("Taxable lines");
	});
});

describe("adopted invoice", () => {
	it("keeps a single Sales tax row and no estimate wording", () => {
		const text = renderInvoice(snapshot({ source: "qb_ast", qb_tax_cents: 2310 }));
		expect(text).toContain("Sales tax");
		expect(text).not.toContain("Our estimate");
		expect(text).not.toContain("Wisconsin state");
		expect(text).not.toContain("Taxable lines");
	});
});
