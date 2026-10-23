import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { TaxGroup, TaxRate } from "../../../../types/tax";
import { RATES_EXPLAINER } from "../taxSettingsCopy";

const rate = (id: string, name: string): TaxRate => ({
	id,
	organization_id: "o",
	name,
	rate: 0.01,
	description: null,
	jurisdiction: null,
	is_default: false,
	is_active: true,
	created_at: "",
	updated_at: "",
});
const rateA = rate("a", "State");
const rateB = rate("b", "County");
const rateC = rate("c", "City");
const group = (id: string, isActive: boolean, rates: TaxRate[]): TaxGroup => ({
	id,
	organization_id: "o",
	name: id,
	description: null,
	is_default: false,
	is_active: isActive,
	rates: rates.map((r, i) => ({ id: `${id}-${r.id}`, sort_order: i, tax_rate: r })),
	combined_rate: 0,
	created_at: "",
	updated_at: "",
});

const create = { mutateAsync: vi.fn(async () => ({})), isPending: false };
const mutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../../hooks/useTaxGroups", () => ({
	useTaxRates: () => ({ data: [rateA, rateB, rateC], isLoading: false, error: null }),
	useTaxGroups: () => ({
		data: [group("g1", true, [rateA]), group("g2", false, [rateB])],
		isLoading: false,
		error: null,
	}),
	useCreateTaxRate: () => create,
	useUpdateTaxRate: () => mutation,
	useDeleteTaxRate: () => mutation,
}));

import TaxRatesTab from "../TaxRatesTab";

beforeEach(() => create.mutateAsync.mockClear());

describe("TaxRatesTab", () => {
	it("has no Default column", () => {
		render(<TaxRatesTab showInactive={false} />);
		expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
		expect(screen.queryByRole("columnheader", { name: "Default" })).toBeNull();
	});

	it("shows the rates explainer", () => {
		render(<TaxRatesTab showInactive={false} />);
		expect(screen.getByText(RATES_EXPLAINER)).toBeInTheDocument();
	});

	it("notes an active rate that no active group uses", () => {
		render(<TaxRatesTab showInactive={false} />);
		expect(screen.getAllByText("Not in any group")).toHaveLength(2);
		const rowA = screen.getByText("State").closest("tr")!;
		expect(within(rowA).queryByText("Not in any group")).toBeNull();
		const rowB = screen.getByText("County").closest("tr")!;
		expect(within(rowB).getByText("Not in any group")).toBeInTheDocument();
	});

	it("rate form has no default checkbox and does not send is_default", () => {
		render(<TaxRatesTab showInactive={false} />);
		fireEvent.click(screen.getByRole("button", { name: /Add Rate/ }));
		expect(screen.queryByText("Set as default rate")).toBeNull();
		const dialog = screen.getByRole("dialog");
		fireEvent.change(within(dialog).getByPlaceholderText("e.g. Sales Tax"), {
			target: { value: "Town" },
		});
		fireEvent.change(within(dialog).getByPlaceholderText("6.5"), { target: { value: "0.5" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Add Rate" }));
		expect(create.mutateAsync).toHaveBeenCalledTimes(1);
		const arg = (create.mutateAsync.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
		expect("is_default" in arg).toBe(false);
		expect(arg).toMatchObject({ name: "Town", rate: 0.005 });
	});
});
