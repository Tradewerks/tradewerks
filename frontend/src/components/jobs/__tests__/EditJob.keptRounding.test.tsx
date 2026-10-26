import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import EditJob from "../EditJob";
import type { Job } from "../../../types/jobs";
import type { TaxGroup, TaxSnapshot } from "../../../types/tax";

vi.mock("../../../hooks/useJobs", () => ({
	useUpdateJobMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useAutoTaxMode", () => ({ useAutoTaxMode: () => false }));
vi.mock("../../../hooks/useInventory", () => ({ useAllInventoryQuery: () => ({ data: [] }) }));
vi.mock("../../ui/forms/LineItemsSection", () => ({ default: () => null }));
vi.mock("../../ui/AddressForm", () => ({
	default: ({ handleChange }: { handleChange: (r: unknown) => void }) => (
		<button
			type="button"
			onClick={() =>
				handleChange({
					address: "100 N State St, Chicago, IL",
					coords: { lat: 41.9, lon: -87.6 },
				})
			}
		>
			Move address
		</button>
	),
}));

const G = {
	id: "g-std",
	name: "Standard",
	is_default: true,
	is_active: true,
	combined_rate: 0.05,
	rates: [{ tax_rate: { rate: 0.05 } }],
} as unknown as TaxGroup;
vi.mock("../../../hooks/useTaxGroups", () => ({ useTaxGroups: () => ({ data: [G] }) }));

const keptSnapshot = {
	version: 2,
	locked_at: "draft",
	source: "provider",
	rate_set_id: "rs-1",
	rounding: "jurisdiction_half_up",
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
			tax_amount_cents: 7,
		},
	],
	non_taxable_amount_cents: 0,
	total_tax_cents: 13,
	subtotal_cents: 220,
	discount_cents: 0,
	total_cents: 233,
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

const job = (snapshot: TaxSnapshot | null, quoteSnapshot?: TaxSnapshot) =>
	({
		id: "job-1",
		name: "Furnace swap",
		description: "Replace furnace",
		priority: "Medium",
		address: "1 Main St, La Crosse, WI",
		coords: { lat: 43.8, lon: -91.2 },
		client: { name: "Acme", is_tax_exempt: false, tax_group_id: null },
		line_items: [
			line("6f1c2b9e-1a2b-4c3d-8e4f-5a6b7c8d9e01", G.id),
			line("6f1c2b9e-1a2b-4c3d-8e4f-5a6b7c8d9e02", null),
		],
		tax_rate: 0,
		discount_type: "amount",
		discount_value: 0,
		tax_snapshot: snapshot,
		quote: quoteSnapshot ? { id: "q-1", tax_snapshot: quoteSnapshot } : null,
		actual_total: null,
	}) as unknown as Job;

const toFinalize = async () => {
	await userEvent.click(screen.getByRole("button", { name: /Next/ }));
	await userEvent.click(screen.getByRole("button", { name: /Next/ }));
};

// $1.10 at 5%: 5.5¢ — half-up 6¢, line_floor 5¢.
describe("EditJob rounding on a job holding a kept address rate", () => {
	it("explicit-group rows round as the server's kept snapshot does", async () => {
		render(<EditJob isModalOpen setIsModalOpen={vi.fn()} job={job(keptSnapshot)} />);
		await toFinalize();
		expect(screen.getByText("$0.06")).toBeTruthy();
		expect(screen.queryByText("$0.05")).toBeNull();
		// 220 + 6 (Standard) + 7 (kept: 5.5 → 6, 0.55 → 1) = the server's 233.
		expect(screen.getByText("$2.33")).toBeTruthy();
	});

	it("the address-prompt chosen group adds up to the server's merged total", async () => {
		render(<EditJob isModalOpen setIsModalOpen={vi.fn()} job={job(keptSnapshot)} />);
		await userEvent.click(screen.getByRole("button", { name: "Move address" }));
		await toFinalize();
		await userEvent.click(screen.getByRole("radio", { name: /Use Standard/ }));
		// Server: all 220 in Standard, half-up → 11¢.
		expect(screen.getByText("$2.31")).toBeTruthy();
	});

	it("a job kept only through its quote shows the kept row and rounds half-up", async () => {
		// The server falls back to the quote's rate and rounds as roundingFor(null): half-up,
		// whatever the quote itself used.
		const floorQuote = { ...keptSnapshot, rounding: "line_floor" } as TaxSnapshot;
		render(<EditJob isModalOpen setIsModalOpen={vi.fn()} job={job(null, floorQuote)} />);
		await toFinalize();
		expect(screen.getByText(/Tax — Address rate \(kept\)/)).toBeTruthy();
		expect(screen.getByText("$0.07")).toBeTruthy();
		expect(screen.getByText("$0.06")).toBeTruthy();
		expect(screen.getByText("$2.33")).toBeTruthy();
	});

	it("a manual job without a kept rate stays line_floor", async () => {
		render(<EditJob isModalOpen setIsModalOpen={vi.fn()} job={job(null)} />);
		await toFinalize();
		expect(screen.getByText("$0.05")).toBeTruthy();
		expect(screen.queryByText("$0.06")).toBeNull();
	});
});
