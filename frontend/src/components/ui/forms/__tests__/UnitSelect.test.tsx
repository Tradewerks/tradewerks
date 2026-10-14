import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import UnitSelect from "../UnitSelect";
import { UNIT_GROUPS, UNITS, type UnitCode } from "../../../../lib/units";

const state = vi.hoisted(() => ({ org: undefined as undefined | { measurement_system: string } }));
vi.mock("../../../../hooks/useOrg", () => ({
	useOrgSettings: () => ({ data: state.org }),
}));

const lengthLabel = UNIT_GROUPS.find((g) => g.kind === "length")!.label;
const lengthOptions = () =>
	within(screen.getByRole("group", { name: lengthLabel }))
		.getAllByRole("option")
		.map((o) => (o as HTMLOptionElement).value);
const allOptions = () => screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value);

beforeEach(() => {
	state.org = undefined;
});

describe("UnitSelect ordering", () => {
	test("metric org leads length with metric units, hides nothing", () => {
		state.org = { measurement_system: "metric" };
		render(<UnitSelect value={"each" as UnitCode} onChange={vi.fn()} />);
		expect(lengthOptions()).toEqual(["m", "cm", "mm", "ft", "in", "yd"]);
		expect(allOptions().sort()).toEqual(Object.keys(UNITS).sort());
	});

	test("imperial org leads length with imperial units", () => {
		state.org = { measurement_system: "imperial" };
		render(<UnitSelect value={"each" as UnitCode} onChange={vi.fn()} />);
		expect(lengthOptions()).toEqual(["ft", "in", "yd", "m", "cm", "mm"]);
	});

	test("org not loaded yet falls back to catalog order with every unit", () => {
		render(<UnitSelect value={"each" as UnitCode} onChange={vi.fn()} />);
		expect(lengthOptions()).toEqual(
			UNIT_GROUPS.find((g) => g.kind === "length")!.codes
		);
		expect(allOptions().sort()).toEqual(Object.keys(UNITS).sort());
	});
});
