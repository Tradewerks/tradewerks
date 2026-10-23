// backend/src/services/tax/rateSet.ts
import { createHash } from "node:crypto";
import type { TaxGroupConfig } from "../taxEngine.js";

export const JURISDICTION_TYPES = ["state", "county", "city", "district"] as const;
export type JurisdictionType = (typeof JURISDICTION_TYPES)[number];

export interface RateComponent {
	jurisdiction_type: JurisdictionType;
	jurisdiction_name: string;
	jurisdiction_code: string | null;
	rate: number;
}

export interface RateSetView {
	id: string;
	state_code: string;
	total_rate: number;
	components: (RateComponent & { id: string })[];
}

export const MAX_PLAUSIBLE_RATE = 0.15;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const typeOrder = (t: JurisdictionType) => JURISDICTION_TYPES.indexOf(t);
// Not localeCompare: the order feeds composition_hash, which must not vary with the host locale.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalComponents(components: RateComponent[]): RateComponent[] {
	return components
		.map((c) => ({
			...c,
			jurisdiction_name: c.jurisdiction_name.trim(),
			rate: round6(c.rate),
		}))
		.sort(
			(a, b) =>
				typeOrder(a.jurisdiction_type) - typeOrder(b.jurisdiction_type) ||
				byCodeUnit(a.jurisdiction_name, b.jurisdiction_name) ||
				byCodeUnit(a.jurisdiction_code ?? "", b.jurisdiction_code ?? "")
		);
}

export function totalRate(components: RateComponent[]): number {
	return round6(components.reduce((sum, c) => sum + c.rate, 0));
}

export function isPlausibleRateSet(components: RateComponent[]): boolean {
	if (components.some((c) => !Number.isFinite(c.rate) || c.rate < 0)) return false;
	// Unrounded: totalRate's 6-dp rounding would pass 0.1500001 as 0.15.
	const total = components.reduce((sum, c) => sum + c.rate, 0);
	return total >= 0 && total <= MAX_PLAUSIBLE_RATE;
}

/** Name is part of identity: Ziptax often omits district codes ("Local District: 37"). */
export function compositionHash(stateCode: string, components: RateComponent[]): string {
	const tuples = canonicalComponents(components).map((c) =>
		[
			c.jurisdiction_type,
			c.jurisdiction_code ?? "",
			c.jurisdiction_name.toUpperCase(),
			c.rate.toFixed(6),
		].join("|")
	);
	return createHash("sha256")
		.update([stateCode.toUpperCase(), ...tuples].join("\n"))
		.digest("hex");
}

export const titleCase = (s: string) =>
	s === s.toUpperCase() ? s.toLowerCase().replace(/\b\w/g, (ch) => ch.toUpperCase()) : s;

export function rateSetLabel(set: Pick<RateSetView, "state_code" | "components">): string {
	const city = set.components.find((c) => c.jurisdiction_type === "city");
	const county = set.components.find((c) => c.jurisdiction_type === "county");
	const place = city?.jurisdiction_name || county?.jurisdiction_name;
	return place ? `${titleCase(place)}, ${set.state_code} (auto)` : `${set.state_code} (auto)`;
}

export function rateSetToTaxGroupConfig(set: RateSetView): TaxGroupConfig {
	return {
		id: set.id,
		name: rateSetLabel(set),
		rates: set.components.map((c) => ({
			id: c.id,
			name: c.jurisdiction_name,
			rate: c.rate,
			jurisdiction: c.jurisdiction_type,
		})),
	};
}
