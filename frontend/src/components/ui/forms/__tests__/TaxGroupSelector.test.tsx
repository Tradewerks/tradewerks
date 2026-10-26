import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import TaxGroupSelector from "../TaxGroupSelector";
import type { TaxGroup } from "../../../../types/tax";

const group = { id: "g1", name: "Local", rates: [], combined_rate: 0 } as unknown as TaxGroup;

function setup(props: Partial<React.ComponentProps<typeof TaxGroupSelector>> = {}) {
	const onChange = vi.fn();
	render(
		<TaxGroupSelector
			value={null}
			taxable={true}
			taxGroups={[group]}
			clientExempt={false}
			onChange={onChange}
			{...props}
		/>,
	);
	return onChange;
}

describe("TaxGroupSelector — autoMode", () => {
	test("taxable line with no group shows Auto (address) selected", () => {
		setup({ autoMode: true });
		expect(screen.getByRole("combobox")).toHaveDisplayValue("Auto (address)");
	});

	test("non-taxable line shows No Tax", () => {
		setup({ autoMode: true, taxable: false });
		expect(screen.getByRole("combobox")).toHaveDisplayValue("No Tax");
	});

	test("choosing No Tax emits (null, false)", async () => {
		const onChange = setup({ autoMode: true });
		await userEvent.selectOptions(screen.getByRole("combobox"), "No Tax");
		expect(onChange).toHaveBeenCalledWith(null, false);
	});

	test("choosing Auto (address) from a group emits (null, true)", async () => {
		const onChange = setup({ autoMode: true, value: "g1" });
		await userEvent.selectOptions(screen.getByRole("combobox"), "Auto (address)");
		expect(onChange).toHaveBeenCalledWith(null, true);
	});

	test("groups are listed under an Override optgroup and emit (id, true)", async () => {
		const onChange = setup({ autoMode: true });
		const og = screen.getByRole("group", { name: "Override" });
		expect(og).toContainElement(screen.getByRole("option", { name: "Local" }));
		await userEvent.selectOptions(screen.getByRole("combobox"), "g1");
		expect(onChange).toHaveBeenCalledWith("g1", true);
	});

	test("empty group list shows the disabled placeholder inside Override", () => {
		setup({ autoMode: true, taxGroups: [] });
		const og = screen.getByRole("group", { name: "Override" });
		expect(og).toContainElement(screen.getByRole("option", { name: "No tax groups configured" }));
	});
});

describe("TaxGroupSelector — manual mode (unchanged)", () => {
	test("taxable line with no group still shows No Tax and offers no Auto option", () => {
		setup();
		expect(screen.getByRole("combobox")).toHaveDisplayValue("No Tax");
		expect(screen.queryByRole("option", { name: "Auto (address)" })).toBeNull();
		expect(screen.queryByRole("group", { name: "Override" })).toBeNull();
	});

	test("taxable line with no group shows the org default group it will be saved at", () => {
		const def = { ...group, id: "gd", name: "County", is_default: true, is_active: true };
		setup({ taxGroups: [group, def] as TaxGroup[] });
		expect(screen.getByRole("combobox")).toHaveDisplayValue("County");
	});

	test("non-taxable line still shows No Tax when a default group exists", () => {
		const def = { ...group, id: "gd", name: "County", is_default: true, is_active: true };
		setup({ taxable: false, taxGroups: [group, def] as TaxGroup[] });
		expect(screen.getByRole("combobox")).toHaveDisplayValue("No Tax");
	});

	test("clientExempt renders Tax Exempt", () => {
		setup({ clientExempt: true, autoMode: true });
		expect(screen.getByText("Tax Exempt")).toBeInTheDocument();
		expect(screen.queryByRole("combobox")).toBeNull();
	});
});

describe("TaxGroupSelector — kept address rate", () => {
	const label = "Address rate · La Crosse, WI 5.5%";

	test("manual mode with a kept label shows it selected for an ungrouped taxable line", () => {
		setup({ keptRateLabel: label });
		expect(screen.getByRole("combobox")).toHaveDisplayValue(label);
	});

	test("picking a group emits (groupId, true)", async () => {
		const onChange = setup({ keptRateLabel: label });
		await userEvent.selectOptions(screen.getByRole("combobox"), "g1");
		expect(onChange).toHaveBeenCalledWith("g1", true);
	});

	test("picking the kept option emits (null, true)", async () => {
		const onChange = setup({ keptRateLabel: label, value: "g1" });
		await userEvent.selectOptions(screen.getByRole("combobox"), label);
		expect(onChange).toHaveBeenCalledWith(null, true);
	});
});
