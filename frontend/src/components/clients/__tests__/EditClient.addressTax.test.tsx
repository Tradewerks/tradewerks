import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { AxiosError, type AxiosResponse } from "axios";
import EditClientModal from "../EditClient";
import type { Client } from "../../../types/clients";
import type { TaxGroup } from "../../../types/tax";

const mutateAsync = vi.fn();

vi.mock("../../../hooks/useClients", () => ({
	useUpdateClientMutation: () => ({ mutateAsync, isPending: false }),
	useDeleteClientMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/useTaxGroups", () => ({
	useTaxGroups: () => ({
		data: [
			{
				id: "g-wi",
				name: "WI Standard",
				is_default: true,
				is_active: true,
				combined_rate: 0.0825,
				rates: [],
			} as unknown as TaxGroup,
		],
	}),
}));
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

const client = {
	id: "c1",
	name: "Acme",
	address: "1 Main St, La Crosse, WI",
	is_active: true,
} as unknown as Client;

const refusal = new AxiosError("409", "ERR_BAD_REQUEST", undefined, undefined, {
	status: 409,
	data: {
		error: {
			code: "ADDRESS_TAX_CHOICE_REQUIRED",
			details: {
				rate_label: "La Crosse, WI",
				rate: 0.055,
				documents: [{ kind: "invoice", id: "i1", number: "INV-0021" }],
			},
		},
	},
} as AxiosResponse);

const renderModal = (onClose = vi.fn()) =>
	render(
		<MemoryRouter>
			<EditClientModal isOpen onClose={onClose} client={client} />
		</MemoryRouter>,
	);

beforeEach(() => mutateAsync.mockReset());

describe("EditClient address-change tax prompt", () => {
	it("a refusal asks which tax, then resubmits with the answer", async () => {
		mutateAsync.mockRejectedValueOnce(refusal).mockResolvedValue({});
		const onClose = vi.fn();
		renderModal(onClose);
		await userEvent.click(screen.getByRole("button", { name: "Move address" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));

		expect(await screen.findByText(/This client's draft invoices were taxed/)).toBeTruthy();
		expect(screen.getByText(/INV-0021/)).toBeTruthy();
		expect(screen.queryByText(/≈/)).toBeNull();
		expect(onClose).not.toHaveBeenCalled();
		const save = screen.getByRole("button", { name: "Save Changes" });
		expect(save).toBeDisabled();

		await userEvent.click(screen.getByRole("radio", { name: /Keep La Crosse, WI rate/ }));
		await userEvent.click(save);
		expect(mutateAsync).toHaveBeenCalledTimes(2);
		expect(mutateAsync.mock.calls[0][0].data.address_tax_choice).toBeUndefined();
		expect(mutateAsync.mock.calls[1][0].data).toMatchObject({
			address: "100 N State St, Chicago, IL",
			address_tax_choice: "keep",
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("closing drops an unanswered refusal", async () => {
		mutateAsync.mockRejectedValueOnce(refusal);
		const onClose = vi.fn();
		renderModal(onClose);
		await userEvent.click(screen.getByRole("button", { name: "Move address" }));
		await userEvent.click(screen.getByRole("button", { name: "Save Changes" }));
		await screen.findByText(/This client's draft invoices were taxed/);
		const buttons = screen.getAllByRole("button");
		await userEvent.click(buttons[0]); // the header close (X)
		expect(onClose).toHaveBeenCalled();
		expect(screen.queryByText(/This client's draft invoices were taxed/)).toBeNull();
	});
});
