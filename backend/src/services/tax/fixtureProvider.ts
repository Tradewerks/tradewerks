// backend/src/services/tax/fixtureProvider.ts
import { addressState } from "./address.js";
import type { RateComponent } from "./rateSet.js";
import type { ProviderResult, TaxRateProvider } from "./provider.js";

/**
 * Keyless and offline, so the whole resolve path can be exercised in dev and tests without a
 * vendor account. The rates are MADE UP (round numbers, "Fixture County") so nobody mistakes
 * them for real jurisdiction data; IL and TX carry the "O" flag so its capture can be seen.
 */
const FIXTURE: Record<string, { components: RateComponent[]; sourcing: "O" | "D" }> = {
	WI: {
		sourcing: "D",
		components: [
			{
				jurisdiction_type: "state",
				jurisdiction_name: "WI",
				jurisdiction_code: "FX-WI",
				rate: 0.05,
			},
			{
				jurisdiction_type: "county",
				jurisdiction_name: "Fixture County",
				jurisdiction_code: "FX-001",
				rate: 0.005,
			},
		],
	},
	IL: {
		sourcing: "O",
		components: [
			{
				jurisdiction_type: "state",
				jurisdiction_name: "IL",
				jurisdiction_code: "FX-IL",
				rate: 0.0625,
			},
			{
				jurisdiction_type: "county",
				jurisdiction_name: "Fixture County",
				jurisdiction_code: "FX-002",
				rate: 0.0175,
			},
		],
	},
	TX: {
		sourcing: "O",
		components: [
			{
				jurisdiction_type: "state",
				jurisdiction_name: "TX",
				jurisdiction_code: "FX-TX",
				rate: 0.0625,
			},
			{
				jurisdiction_type: "city",
				jurisdiction_name: "Fixture City",
				jurisdiction_code: "FX-003",
				rate: 0.02,
			},
		],
	},
};

const ambiguous = (reason: string): ProviderResult => ({ status: "ambiguous", reason });

export const fixtureTaxRateProvider: TaxRateProvider = {
	name: "fixture",
	async lookup(input) {
		if (!("address" in input))
			return ambiguous("The fixture provider needs a street address");
		if (/\bP\.?\s*O\.?\s*BOX\b/i.test(input.address))
			return ambiguous("A PO box has no service location");
		const state = addressState(input.address);
		if (!state) return ambiguous("The fixture provider could not read the state");
		const entry = FIXTURE[state] ?? {
			sourcing: "D" as const,
			components: [
				{
					jurisdiction_type: "state" as const,
					jurisdiction_name: state,
					jurisdiction_code: `FX-${state}`,
					rate: 0.05,
				},
			],
		};
		return {
			status: "ok",
			state_code: state,
			components: entry.components,
			sourcing: entry.sourcing,
			lat: null,
			lng: null,
		};
	},
};
