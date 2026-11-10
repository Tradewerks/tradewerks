import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { TaxGroup, TaxRate } from "../../../../types/tax";
import { deactivateDefaultWarning, groupsExplainer } from "../taxSettingsCopy";

const rate = (id: string, name: string, value: number): TaxRate => ({
	id,
	organization_id: "o",
	name,
	rate: value,
	description: null,
	jurisdiction: null,
	is_default: false,
	is_active: true,
	created_at: "",
	updated_at: "",
});
const group = (over: Partial<TaxGroup> & { id: string; rateList?: TaxRate[] }): TaxGroup => {
	const { rateList = [], ...rest } = over;
	return {
		organization_id: "o",
		name: over.id,
		description: null,
		is_default: false,
		is_active: true,
		rates: rateList.map((r, i) => ({ id: `${over.id}-${r.id}`, sort_order: i, tax_rate: r })),
		combined_rate: 0,
		created_at: "",
		updated_at: "",
		...rest,
	};
};

const standard = group({
	id: "std",
	name: "Standard WI",
	is_default: true,
	combined_rate: 0.055,
	rateList: [rate("s", "WI State", 0.05), rate("c", "County", 0.005)],
});
const other = group({ id: "oth", name: "Other" });
let groups: TaxGroup[] = [standard, other];
const mutation = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../../hooks/useTaxGroups", () => ({
	useTaxGroups: () => ({ data: groups, isLoading: false, error: null }),
	useTaxRates: () => ({ data: [], isLoading: false, error: null }),
	useCreateTaxGroup: () => mutation,
	useUpdateTaxGroup: () => mutation,
	useDeleteTaxGroup: () => mutation,
}));

import TaxGroupsTab from "../TaxGroupsTab";

const renderTab = (mode: "auto" | "manual", legacyRate = 0) =>
	render(<TaxGroupsTab showInactive={false} mode={mode} legacyRate={legacyRate} />);

beforeEach(() => {
	groups = [standard, other];
});

describe("TaxGroupsTab", () => {
	it.each([
		["auto", "Fallback"],
		["manual", "Default"],
	] as const)("%s mode marks the default group with a %s chip", (mode, chip) => {
		renderTab(mode);
		const row = screen.getByText("Standard WI").closest("tr")!;
		expect(within(row).getByText(chip)).toBeInTheDocument();
		expect(screen.queryByRole("columnheader", { name: "Default" })).toBeNull();
	});

	it("no chip on an inactive group still flagged is_default", () => {
		groups = [group({ id: "stale", name: "Old", is_default: true, is_active: false }), other];
		renderTab("manual");
		expect(screen.queryByText("Default")).toBeNull();
		expect(screen.queryByText("Fallback")).toBeNull();
	});

	it.each(["auto", "manual"] as const)("shows the %s explainer", (mode) => {
		renderTab(mode);
		expect(screen.getByText(groupsExplainer(mode))).toBeInTheDocument();
	});

	it("lists each rate with its percent", () => {
		renderTab("manual");
		expect(screen.getByText("WI State 5% + County 0.5%")).toBeInTheDocument();
	});

	it.each([
		["auto", "Use as fallback group"],
		["manual", "Set as default group"],
	] as const)("%s modal checkbox reads %s", (mode, label) => {
		renderTab(mode);
		fireEvent.click(screen.getByRole("button", { name: /Add Group/ }));
		expect(within(screen.getByRole("dialog")).getByText(label)).toBeInTheDocument();
	});

	it("deactivating the default warns with the mode consequence", () => {
		renderTab("auto", 0.065);
		const row = screen.getByText("Standard WI").closest("tr")!;
		fireEvent.click(within(row).getByRole("button", { name: "Row actions" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Deactivate" }));
		expect(
			within(screen.getByRole("dialog")).getByText(deactivateDefaultWarning("auto", 0.065)),
		).toBeInTheDocument();
	});

	it("deactivating another group has no warning", () => {
		renderTab("auto", 0.065);
		const row = screen.getByText("Other").closest("tr")!;
		fireEvent.click(within(row).getByRole("button", { name: "Row actions" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Deactivate" }));
		expect(within(screen.getByRole("dialog")).queryByText(/After deactivating/)).toBeNull();
	});
});
