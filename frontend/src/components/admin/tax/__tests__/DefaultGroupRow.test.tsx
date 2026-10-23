import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { TaxGroup } from "../../../../types/tax";
import { defaultRowLabel, defaultRowNote } from "../taxSettingsCopy";

const group = (id: string, name: string, over: Partial<TaxGroup> = {}): TaxGroup => ({
	id,
	organization_id: "o",
	name,
	description: null,
	is_default: false,
	is_active: true,
	rates: [],
	combined_rate: 0.055,
	created_at: "",
	updated_at: "",
	...over,
});

let groups: TaxGroup[] = [];
const groupsHook = vi.fn((_includeInactive?: boolean) => ({
	data: groups,
	isLoading: false,
	error: null,
}));
const update = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../../hooks/useTaxGroups", () => ({
	useTaxGroups: (includeInactive?: boolean) => groupsHook(includeInactive),
	useUpdateTaxGroup: () => update,
}));

import DefaultGroupRow from "../DefaultGroupRow";

const A = group("A", "Standard WI", { is_default: true });
const B = group("B", "Madison", { combined_rate: 0.06 });

beforeEach(() => {
	groups = [A, B];
	groupsHook.mockClear();
	update.mutateAsync.mockReset();
	update.mutateAsync.mockResolvedValue({});
});

const openPicker = () => fireEvent.click(screen.getByRole("button", { name: "Change" }));
const picker = () => screen.getByRole("combobox", { name: "Default group" });

describe("DefaultGroupRow", () => {
	it.each(["auto", "manual"] as const)("labels the row for %s mode", (mode) => {
		render(<DefaultGroupRow mode={mode} legacyRate={0} />);
		expect(screen.getByText(defaultRowLabel(mode))).toBeInTheDocument();
	});

	it("shows the active default with its rate and the mode note", () => {
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		expect(screen.getByText("Standard WI · 5.5%")).toBeInTheDocument();
		expect(screen.getByText(defaultRowNote("manual"))).toBeInTheDocument();
	});

	it("reads only active groups, so a stale inactive default is no default", () => {
		groups = [B];
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		expect(groupsHook).toHaveBeenCalledWith(false);
		expect(screen.getByText("No group")).toBeInTheDocument();
		expect(screen.queryByText(defaultRowNote("manual"))).toBeNull();
	});

	it.each([
		["auto", 0.065, /organization rate of 6\.5%/],
		["auto", 0, /documents get no tax/],
		["manual", 0, /aren't taxed/],
	] as const)("%s mode at %s warns when there is no default", (mode, rate, text) => {
		groups = [B];
		render(<DefaultGroupRow mode={mode} legacyRate={rate} />);
		expect(screen.getByText(text)).toBeInTheDocument();
	});

	it("picking a group makes it the default", async () => {
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.change(picker(), { target: { value: "B" } });
		await waitFor(() =>
			expect(update.mutateAsync).toHaveBeenCalledWith({ id: "B", data: { is_default: true } }),
		);
		await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
	});

	it("picking No default group clears the current default", async () => {
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.change(picker(), { target: { value: "" } });
		await waitFor(() =>
			expect(update.mutateAsync).toHaveBeenCalledWith({ id: "A", data: { is_default: false } }),
		);
	});

	it("picking the current default just closes the picker", () => {
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.change(picker(), { target: { value: "A" } });
		expect(update.mutateAsync).not.toHaveBeenCalled();
		expect(screen.queryByRole("combobox")).toBeNull();
	});

	it("a failed save keeps the picker open with the error", async () => {
		update.mutateAsync.mockRejectedValueOnce(new Error("boom"));
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.change(picker(), { target: { value: "B" } });
		expect(await screen.findByText("boom")).toBeInTheDocument();
		expect(picker()).toBeInTheDocument();
	});

	it("shows the picked group while the save is in flight", async () => {
		update.mutateAsync.mockReturnValueOnce(new Promise(() => {}));
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.change(picker(), { target: { value: "B" } });
		await waitFor(() => expect(update.mutateAsync).toHaveBeenCalled());
		expect(picker()).toHaveValue("B");
	});

	it("snaps back to the server value after a failed save", async () => {
		update.mutateAsync.mockRejectedValueOnce(new Error("boom"));
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.change(picker(), { target: { value: "B" } });
		await screen.findByText("boom");
		expect(picker()).toHaveValue("A");
	});

	it("moves focus into the picker on open and back to Change on close", () => {
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		expect(picker()).toHaveFocus();
		fireEvent.keyDown(picker(), { key: "Escape" });
		expect(screen.getByRole("button", { name: "Change" })).toHaveFocus();
	});

	it("returns focus to Change after a successful save", async () => {
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.change(picker(), { target: { value: "B" } });
		await waitFor(() => expect(screen.getByRole("button", { name: "Change" })).toHaveFocus());
	});

	it("Cancel closes the picker", () => {
		render(<DefaultGroupRow mode="manual" legacyRate={0} />);
		openPicker();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.getByText("Standard WI · 5.5%")).toBeInTheDocument();
	});
});
