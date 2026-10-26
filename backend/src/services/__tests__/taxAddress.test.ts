import { describe, it, expect } from "vitest";
import {
	addressLookupTarget,
	addressState,
	firstOfNextMonthUTC,
	invoiceServiceLocation,
	normalizeAddress,
	readCoords,
} from "../tax/address.js";
import {
	canonicalComponents,
	compositionHash,
	isPlausibleRateSet,
	rateSetLabel,
	rateSetToTaxGroupConfig,
	totalRate,
	type RateComponent,
	type RateSetView,
} from "../tax/rateSet.js";
import { calculateDocumentTax } from "../taxEngine.js";

describe("normalizeAddress / addressLookupTarget", () => {
	it("gives the seed format and the Mapbox format the same key", () => {
		const a = addressLookupTarget("2842 Main St, La Crosse, WI 54601", null);
		const b = addressLookupTarget("2842  Main St, La Crosse, Wisconsin 54601, United States", null);
		expect(a?.normalized).toBe("2842 MAIN ST, LA CROSSE, WI 54601");
		expect(a?.key).toBe(b?.key);
		expect(a?.input).toEqual({ address: "2842 MAIN ST, LA CROSSE, WI 54601" });
	});

	it("keys a different street differently", () => {
		expect(addressLookupTarget("2844 Main St, La Crosse, WI 54601", null)?.key).not.toBe(
			addressLookupTarget("2842 Main St, La Crosse, WI 54601", null)?.key,
		);
	});

	it("falls back to coords rounded to 5 decimals when the address does not parse", () => {
		const a = addressLookupTarget("Lot 4 behind the feed mill", { lat: 43.073051, lon: -89.401234 });
		const b = addressLookupTarget("Lot 4 behind the feed mill", { lat: 43.073054, lng: -89.401231 });
		const c = addressLookupTarget("Lot 4 behind the feed mill", { lat: 43.07306, lon: -89.401234 });
		expect(a?.input).toEqual({ lat: 43.07305, lng: -89.40123 });
		expect(a?.normalized).toBe("43.07305,-89.40123");
		expect(a?.key).toBe(b?.key);
		expect(a?.key).not.toBe(c?.key);
	});

	it("returns null with neither a parseable address nor coords", () => {
		expect(addressLookupTarget("", null)).toBeNull();
		expect(addressLookupTarget("somewhere", { lat: "", lon: null })).toBeNull();
		expect(normalizeAddress(undefined)).toBeNull();
	});

	it("reads string coords and rejects out-of-range ones", () => {
		expect(readCoords({ lat: "43.1", lon: "-89" })).toEqual({ lat: 43.1, lng: -89 });
		expect(readCoords({ lat: 91, lon: 0 })).toBeNull();
	});

	it("reads the state from either address format, else null", () => {
		expect(addressState("2842 Main St, La Crosse, WI 54601")).toBe("WI");
		expect(addressState("2842 Main St, La Crosse, Wisconsin 54601, United States")).toBe("WI");
		expect(addressState("Lot 4 behind the feed mill")).toBeNull();
		expect(addressState(null)).toBeNull();
	});
});

describe("invoiceServiceLocation", () => {
	const client = { address: "1 Client Way, Onalaska, WI 54650", coords: { lat: 43.88, lon: -91.23 } };

	it("uses the job's address and the job's coords when the job has an address", () => {
		const job = { address: "200 Martin Luther King Jr Blvd, Madison, WI 53703", coords: { lat: 43.07, lon: -89.38 } };
		expect(invoiceServiceLocation(job, client)).toEqual(job);
	});

	it("takes address and coords together from the client when the job's address is blank", () => {
		const job = { address: "   ", coords: { lat: 43.07, lon: -89.38 } };
		expect(invoiceServiceLocation(job, client)).toEqual(client);
		expect(invoiceServiceLocation({ address: null, coords: job.coords }, client)).toEqual(client);
	});

	it("uses the client when there is no linked job", () => {
		expect(invoiceServiceLocation(undefined, client)).toEqual(client);
	});
});

describe("firstOfNextMonthUTC", () => {
	it("rolls the year over in December", () => {
		expect(firstOfNextMonthUTC(new Date("2026-12-31T23:59:00Z")).toISOString()).toBe(
			"2027-01-01T00:00:00.000Z",
		);
	});
	it("moves the 1st itself to the next month", () => {
		expect(firstOfNextMonthUTC(new Date("2026-10-01T00:00:00Z")).toISOString()).toBe(
			"2026-11-01T00:00:00.000Z",
		);
	});
});

const WI: RateComponent[] = [
	{ jurisdiction_type: "county", jurisdiction_name: "DANE", jurisdiction_code: "025", rate: 0.005 },
	{ jurisdiction_type: "state", jurisdiction_name: "WI", jurisdiction_code: "55", rate: 0.05 },
];

describe("rate sets", () => {
	it("hashes independently of component order", () => {
		expect(compositionHash("WI", WI)).toBe(compositionHash("WI", [...WI].reverse()));
	});

	it("hashes a different rate, name or state differently", () => {
		const base = compositionHash("WI", WI);
		expect(compositionHash("WI", [WI[0], { ...WI[1], rate: 0.051 }])).not.toBe(base);
		expect(compositionHash("WI", [{ ...WI[0], jurisdiction_name: "ROCK" }, WI[1]])).not.toBe(base);
		expect(compositionHash("MN", WI)).not.toBe(base);
	});

	it("orders components by code unit, not by locale", () => {
		const district = (name: string): RateComponent => ({
			jurisdiction_type: "district",
			jurisdiction_name: name,
			jurisdiction_code: null,
			rate: 0.001,
		});
		const sorted = canonicalComponents([district("b"), district("C")]);
		expect(sorted.map((c) => c.jurisdiction_name)).toEqual(["C", "b"]);
	});

	it("sums to six decimal places", () => {
		expect(totalRate([...WI, { jurisdiction_type: "district", jurisdiction_name: "Local District: 37", jurisdiction_code: null, rate: 0.00125 }])).toBe(0.05625);
	});

	it("bounds the combined rate to [0, 0.15] and rejects negative components", () => {
		expect(isPlausibleRateSet([])).toBe(true);
		expect(isPlausibleRateSet([{ ...WI[1], rate: 0.15 }])).toBe(true);
		expect(isPlausibleRateSet([{ ...WI[1], rate: 0.1500001 }])).toBe(false);
		expect(isPlausibleRateSet([{ ...WI[1], rate: 0.06 }, { ...WI[0], rate: -0.01 }])).toBe(false);
		expect(isPlausibleRateSet([{ ...WI[1], rate: Number.NaN }])).toBe(false);
	});

	const view: RateSetView = {
		id: "set-1",
		state_code: "WI",
		total_rate: 0.055,
		components: [
			{ id: "c1", ...WI[1] },
			{ id: "c2", ...WI[0] },
		],
	};

	it("labels by city, else county, else state", () => {
		expect(rateSetLabel(view)).toBe("Dane, WI (auto)");
		expect(
			rateSetLabel({
				...view,
				components: [...view.components, { id: "c3", jurisdiction_type: "city", jurisdiction_name: "MADISON", jurisdiction_code: null, rate: 0 }],
			}),
		).toBe("Madison, WI (auto)");
		expect(rateSetLabel({ ...view, components: [view.components[0]] })).toBe("WI (auto)");
	});

	it("maps to a TaxGroupConfig the unchanged engine taxes like a hand-built group", () => {
		const group = rateSetToTaxGroupConfig(view);
		expect(group).toEqual({
			id: "set-1",
			name: "Dane, WI (auto)",
			rates: [
				{ id: "c1", name: "WI", rate: 0.05, jurisdiction: "state" },
				{ id: "c2", name: "DANE", rate: 0.005, jurisdiction: "county" },
			],
		});
		const out = calculateDocumentTax(
			{ line_items: [{ id: "l1", total_cents: 10000, taxable: true, tax_group: group }] },
			false,
		);
		expect(out.total_tax_cents).toBe(550);
	});
});
