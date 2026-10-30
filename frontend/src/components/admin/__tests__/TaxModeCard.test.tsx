import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { AutoSwitchPreview, TaxSettings } from "../../../api/taxSettings";

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
let previewData: AutoSwitchPreview | undefined;
let previewLoading = false;
let previewError: unknown = null;
const update = { mutate: vi.fn(), isPending: false, error: null as unknown };
const previewHook = vi.fn((enabled: boolean) => ({
	data: enabled ? previewData : undefined,
	isLoading: enabled && previewLoading,
	isError: enabled && previewError != null,
	error: enabled ? previewError : null,
}));
const toast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

vi.mock("../../../hooks/useTaxSettings", () => ({
	useTaxSettings: () => ({ data: settings, isLoading: false, error: null }),
	useAutoSwitchPreview: (enabled: boolean) => previewHook(enabled),
	useUpdateTaxSettings: () => update,
}));
vi.mock("../../ui/useToast", () => ({ useToast: () => toast }));

import TaxModeCard from "../TaxModeCard";

const preview = (over: Partial<AutoSwitchPreview> = {}): AutoSwitchPreview => ({
	default_group_lines: 0,
	quote_lines: 0,
	job_lines: 0,
	visit_lines: 0,
	invoice_lines: 0,
	default_group_drafts: 0,
	quote_drafts: 0,
	job_drafts: 0,
	visit_drafts: 0,
	invoice_drafts: 0,
	...over,
});

const renderCard = () =>
	render(
		<MemoryRouter>
			<TaxModeCard />
		</MemoryRouter>,
	);

beforeEach(() => {
	settings = base;
	previewData = undefined;
	previewLoading = false;
	previewError = null;
	update.mutate.mockReset();
	update.error = null;
	previewHook.mockClear();
	Object.values(toast).forEach((f) => f.mockReset());
});

describe("TaxModeCard", () => {
	it("manual: choosing automatic opens a dialog with the draft preview", () => {
		previewData = preview({
			default_group_drafts: 3,
			quote_drafts: 2,
			invoice_drafts: 1,
		});
		renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Automatic (address-based)" }));
		expect(screen.getByText(/3 draft documents \(2 quotes, 1 invoice\)/)).toBeInTheDocument();
		expect(previewHook).toHaveBeenLastCalledWith(true);
	});

	it("confirm stays disabled while the draft preview is counting", () => {
		previewLoading = true;
		renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Automatic (address-based)" }));
		expect(screen.getByText("Counting drafts…")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Turn on automatic tax" })).toBeDisabled();
	});

	it("a failed preview says so and keeps confirm disabled", () => {
		previewError = { isAxiosError: true, response: { status: 500, data: {} } };
		renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Automatic (address-based)" }));
		expect(screen.getByText("Couldn't count affected drafts.")).toBeInTheDocument();
		expect(screen.queryByText("Counting drafts…")).toBeNull();
		const confirm = screen.getByRole("button", { name: "Turn on automatic tax" });
		expect(confirm).toBeDisabled();
		fireEvent.click(confirm);
		expect(update.mutate).not.toHaveBeenCalled();
	});

	it("stored auto: never fetches the preview, shows chips, manual dialog has no counts", () => {
		settings = { ...base, tax_mode: "auto", effective_tax_mode: "auto" };
		renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Manual groups" }));
		expect(previewHook).not.toHaveBeenCalledWith(true);
		expect(screen.getByText("Wisconsin")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Switch to manual" })).toBeInTheDocument();
		expect(screen.queryByText(/will drop their default tax group|Counting drafts/)).toBeNull();
	});

	it("mode toggle can shrink and wrap instead of clipping at 390px", () => {
		renderCard();
		const group = screen.getByRole("group", { name: "Tax calculation mode" });
		expect(group).toHaveClass("min-w-0", "max-w-full", "flex-wrap");
		expect(group).not.toHaveClass("whitespace-nowrap");
	});

	it("not entitled: automatic is disabled and the plan note shows", () => {
		settings = { ...base, auto_entitled: false };
		renderCard();
		expect(screen.getByRole("button", { name: "Automatic (address-based)" })).toBeDisabled();
		expect(screen.getByText(/not included in your plan/i)).toBeInTheDocument();
	});

	it("stored auto but effective manual: explains the plan fallback", () => {
		settings = { ...base, tax_mode: "auto", effective_tax_mode: "manual" };
		renderCard();
		expect(screen.getByText(/off for your plan right now/i)).toBeInTheDocument();
	});

	it("QuickBooks pass-through: callout links to integrations and keeps auto enabled", () => {
		settings = { ...base, qb_passthrough_required: true };
		renderCard();
		expect(screen.getByText(/pass-through tax code/i)).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Set it in Integrations" }).getAttribute("href"),
		).toContain("tab=integrations");
		expect(screen.getByRole("button", { name: "Automatic (address-based)" })).toBeEnabled();
	});

	it("confirm sends tax_mode auto; a 409 surfaces the server message", () => {
		previewData = preview();
		const { rerender } = renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Automatic (address-based)" }));
		fireEvent.click(screen.getByRole("button", { name: "Turn on automatic tax" }));
		expect(update.mutate).toHaveBeenCalledWith({ tax_mode: "auto" }, expect.any(Object));

		update.error = Object.assign(new Error("Request failed with status code 409"), {
			isAxiosError: true,
			response: {
				status: 409,
				data: {
					error: {
						code: "CONFLICT",
						message:
							"Choose a QuickBooks pass-through tax code before turning on automated tax.",
					},
				},
			},
		});
		rerender(
			<MemoryRouter>
				<TaxModeCard />
			</MemoryRouter>,
		);
		expect(
			screen.getByText(
				"Choose a QuickBooks pass-through tax code before turning on automated tax.",
			),
		).toBeInTheDocument();
	});

	it("states picker: choosing Illinois appends it and saves", () => {
		settings = { ...base, tax_mode: "auto", effective_tax_mode: "auto" };
		renderCard();
		fireEvent.change(screen.getByRole("combobox", { name: "Add a state" }), {
			target: { value: "IL" },
		});
		expect(update.mutate).toHaveBeenCalledWith(
			{ tax_registered_states: ["WI", "IL"] },
			expect.any(Object),
		);
	});

	it("states picker hides registered and no-sales-tax states", () => {
		settings = { ...base, tax_mode: "auto", effective_tax_mode: "auto" };
		renderCard();
		expect(screen.queryByRole("option", { name: "Oregon (OR)" })).toBeNull();
		expect(screen.queryByRole("option", { name: "Wisconsin (WI)" })).toBeNull();
		expect(screen.getByRole("option", { name: "Illinois (IL)" })).toBeInTheDocument();
	});

	it("home state chip is tagged", () => {
		settings = {
			...base,
			tax_mode: "auto",
			effective_tax_mode: "auto",
			org_state: "WI",
		};
		renderCard();
		expect(screen.getByText("Wisconsin")).toBeInTheDocument();
		expect(screen.getByText("Business address")).toBeInTheDocument();
	});

	it("last state cannot be removed", () => {
		settings = { ...base, tax_mode: "auto", effective_tax_mode: "auto" };
		renderCard();
		expect(screen.getByRole("button", { name: "Remove WI" })).toBeDisabled();
	});

	it("no address, no states: picker still renders", () => {
		settings = {
			...base,
			tax_mode: "auto",
			effective_tax_mode: "auto",
			org_state: null,
			tax_registered_states: [],
		};
		renderCard();
		expect(screen.getByRole("combobox", { name: "Add a state" })).toBeInTheDocument();
		expect(screen.getByText("No states added yet.")).toBeInTheDocument();
	});

	it("registered states: Remove WI leaves the rest", () => {
		settings = {
			...base,
			tax_mode: "auto",
			effective_tax_mode: "auto",
			tax_registered_states: ["WI", "IL"],
		};
		renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Remove WI" }));
		expect(update.mutate).toHaveBeenCalledWith(
			{ tax_registered_states: ["IL"] },
			expect.any(Object),
		);
	});

	it("Remove moves focus to the picker and keeps it enabled while pending", () => {
		settings = {
			...base,
			tax_mode: "auto",
			effective_tax_mode: "auto",
			tax_registered_states: ["WI", "IL"],
		};
		const view = renderCard();
		fireEvent.click(screen.getByRole("button", { name: "Remove IL" }));
		// The mutation goes pending right after the click; the picker must survive that render.
		update.isPending = true;
		try {
			view.rerender(
				<MemoryRouter>
					<TaxModeCard />
				</MemoryRouter>,
			);
		} finally {
			update.isPending = false;
		}
		const picker = screen.getByRole("combobox", { name: "Add a state" });
		expect(picker).toBeEnabled();
		expect(picker).toHaveFocus();
	});
});
