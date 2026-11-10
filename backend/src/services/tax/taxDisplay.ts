import { stateCode } from "./address.js";
import { roundHalfUpSymmetric, type TaxRounding } from "./rounding.js";
import { roundingFor, type AnyTaxSnapshot } from "./snapshot.js";

// Backend twin of frontend/src/lib/taxBreakdown.ts: both must name jurisdictions identically.

// Must match frontend/src/lib/usStates.ts
export const US_STATE_NAMES: Record<string, string> = {
	AL: "Alabama",
	AK: "Alaska",
	AZ: "Arizona",
	AR: "Arkansas",
	CA: "California",
	CO: "Colorado",
	CT: "Connecticut",
	DE: "Delaware",
	DC: "District of Columbia",
	FL: "Florida",
	GA: "Georgia",
	GU: "Guam",
	HI: "Hawaii",
	ID: "Idaho",
	IL: "Illinois",
	IN: "Indiana",
	IA: "Iowa",
	KS: "Kansas",
	KY: "Kentucky",
	LA: "Louisiana",
	ME: "Maine",
	MD: "Maryland",
	MA: "Massachusetts",
	MI: "Michigan",
	MN: "Minnesota",
	MS: "Mississippi",
	MO: "Missouri",
	MT: "Montana",
	NE: "Nebraska",
	NV: "Nevada",
	NH: "New Hampshire",
	NJ: "New Jersey",
	NM: "New Mexico",
	NY: "New York",
	NC: "North Carolina",
	ND: "North Dakota",
	OH: "Ohio",
	OK: "Oklahoma",
	OR: "Oregon",
	PA: "Pennsylvania",
	PR: "Puerto Rico",
	RI: "Rhode Island",
	SC: "South Carolina",
	SD: "South Dakota",
	TN: "Tennessee",
	TX: "Texas",
	VI: "U.S. Virgin Islands",
	UT: "Utah",
	VT: "Vermont",
	VA: "Virginia",
	WA: "Washington",
	WV: "West Virginia",
	WI: "Wisconsin",
	WY: "Wyoming",
};

export interface CollapsedRate {
	id: string;
	name: string;
	rate: number;
	amountCents: number;
}

const RANK: Record<string, number> = { state: 0, county: 1, city: 2, district: 3 };
const rank = (t: string | undefined) => (t != null && t in RANK ? RANK[t] : 4);

const titleCase = (s: string) =>
	s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
// Provider names arrive upper-cased ("LA CROSSE"); mixed-case names are already deliberate.
const fixCase = (s: string) => (s === s.toUpperCase() ? titleCase(s) : s);

/** Reader-facing name for a provider-looked-up jurisdiction: "Wisconsin state", "La Crosse County". */
export function jurisdictionLabel(rate: { name: string; jurisdiction_type?: string }): string {
	const { name, jurisdiction_type: type } = rate;
	const has = (word: string) => name.toLowerCase().includes(word);
	switch (type) {
		case "state": {
			const code = /^[A-Za-z]{2}$/.test(name) ? stateCode(name) : null;
			return `${code ? US_STATE_NAMES[code] ?? name : titleCase(name)} state`;
		}
		case "county":
			return has("county") ? fixCase(name) : `${fixCase(name)} County`;
		case "district":
			return has("district") ? fixCase(name) : `${fixCase(name)} district`;
		case "city":
			return `${titleCase(name)} city`;
		default:
			return titleCase(name);
	}
}

/**
 * Per-rate cents of a saved snapshot group, matching the frontend lib/taxRounding.ts and the
 * reports tax-liability split. Half-up groups were taxed one rate at a time on this base; line_floor
 * groups floor each rate and put the remainder on the last so they sum to the stored group total.
 */
export function snapshotRateCents(
	group: {
		rates: readonly { rate: number }[];
		taxable_amount_cents: number;
		tax_amount_cents: number;
	},
	rounding: TaxRounding
): number[] {
	const base = group.taxable_amount_cents;
	const perRate = group.rates.map((r) =>
		rounding === "jurisdiction_half_up"
			? roundHalfUpSymmetric(base * r.rate)
			: Math.floor(base * r.rate)
	);
	if (perRate.length > 0) {
		perRate[perRate.length - 1] += group.tax_amount_cents - perRate.reduce((s, n) => s + n, 0);
	}
	return perRate;
}

type AnyRate = { id: string; name: string; rate: number; jurisdiction_type?: string };

/**
 * A snapshot's tax per rate: deduplicated by rate id across groups, amounts summed, ordered
 * state, county, city, district, untyped. Only the address group's rates are renamed.
 */
export function collapseSnapshotRates(snapshot: AnyTaxSnapshot | null): CollapsedRate[] {
	if (!snapshot) return [];
	const byId = new Map<string, CollapsedRate & { type?: string }>();
	const rounding = roundingFor(snapshot);
	const addressGroupId = snapshot.version === 2 ? (snapshot.rate_set_id ?? null) : null;
	for (const group of snapshot.groups ?? []) {
		const isAddressGroup = addressGroupId != null && group.id === addressGroupId;
		const rates = (group.rates ?? []) as AnyRate[];
		const rateCents = snapshotRateCents(
			{
				rates,
				taxable_amount_cents: group.taxable_amount_cents ?? 0,
				tax_amount_cents: group.tax_amount_cents ?? 0,
			},
			rounding
		);
		for (const [idx, rate] of rates.entries()) {
			const existing = byId.get(rate.id);
			if (existing) existing.amountCents += rateCents[idx];
			else
				byId.set(rate.id, {
					id: rate.id,
					name: isAddressGroup ? jurisdictionLabel(rate) : rate.name,
					rate: rate.rate,
					type: rate.jurisdiction_type,
					amountCents: rateCents[idx],
				});
		}
	}
	return [...byId.values()]
		.sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name))
		.map(({ id, name, rate, amountCents }) => ({ id, name, rate, amountCents }));
}

export type PdfTaxRow = CollapsedRate & { showRate: boolean };

const AUTO_SUFFIX = " (auto)";

/**
 * PDF tax rows: one per rate. A snapshot whose groups carry no rates (legacy) falls back to one
 * row per group so its tax never disappears; like the old template, it prints no "(0%)".
 */
export function pdfTaxRows(snapshot: AnyTaxSnapshot): PdfTaxRow[] {
	const rows = collapseSnapshotRates(snapshot);
	if (rows.length > 0) return rows.map((row) => ({ ...row, showRate: true }));
	return (snapshot.groups ?? []).map((g) => {
		const rate = (g.rates ?? []).reduce((sum, r) => sum + r.rate, 0);
		return {
			id: g.id,
			name: g.name.endsWith(AUTO_SUFFIX) ? g.name.slice(0, -AUTO_SUFFIX.length) : g.name,
			rate,
			amountCents: g.tax_amount_cents ?? 0,
			showRate: rate > 0,
		};
	});
}

const usd = (cents: number) =>
	`$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * "Taxable lines $420.00 · $190.00 not taxed": the subtotal split by line taxability, so it
 * reconciles with the line amounts. Pre-discount on purpose: the per-group base is post-discount.
 */
export function taxBasisLine(snapshot: AnyTaxSnapshot | null): string | null {
	if (!snapshot || snapshot.client_exempt || snapshot.subtotal_cents == null) return null;
	if (!(snapshot.groups ?? []).some((g) => (g.tax_amount_cents ?? 0) !== 0)) return null;
	const excludedCents = snapshot.non_taxable_amount_cents ?? 0;
	const taxable = `Taxable lines ${usd(snapshot.subtotal_cents - excludedCents)}`;
	return excludedCents !== 0 ? `${taxable} · ${usd(excludedCents)} not taxed` : taxable;
}
