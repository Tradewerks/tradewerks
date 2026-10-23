import { describe, expect, it } from "vitest";
import { formatDocRatePercent, rateToPercentInput } from "../formatTax";

describe("formatDocRatePercent", () => {
	it("rounds a 6-dp resolved rate to at most 3 dp", () => {
		expect(formatDocRatePercent(0.054948)).toBe("5.495%");
		expect(formatDocRatePercent("0.055000")).toBe("5.5%");
		expect(formatDocRatePercent(0.1)).toBe("10%");
		expect(formatDocRatePercent(0)).toBe("0%");
	});
});

describe("rateToPercentInput", () => {
	it("converts to percent and drops float noise", () => {
		expect(rateToPercentInput("0.054948")).toBe(5.495);
		expect(rateToPercentInput(0.07)).toBe(7);
		expect(rateToPercentInput(null)).toBe(0);
	});
});
