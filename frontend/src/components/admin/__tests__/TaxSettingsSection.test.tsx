import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { TaxSettings } from "../../../api/taxSettings";
import type { TaxGroup, TaxRate } from "../../../types/tax";
import { RATES_EXPLAINER, defaultRowLabel } from "../tax/taxSettingsCopy";

const base: TaxSettings = {
	tax_mode: "manual",
	effective_tax_mode: "manual",
	auto_entitled: true,
	tax_registered_states: ["WI"],
	org_state: "WI",
	qb_passthrough_required: false,
	legacy_rate: 0,
};
let settings: TaxSettings = base;

const rate = (id: string): TaxRate => ({
	id,
	organization_id: "o",
	name: `Rate ${id}`,
	rate: 0.01,
	description: null,
	jurisdiction: null,
	is_default: false,
	is_active: true,
	created_at: "",
	updated_at: "",
});
const group = (id: string): TaxGroup => ({
	id,
	organization_id: "o",
	name: `Group ${id}`,
	description: null,
	is_default: false,
	is_active: true,
	rates: [],
	combined_rate: 0,
	created_at: "",
	updated_at: "",
});

vi.mock("../../../hooks/useTaxSettings", () => ({
	useTaxSettings: () => ({ data: settings, isLoading: false, error: null }),
	useAutoSwitchPreview: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
	useUpdateTaxSettings: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("../../ui/useToast", () => ({
	useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));
vi.mock("../../../hooks/useTaxGroups", () => {
	const mutation = { mutateAsync: vi.fn(), isPending: false };
	return {
		useTaxRates: () => ({ data: [rate("1"), rate("2"), rate("3")], isLoading: false, error: null }),
		useTaxGroups: () => ({ data: [group("a"), group("b")], isLoading: false, error: null }),
		useCreateTaxRate: () => mutation,
		useUpdateTaxRate: () => mutation,
		useDeleteTaxRate: () => mutation,
		useCreateTaxGroup: () => mutation,
		useUpdateTaxGroup: () => mutation,
		useDeleteTaxGroup: () => mutation,
	};
});

import TaxSettingsSection from "../TaxSettingsSection";

const KEY = "hvac.taxSettings.tab";
const renderSection = () =>
	render(
		<MemoryRouter>
			<TaxSettingsSection />
		</MemoryRouter>,
	);

beforeEach(() => {
	settings = base;
	localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("TaxSettingsSection", () => {
	it("renders one Tax card instead of three", () => {
		renderSection();
		expect(screen.getByRole("heading", { name: "Calculation" })).toBeInTheDocument();
		expect(screen.queryByText("Tax Rates")).toBeNull();
		expect(screen.queryByText("Tax Groups")).toBeNull();
		expect(screen.queryByText("Tax calculation")).toBeNull();
	});

	it("opens on Groups and switches to Rates, remembering the choice", () => {
		renderSection();
		expect(screen.getByRole("tab", { name: "Groups (2)" })).toHaveAttribute("aria-selected", "true");
		fireEvent.click(screen.getByRole("tab", { name: "Rates (3)" }));
		expect(screen.getByRole("tab", { name: "Rates (3)" })).toHaveAttribute("aria-selected", "true");
		expect(screen.getByText(RATES_EXPLAINER)).toBeInTheDocument();
		expect(localStorage.getItem(KEY)).toBe("tax-rates");
	});

	it("restores the remembered tab", () => {
		localStorage.setItem(KEY, "tax-rates");
		renderSection();
		expect(screen.getByRole("tab", { name: "Rates (3)" })).toHaveAttribute("aria-selected", "true");
	});

	it("falls back to Groups on a junk stored value", () => {
		localStorage.setItem(KEY, "banana");
		renderSection();
		expect(screen.getByRole("tab", { name: "Groups (2)" })).toHaveAttribute("aria-selected", "true");
	});

	it("falls back to Groups when storage throws", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		renderSection();
		expect(screen.getByRole("tab", { name: "Groups (2)" })).toHaveAttribute("aria-selected", "true");
		fireEvent.click(screen.getByRole("tab", { name: "Rates (3)" }));
		expect(screen.getByRole("tab", { name: "Rates (3)" })).toHaveAttribute("aria-selected", "true");
	});

	it("stored auto but effective manual uses manual wording", () => {
		settings = { ...base, tax_mode: "auto", effective_tax_mode: "manual" };
		renderSection();
		expect(screen.getByText(defaultRowLabel("manual"))).toBeInTheDocument();
		expect(screen.getByText(/Automatic tax is off for your plan/)).toBeInTheDocument();
	});

	it.each(["manual", "auto"] as const)("has no taxability card or pack picker in %s mode", (mode) => {
		settings = { ...base, tax_mode: mode, effective_tax_mode: mode };
		renderSection();
		expect(screen.queryByText(/taxability/i)).toBeNull();
		expect(screen.queryByText(/\bpack\b/i)).toBeNull();
	});
});
