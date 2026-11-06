// backend/src/services/tax/address.ts
import { createHash } from "node:crypto";

export type TaxLookupInput = { address: string } | { lat: number; lng: number };

export interface AddressLookupTarget {
	key: string;
	normalized: string;
	input: TaxLookupInput;
	lat: number | null;
	lng: number | null;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function readCoords(coords: unknown): { lat: number; lng: number } | null {
	if (!coords || typeof coords !== "object") return null;
	const c = coords as Record<string, unknown>;
	const rawLng = c.lng ?? c.lon;
	// Number(null) and Number("") are 0 — a bogus point in the Gulf of Guinea.
	if (c.lat == null || c.lat === "" || rawLng == null || rawLng === "") return null;
	const lat = Number(c.lat);
	const lng = Number(rawLng);
	if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
	if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
	return { lat, lng };
}

const STATE_CODES: Record<string, string> = {
	alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
	colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
	florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
	iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
	massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
	montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
	"new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND",
	ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
	"south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
	vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI",
	wyoming: "WY", "puerto rico": "PR", guam: "GU", "u.s. virgin islands": "VI",
};
const KNOWN_CODES = new Set(Object.values(STATE_CODES));

export function stateCode(token: string): string | null {
	const t = token.trim();
	if (/^[A-Za-z]{2}$/.test(t) && KNOWN_CODES.has(t.toUpperCase())) return t.toUpperCase();
	return STATE_CODES[t.toLowerCase()] ?? null;
}

export interface USAddressParts {
	line1: string;
	city: string;
	state: string;
	zip: string;
}

/**
 * Addresses are stored as one string ("street, City, ST ZIP", or Mapbox's
 * "street, City, State ZIP, United States"); null when it does not split that way.
 */
export function splitUSAddress(address: string | null | undefined): USAddressParts | null {
	const raw = address?.trim();
	if (!raw) return null;
	const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
	if (parts.length && /^(usa?|united states( of america)?)$/i.test(parts[parts.length - 1])) {
		parts.pop();
	}
	if (parts.length < 3) return null;
	const m = parts[parts.length - 1].match(/^([A-Za-z .]+?)\s+(\d{5}(?:-\d{4})?)$/);
	const state = m ? stateCode(m[1]) : null;
	if (!m || !state) return null;
	return {
		line1: parts.slice(0, -2).join(", "),
		city: parts[parts.length - 2],
		state,
		zip: m[2],
	};
}

export function addressState(address: string | null | undefined): string | null {
	return splitUSAddress(address)?.state ?? null;
}

/** "STREET, CITY, ST ZIP" upper-cased, or null when the string is not a parseable US address. */
export function normalizeAddress(address: string | null | undefined): string | null {
	const collapsed = address?.replace(/\s+/g, " ").trim();
	const parsed = splitUSAddress(collapsed);
	if (!parsed) return null;
	return `${parsed.line1}, ${parsed.city}, ${parsed.state} ${parsed.zip}`.toUpperCase();
}

/**
 * The address is preferred: it is what the provider geocodes best and what a dispatcher can
 * read back. Coords are the fallback for strings that do not parse ("Lot 4 behind the mill").
 */
export function addressLookupTarget(
	address: string | null | undefined,
	coords: unknown
): AddressLookupTarget | null {
	const ll = readCoords(coords);
	const normalized = normalizeAddress(address);
	if (normalized) {
		return {
			key: sha256(`addr:${normalized}`),
			normalized,
			input: { address: normalized },
			lat: ll?.lat ?? null,
			lng: ll?.lng ?? null,
		};
	}
	if (!ll) return null;
	const lat = Number(ll.lat.toFixed(5));
	const lng = Number(ll.lng.toFixed(5));
	const geo = `${lat.toFixed(5)},${lng.toFixed(5)}`;
	return { key: sha256(`geo:${geo}`), normalized: geo, input: { lat, lng }, lat, lng };
}

interface Located {
	address: string | null | undefined;
	coords: unknown;
}

/**
 * Where an invoice's work happened: the first linked job (callers order by created_at asc) when
 * it has an address, else the client. Address and coords always come from the same record, and
 * the tax lookup and the QuickBooks ShipAddr must agree on it.
 */
export function invoiceServiceLocation(
	job: Located | null | undefined,
	client: Located
): { address: string | null; coords: unknown } {
	const from = job?.address?.trim() ? job : client;
	return { address: from.address ?? null, coords: from.coords };
}

/** Ziptax publishes monthly (plus mid-month adjustments, handled by the 7-day lock rule). */
export function firstOfNextMonthUTC(now: Date): Date {
	return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}
