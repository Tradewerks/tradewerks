import { describe, it, expect } from "vitest";
import { isValidElement, type ReactNode } from "react";
import { InvoicePdfTemplate } from "../invoicePdfTemplate.js";

type TemplateProps = Parameters<typeof InvoicePdfTemplate>[0];

// The template's tax rows are inline primitives, so walking the element tree finds their text
// without rendering a PDF.
function textOf(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("|");
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode; render?: unknown };
		return textOf(props.children);
	}
	return "";
}

function render(taxAmount: string, snapOver: Record<string, unknown>) {
	const invoice = {
		status: "Issued",
		invoice_number: "INV-1001",
		created_at: "2026-10-19T00:00:00.000Z",
		subtotal: "100.00",
		tax_amount: taxAmount,
		total: String(100 + Number(taxAmount)),
		amount_paid: "0",
		balance_due: String(100 + Number(taxAmount)),
		tax_snapshot: {
			version: 2,
			source: "qb_ast",
			qb_tax_cents: Math.round(Number(taxAmount) * 100),
			locked_at: "2026-10-19T00:00:00.000Z",
			client_exempt: false,
			groups: [{ id: "g1", name: "WI State", tax_amount_cents: 550, rates: [] }],
			total_tax_cents: 550,
			...snapOver,
		},
		line_items: [],
	} as unknown as TemplateProps["invoice"];
	return textOf(InvoicePdfTemplate({ invoice, org: { name: "Acme HVAC" } }));
}

describe("InvoicePdfTemplate tax row on a QuickBooks-adopted invoice", () => {
	it("shows QuickBooks' figure for a taxable client", () => {
		const text = render("6.10", {});
		expect(text).toContain("Sales tax");
		expect(text).not.toContain("WI State");
	});

	it("shows Tax Exempt, not a $0.00 QuickBooks row, for an exempt client", () => {
		const text = render("0", { client_exempt: true });
		expect(text).toContain("Tax Exempt");
		expect(text).not.toContain("Sales tax");
	});

	it("keeps QuickBooks' row when it charged an exempt client tax, so the total adds up", () => {
		const text = render("6.10", { client_exempt: true });
		expect(text).toContain("Sales tax");
		expect(text).not.toContain("Tax Exempt");
	});
});
