import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError, type AxiosResponse } from "axios";
import EditJob from "../EditJob";
import type { Job } from "../../../types/jobs";
import type { TaxGroup, TaxSnapshot } from "../../../types/tax";

const mutateAsync = vi.fn();

vi.mock("../../../hooks/useJobs", () => ({
	useUpdateJobMutation: () => ({ mutateAsync }),
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

const WI = {
	id: "g-wi",
	name: "WI Standard",
	is_default: true,
	is_active: true,
	combined_rate: 0.0825,
	rates: [{ tax_rate: { rate: 0.05 } }, { tax_rate: { rate: 0.0325 } }],
} as unknown as TaxGroup;
vi.mock("../../../hooks/useTaxGroups", () => ({ useTaxGroups: () => ({ data: [WI] }) }));

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
			taxable_amount_cents: 42000,
			tax_amount_cents: 2310,
		},
	],
	non_taxable_amount_cents: 0,
	total_tax_cents: 2310,
	subtotal_cents: 42000,
	discount_cents: 0,
	total_cents: 44310,
	effective_rate: 0.055,
} as TaxSnapshot;

const job = (snapshot: TaxSnapshot | null) =>
	({
		id: "job-1",
		name: "Furnace swap",
		description: "Replace furnace",
		priority: "Medium",
		address: "1 Main St, La Crosse, WI",
		coords: { lat: 43.8, lon: -91.2 },
		client: { name: "Acme", is_tax_exempt: false, tax_group_id: null },
		line_items: [
			{
				id: "6f1c2b9e-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
				name: "Labor",
				quantity: 1,
				unit_price: 420,
				total: 420,
				taxable: true,
				tax_group_id: null,
			},
		],
		tax_rate: 0,
		discount_type: "amount",
		discount_value: 0,
		tax_snapshot: snapshot,
		actual_total: null,
	}) as unknown as Job;

const toFinalize = async () => {
	await userEvent.click(screen.getByRole("button", { name: /Next/ }));
	await userEvent.click(screen.getByRole("button", { name: /Next/ }));
};

const sentUpdates = () => mutateAsync.mock.calls.at(-1)?.[0].updates;

beforeEach(() => mutateAsync.mockReset());

describe("EditJob address-change tax prompt", () => {
	it("blocks Save until answered and sends the answer", async () => {
		mutateAsync.mockResolvedValue({});
		render(<EditJob isModalOpen setIsModalOpen={vi.fn()} job={job(keptSnapshot)} />);
		await userEvent.click(screen.getByRole("button", { name: "Move address" }));
		await toFinalize();

		expect(screen.getByText(/This job was taxed at the La Crosse, WI address rate/)).toBeTruthy();
		expect(screen.getByText("Choose a tax above")).toBeTruthy();
		const save = screen.getByRole("button", { name: "Save Changes" });
		expect(save).toBeDisabled();

		await userEvent.click(screen.getByRole("radio", { name: /Use WI Standard/ }));
		expect(screen.getByText("Tax — WI Standard")).toBeTruthy();
		expect(save).toBeEnabled();
		await userEvent.click(save);
		expect(sentUpdates().address_tax_choice).toBe("default");
	});

	it("reopening drops an answer given to an earlier refusal", async () => {
		const refusal = new AxiosError("409", "ERR_BAD_REQUEST", undefined, undefined, {
			status: 409,
			data: {
				error: {
					code: "ADDRESS_TAX_CHOICE_REQUIRED",
					details: { rate_label: "La Crosse, WI", rate: 0.055, documents: [] },
				},
			},
		} as AxiosResponse);
		mutateAsync.mockRejectedValueOnce(refusal).mockResolvedValue({});
		const j = job(null);
		const { rerender } = render(<EditJob isModalOpen setIsModalOpen={vi.fn()} job={j} />);
		await toFinalize();
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		expect(sentUpdates().address_tax_choice).toBeUndefined();
		await userEvent.click(await screen.findByRole("radio", { name: /Use WI Standard/ }));

		rerender(<EditJob isModalOpen={false} setIsModalOpen={vi.fn()} job={j} />);
		rerender(<EditJob isModalOpen setIsModalOpen={vi.fn()} job={j} />);
		await toFinalize();
		expect(screen.queryByRole("radio")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		expect(mutateAsync).toHaveBeenCalledTimes(2);
		expect(sentUpdates().address_tax_choice).toBeUndefined();
	});
});
