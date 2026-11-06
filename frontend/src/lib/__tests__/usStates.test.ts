import { describe, expect, it } from "vitest";
import { NO_SALES_TAX_STATES, US_STATES, stateName } from "../usStates";

describe("US_STATES", () => {
	it("contains the 50 states plus DC, PR, GU and VI", () => {
		expect(US_STATES.length).toBe(54);
	});

	it("has unique codes", () => {
		const codes = US_STATES.map((s) => s.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	it("lists names in sorted order", () => {
		const names = US_STATES.map((s) => s.name);
		expect(names).toEqual([...names].sort());
	});
});

describe("stateName", () => {
	it("returns the name for a known code", () => {
		expect(stateName("WI")).toBe("Wisconsin");
		expect(stateName("DC")).toBe("District of Columbia");
	});

	it("returns the code itself when unknown", () => {
		expect(stateName("ZZ")).toBe("ZZ");
	});
});

describe("NO_SALES_TAX_STATES", () => {
	it("contains DE, MT, NH and OR", () => {
		for (const code of ["DE", "MT", "NH", "OR"]) {
			expect(NO_SALES_TAX_STATES.has(code)).toBe(true);
		}
		expect(NO_SALES_TAX_STATES.size).toBe(4);
	});

	it("keeps AK (it has local tax)", () => {
		expect(NO_SALES_TAX_STATES.has("AK")).toBe(false);
	});
});
