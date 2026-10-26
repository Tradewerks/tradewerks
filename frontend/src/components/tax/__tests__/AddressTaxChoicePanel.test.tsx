import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AxiosError, type AxiosResponse } from "axios";
import AddressTaxChoicePanel from "../AddressTaxChoicePanel";
import {
	addressChoiceEstimates,
	addressMoved,
	addressTaxChoiceDetails,
	isAddressTaxChoiceError,
	lineGroupForChoice,
	type AddressTaxChoice,
} from "../addressTaxChoice";
import type { TaxGroup } from "../../../types/tax";

const group = (id: string, name: string, rates: number[], isDefault = false): TaxGroup => ({
	id,
	organization_id: "org",
	name,
	description: null,
	is_default: isDefault,
	is_active: true,
	rates: rates.map((rate, i) => ({
		id: `${id}-r${i}`,
		sort_order: i,
		tax_rate: {
			id: `${id}-t${i}`,
			organization_id: "org",
			name: `R${i}`,
			rate,
			description: null,
			jurisdiction: null,
			is_default: false,
			is_active: true,
		} as TaxGroup["rates"][number]["tax_rate"],
	})),
	combined_rate: rates.reduce((a, b) => a + b, 0),
	created_at: "",
	updated_at: "",
});

const WI = group("g-wi", "WI Standard", [0.05, 0.0325], true);
const IL = group("g-il", "IL Cook", [0.1025]);

const baseProps = {
	docNoun: "quote" as const,
	rateLabel: "La Crosse, WI",
	rate: 0.055,
	newAddress: "100 N State St, Chicago, IL",
	keepCents: 2310,
	defaultGroup: { id: WI.id, name: WI.name, rate: 0.0825 },
	defaultCents: 3465,
	taxGroups: [WI, IL],
	value: null,
	onChange: vi.fn(),
};

describe("AddressTaxChoicePanel", () => {
	it("asks the question with the exact copy and three options", () => {
		render(<AddressTaxChoicePanel {...baseProps} />);
		expect(
			screen.getByText(
				"This quote was taxed at the La Crosse, WI address rate (5.5%). The address is now 100 N State St, Chicago, IL. Which tax should it use?",
			),
		).toBeInTheDocument();
		const radios = screen.getAllByRole("radio");
		expect(radios).toHaveLength(3);
		expect(screen.getByText("Keep La Crosse, WI rate (5.5%)")).toBeInTheDocument();
		expect(
			screen.getByText("— use when the new address is in the same tax area."),
		).toBeInTheDocument();
		expect(screen.getByText("Use WI Standard (8.25%)")).toBeInTheDocument();
		expect(screen.getByText("— the default group.")).toBeInTheDocument();
		expect(screen.getByText("Pick a group…")).toBeInTheDocument();
		expect(screen.getByText("≈ $23.10")).toBeInTheDocument();
		expect(screen.getByText("≈ $34.65")).toBeInTheDocument();
	});

	it("selecting Keep answers keep", async () => {
		const onChange = vi.fn();
		render(<AddressTaxChoicePanel {...baseProps} onChange={onChange} />);
		await userEvent.click(screen.getByRole("radio", { name: /Keep La Crosse, WI rate/ }));
		expect(onChange).toHaveBeenCalledWith("keep");
	});

	it("selecting the default group answers default", async () => {
		const onChange = vi.fn();
		render(<AddressTaxChoicePanel {...baseProps} onChange={onChange} />);
		await userEvent.click(screen.getByRole("radio", { name: /Use WI Standard/ }));
		expect(onChange).toHaveBeenCalledWith("default");
	});

	it("Pick a group… clears the answer until a group is selected", async () => {
		const onChange = vi.fn();
		function Host() {
			const [value, setValue] = useState<AddressTaxChoice | null>("keep");
			return (
				<AddressTaxChoicePanel
					{...baseProps}
					value={value}
					onChange={(c) => {
						onChange(c);
						setValue(c);
					}}
				/>
			);
		}
		render(<Host />);
		expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("radio", { name: /Pick a group/ }));
		expect(onChange).toHaveBeenLastCalledWith(null);
		await userEvent.selectOptions(screen.getByRole("combobox"), "g-il");
		expect(onChange).toHaveBeenLastCalledWith({ group_id: "g-il" });
	});

	it("shows a picked group's estimate when given one", () => {
		render(
			<AddressTaxChoicePanel
				{...baseProps}
				value={{ group_id: "g-il" }}
				groupCents={(id) => (id === "g-il" ? 4305 : null)}
			/>,
		);
		expect(screen.getByRole("radio", { name: /Pick a group/ })).toBeChecked();
		expect(screen.getByText("≈ $43.05")).toBeInTheDocument();
	});

	it("omits the default option when there is no default group", () => {
		render(<AddressTaxChoicePanel {...baseProps} defaultGroup={null} defaultCents={null} />);
		expect(screen.getAllByRole("radio")).toHaveLength(2);
		expect(screen.queryByText(/the default group/)).not.toBeInTheDocument();
	});

	it("is a neutral choice, not a warning or an error", () => {
		const { container } = render(<AddressTaxChoicePanel {...baseProps} />);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(container.innerHTML).not.toMatch(/(text|bg|border)-(error|warning)/);
	});

	it("the client variant names the drafts and shows no dollar figures", () => {
		render(
			<AddressTaxChoicePanel
				{...baseProps}
				docNoun="client"
				keepCents={null}
				defaultCents={null}
				documents={[
					{ kind: "invoice", id: "i1", number: "INV-0021" },
					{ kind: "invoice", id: "i2", number: "INV-0023" },
				]}
			/>,
		);
		expect(
			screen.getByText(
				"This client's draft invoices were taxed at the La Crosse, WI address rate (5.5%). The address is now 100 N State St, Chicago, IL. Which tax should they use?",
			),
		).toBeInTheDocument();
		expect(screen.getByText(/INV-0021/)).toBeInTheDocument();
		expect(screen.getByText(/INV-0023/)).toBeInTheDocument();
		expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
	});
});

const refusal = (code = "ADDRESS_TAX_CHOICE_REQUIRED") =>
	new AxiosError("409", "ERR_BAD_REQUEST", undefined, undefined, {
		status: 409,
		data: {
			success: false,
			data: null,
			error: {
				code,
				message: "Choose",
				details: {
					rate_label: "La Crosse, WI",
					rate: 0.055,
					documents: [{ kind: "invoice", id: "i1", number: "INV-0021" }],
				},
			},
		},
	} as AxiosResponse);

describe("addressTaxChoice helpers", () => {
	it("recognises the refusal and reads its details", () => {
		expect(isAddressTaxChoiceError(refusal())).toBe(true);
		expect(isAddressTaxChoiceError(refusal("QB_TAX_ZERO"))).toBe(false);
		expect(isAddressTaxChoiceError(new Error("x"))).toBe(false);
		expect(addressTaxChoiceDetails(refusal())).toEqual({
			rate_label: "La Crosse, WI",
			rate: 0.055,
			documents: [{ kind: "invoice", id: "i1", number: "INV-0021" }],
		});
		expect(addressTaxChoiceDetails(refusal("OTHER"))).toBeNull();
	});

	it("treats a new address or a moved pin as a move, an emptied address as none", () => {
		const doc = { address: "1 Main St", coords: { lat: 1, lon: 2 } };
		expect(addressMoved({ address: "1 Main St", coords: doc.coords }, doc)).toBe(false);
		expect(addressMoved({ address: "2 Main St", coords: doc.coords }, doc)).toBe(true);
		expect(addressMoved({ address: "1 Main St", coords: { lat: 1, lon: 2 } }, doc)).toBe(
			false,
		);
		expect(addressMoved({ address: "1 Main St", coords: { lat: 1, lon: 3 } }, doc)).toBe(true);
		expect(addressMoved(undefined, doc)).toBe(false);
		expect(addressMoved({ address: "" }, doc)).toBe(false);
	});

	it("estimates each answer on the same per-line bases and rounding", () => {
		const est = addressChoiceEstimates({
			autoTaxableAmount: 420,
			lineBasesCents: [42000],
			keptEstimate: {
				rate: 0.055,
				rates: [0.05, 0.005],
				place: "La Crosse, WI",
				rounding: "jurisdiction_half_up",
			},
			rounding: "jurisdiction_half_up",
			taxGroups: [WI, IL],
		});
		expect(est.keepCents).toBe(2310);
		expect(est.defaultGroup).toEqual({ id: "g-wi", name: "WI Standard", rate: 0.0825 });
		expect(est.defaultCents).toBe(3465);
		expect(est.groupCents("g-il")).toBe(4305);
		expect(est.groupCents("nope")).toBeNull();
	});

	it("line_floor floors each line and rate", () => {
		const est = addressChoiceEstimates({
			autoTaxableAmount: 0.3,
			lineBasesCents: [15, 15],
			keptEstimate: null,
			rounding: "line_floor",
			taxGroups: [group("g", "G", [0.1], true)],
		});
		// 1.5c floors to 1c per line; on the 30c aggregate it would be 3c.
		expect(est.defaultCents).toBe(2);
		expect(est.keepCents).toBeNull();
	});

	it("stamps a picked group onto ungrouped taxable lines only", () => {
		const pick = { group_id: "g-il" };
		expect(lineGroupForChoice(pick, { taxable: true, tax_group_id: null })).toBe("g-il");
		expect(lineGroupForChoice(pick, { taxable: true, tax_group_id: "g-wi" })).toBe("g-wi");
		expect(lineGroupForChoice(pick, { taxable: false, tax_group_id: null })).toBeNull();
		expect(lineGroupForChoice("keep", { taxable: true, tax_group_id: null })).toBeNull();
		expect(lineGroupForChoice("default", { taxable: true, tax_group_id: null })).toBeNull();
	});
});
