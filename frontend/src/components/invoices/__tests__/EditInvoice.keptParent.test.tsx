import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EditInvoice from "../EditInvoice";
import type { Invoice } from "../../../types/invoices";
import type { TaxGroup, TaxSnapshot } from "../../../types/tax";

vi.mock("../../../hooks/useInvoices", () => ({
	useUpdateInvoiceMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useAutoTaxMode", () => ({ useAutoTaxMode: () => false }));
vi.mock("../../../hooks/useInventory", () => ({ useAllInventoryQuery: () => ({ data: [] }) }));
vi.mock("../../ui/forms/LineItemsSection", () => ({
	default: ({ keptRateLabel }: { keptRateLabel?: string | null }) => (
		<div>{keptRateLabel ?? "no kept option"}</div>
	),
}));
vi.mock("../../ui/DatePicker", () => ({ default: () => null }));

const G = {
	id: "g-std",
	name: "Standard",
	is_default: true,
	is_active: true,
	combined_rate: 0.05,
	rates: [{ tax_rate: { rate: 0.05 } }],
} as unknown as TaxGroup;
vi.mock("../../../hooks/useTaxGroups", () => ({ useTaxGroups: () => ({ data: [G] }) }));

// The linked job's kept rate, itself rounded line_floor: the invoice still rounds half-up
// (roundingFor(null)), as the server's recompute does.
const jobSnapshot = {
	version: 2,
	locked_at: "draft",
	source: "provider",
	rate_set_id: "rs-1",
	rounding: "line_floor",
	client_exempt: false,
	groups: [
		{
			id: "rs-1",
			name: "La Crosse, WI (auto)",
			rates: [
				{ id: "r1", name: "WI", rate: 0.05 },
				{ id: "r2", name: "La Crosse County", rate: 0.005 },
			],
			taxable_amount_cents: 110,
			tax_amount_cents: 5,
		},
	],
	non_taxable_amount_cents: 0,
	total_tax_cents: 10,
	subtotal_cents: 220,
	discount_cents: 0,
	total_cents: 230,
	effective_rate: 0.055,
} as TaxSnapshot;

const line = (id: string, tax_group_id: string | null) => ({
	id,
	name: `Part ${id}`,
	quantity: 1,
	unit_price: 1.1,
	total: 1.1,
	taxable: true,
	tax_group_id,
});

const invoice = (adjusts_invoice_id: string | null, tax_snapshot: TaxSnapshot | null = null) =>
	({
		id: "inv-1",
		invoice_number: "INV-0001",
		status: "Draft",
		client: { name: "Acme", is_tax_exempt: false, tax_group_id: null },
		line_items: [line("l-1", G.id), line("l-2", null)],
		tax_rate: 0,
		discount_type: "amount",
		discount_value: 0,
		tax_snapshot,
		parent_tax_snapshot: jobSnapshot,
		adjusts_invoice_id,
		jobs: [],
		visits: [],
	}) as unknown as Invoice;

const next = () => userEvent.click(screen.getByRole("button", { name: /Next/ }));

describe("EditInvoice with a kept rate inherited from its job", () => {
	it("shows the kept row and rounds half-up", async () => {
		render(<EditInvoice isModalOpen setIsModalOpen={vi.fn()} invoice={invoice(null)} />);
		await next();
		expect(screen.getByText("Address rate · La Crosse, WI 5.5%")).toBeTruthy();
		await next();
		expect(screen.getByText(/Tax — Address rate \(kept\)/)).toBeTruthy();
		// Standard 5.5¢ → 6; kept 5.5¢ → 6 + 0.55¢ → 1.
		expect(screen.getByText("$0.06")).toBeTruthy();
		expect(screen.getByText("$0.07")).toBeTruthy();
		expect(screen.getByText("$2.33")).toBeTruthy();
	});

	it("an adjustment does not inherit its job's kept rate", async () => {
		render(<EditInvoice isModalOpen setIsModalOpen={vi.fn()} invoice={invoice("inv-0")} />);
		await next();
		expect(screen.getByText("no kept option")).toBeTruthy();
		await next();
		expect(screen.queryByText(/Address rate/)).toBeNull();
	});

	it("an invoice with its own non-kept snapshot does not inherit its job's kept rate", async () => {
		const own = { ...jobSnapshot, source: "manual_override", rate_set_id: null } as TaxSnapshot;
		render(<EditInvoice isModalOpen setIsModalOpen={vi.fn()} invoice={invoice(null, own)} />);
		await next();
		expect(screen.getByText("no kept option")).toBeTruthy();
		await next();
		expect(screen.queryByText(/Address rate/)).toBeNull();
	});
});
