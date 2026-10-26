import { describe, it, expect } from "vitest";
import { scaleCreditTaxToAdopted } from "../tax/adoptedCreditTax.js";

describe("scaleCreditTaxToAdopted", () => {
	it("scales a half credit", () => {
		expect(
			scaleCreditTaxToAdopted({
				adjTaxCents: -500,
				origOursCents: 1000,
				origQbCents: 0,
				priorAdjTaxCents: 0,
				isFullCredit: false,
			}),
		).toBe(0);
		expect(
			scaleCreditTaxToAdopted({
				adjTaxCents: -2203,
				origOursCents: 4405,
				origQbCents: 4542,
				priorAdjTaxCents: 0,
				isFullCredit: false,
			}),
			// -2203 × 4542 / 4405 = -2271.5155…, half-up on the magnitude.
		).toBe(-2272);
	});

	it("full credit lands exactly on QB tax", () => {
		const first = scaleCreditTaxToAdopted({
			adjTaxCents: -2203,
			origOursCents: 4405,
			origQbCents: 4542,
			priorAdjTaxCents: 0,
			isFullCredit: false,
		});
		const rest = scaleCreditTaxToAdopted({
			adjTaxCents: -(4405 - 2203),
			origOursCents: 4405,
			origQbCents: 4542,
			priorAdjTaxCents: first,
			isFullCredit: true,
		});
		expect(first + rest).toBe(-4542);
	});
});
