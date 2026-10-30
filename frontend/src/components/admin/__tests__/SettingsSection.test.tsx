import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent, waitFor } from "@testing-library/react";
import SettingsSection from "../SettingsSection";

const state = vi.hoisted(() => ({
	org: {} as Record<string, unknown>,
	update: vi.fn(),
}));

vi.mock("../../../hooks/useOrg", () => ({
	useOrgSettings: () => ({ data: state.org, isLoading: false }),
	useUploadOrgLogo: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useDeleteOrgLogo: () => ({ mutateAsync: vi.fn(), isPending: false }),
	useUpdateOrgSettings: () => ({ mutateAsync: state.update, isPending: false }),
	useOrgCosting: () => ({ data: undefined, isLoading: false }),
	useUpdateOrgCosting: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../TaxSettingsSection", () => ({ default: () => null }));
vi.mock("../../../components/ui/AddressForm", () => ({ default: () => null }));

const baseOrg = {
	id: "org-1",
	name: "Acme HVAC",
	logo_url: null,
	phone: null,
	address: null,
	coords: null,
	email: null,
	website: null,
	tax_rate: "0",
	restock_mode: "tech_self_serve",
	measurement_system: "imperial",
	mfa_required: false,
	brand_color: null,
	field_purchase_second_signoff_threshold: null,
};

beforeEach(() => {
	state.org = { ...baseOrg };
	state.update.mockReset().mockResolvedValue({ ...baseOrg });
});

describe("org settings radio groups", () => {
	test("each setting is a named group with its help text as description", () => {
		render(<SettingsSection />);
		const restock = screen.getByRole("group", { name: "Vehicle Restock Workflow" });
		expect(within(restock).getAllByRole("radio")).toHaveLength(2);
		expect(restock).toHaveAccessibleDescription(/never/i);
		const units = screen.getByRole("group", { name: "Measurement System" });
		expect(within(units).getAllByRole("radio")).toHaveLength(2);
	});

	test("an org refetch (e.g. logo upload) keeps an unsaved radio change", () => {
		const { rerender } = render(<SettingsSection />);
		fireEvent.click(screen.getByRole("radio", { name: /Dispatch prepared/ }));
		state.org = { ...baseOrg, logo_url: "https://cdn/logo.png" };
		rerender(<SettingsSection />);
		expect(screen.getByRole("radio", { name: /Dispatch prepared/ })).toBeChecked();
	});

	test("a successful save reseeds the form from the saved response", async () => {
		// Server normalized something else in the meantime — the reseed must show it.
		state.update.mockResolvedValue({
			...baseOrg,
			measurement_system: "metric",
			name: "Acme HVAC Inc",
		});
		render(<SettingsSection />);
		fireEvent.click(screen.getByRole("radio", { name: /Metric/ }));
		fireEvent.click(screen.getAllByRole("button", { name: "Save Changes" })[0]);
		await waitFor(() =>
			expect(state.update).toHaveBeenCalledWith(
				expect.objectContaining({ measurement_system: "metric" })
			)
		);
		await waitFor(() =>
			expect(screen.getByDisplayValue("Acme HVAC Inc")).toBeInTheDocument()
		);
		expect(screen.getByRole("radio", { name: /Metric/ })).toBeChecked();
	});

	test("after a no-change save, a later logo refetch keeps an unsaved radio change", async () => {
		const { rerender } = render(<SettingsSection />);
		fireEvent.click(screen.getAllByRole("button", { name: "Save Changes" })[0]);
		await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByText("Changes saved.")).toBeInTheDocument());
		fireEvent.click(screen.getByRole("radio", { name: /Dispatch prepared/ }));
		state.org = { ...baseOrg, logo_url: "https://cdn/logo.png" };
		rerender(<SettingsSection />);
		expect(screen.getByRole("radio", { name: /Dispatch prepared/ })).toBeChecked();
	});

	test("a no-change save omits brand_color when the server has none", async () => {
		render(<SettingsSection />);
		fireEvent.click(screen.getAllByRole("button", { name: "Save Changes" })[0]);
		await waitFor(() => expect(state.update).toHaveBeenCalledTimes(1));
		expect(state.update.mock.calls[0][0]).not.toHaveProperty("brand_color");
	});

	test("an explicit brand color is still sent when the server has none", async () => {
		render(<SettingsSection />);
		fireEvent.change(screen.getByPlaceholderText("#1e3a5f"), {
			target: { value: "#ff0000" },
		});
		fireEvent.click(screen.getAllByRole("button", { name: "Save Changes" })[0]);
		await waitFor(() =>
			expect(state.update).toHaveBeenCalledWith(
				expect.objectContaining({ brand_color: "#ff0000" })
			)
		);
	});

	test("restock copy describes what each mode actually changes", () => {
		render(<SettingsSection />);
		expect(screen.getByText(/see Fill to Standard first/)).toBeInTheDocument();
		expect(
			screen.getByText(/requests lead the vehicle's tabs for dispatch/)
		).toBeInTheDocument();
	});

	test("measurement copy names the units that actually lead", () => {
		render(<SettingsSection />);
		expect(screen.getByText("m, kg, L lead the unit picker")).toBeInTheDocument();
		expect(screen.getByText("ft, lb, gal lead the unit picker")).toBeInTheDocument();
		expect(
			screen.getByRole("group", { name: "Measurement System" })
		).toHaveAccessibleDescription(/never converts quantities or hides a unit/i);
	});
});
