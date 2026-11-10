/**
 * The Ziptax payloads here are FABRICATED in the documented v60 shape; no live account was
 * called. Field names are pinned for review and must be checked against the first live
 * Starter response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { createZiptaxProvider, parseZiptaxV60 } from "../tax/ziptax.js";
import { fixtureTaxRateProvider } from "../tax/fixtureProvider.js";
import { getTaxRateProvider } from "../tax/index.js";

const MADISON = {
	metadata: {
		version: "v60",
		response: { code: 100, name: "RESPONSE_CODE_SUCCESS", message: "Successful API Request." },
	},
	baseRates: [
		{ rate: 0.05, jurType: "US_STATE_SALES_TAX", jurName: "WI", jurTaxCode: "55" },
		{ rate: 0.05, jurType: "US_STATE_USE_TAX", jurName: "WI", jurTaxCode: "55" },
		{ rate: 0.005, jurType: "US_COUNTY_SALES_TAX", jurName: "DANE", jurTaxCode: "025" },
		{ rate: 0.005, jurType: "US_COUNTY_USE_TAX", jurName: "DANE", jurTaxCode: "025" },
	],
	service: { adjustmentType: "SERVICE_TAXABLE", taxable: "Y" },
	sourcingRules: { adjustmentType: "ORIGIN_DESTINATION", value: "D" },
	addressDetail: {
		normalizedAddress: "200 Martin Luther King Jr Blvd, Madison, WI 53703-3345, United States",
		incorporated: "true",
		geoLat: 43.0727,
		geoLng: -89.3838,
	},
};

describe("parseZiptaxV60", () => {
	it("keeps *_SALES_TAX rows, drops *_USE_TAX rows, and reads sourcing and coords", () => {
		expect(parseZiptaxV60(MADISON, 200)).toEqual({
			status: "ok",
			state_code: "WI",
			components: [
				{ jurisdiction_type: "state", jurisdiction_name: "WI", jurisdiction_code: "55", rate: 0.05 },
				{ jurisdiction_type: "county", jurisdiction_name: "DANE", jurisdiction_code: "025", rate: 0.005 },
			],
			sourcing: "D",
			lat: 43.0727,
			lng: -89.3838,
		});
	});

	it("keeps a generic district name and a missing code, and maps an unknown sales-tax layer to district", () => {
		const r = parseZiptaxV60(
			{
				...MADISON,
				baseRates: [
					...MADISON.baseRates,
					{ rate: 0.00125, jurType: "US_DISTRICT_SALES_TAX", jurName: "Local District: 37" },
					{ rate: 0.001, jurType: "US_SPECIAL_SALES_TAX", jurName: "Stadium" },
				],
			},
			200,
		);
		expect(r.status === "ok" && r.components.slice(2)).toEqual([
			{ jurisdiction_type: "district", jurisdiction_name: "Local District: 37", jurisdiction_code: null, rate: 0.00125 },
			{ jurisdiction_type: "district", jurisdiction_name: "Stadium", jurisdiction_code: null, rate: 0.001 },
		]);
	});

	it("treats the ZIP-fallback shape as ambiguous", () => {
		const { baseRates: _b, ...rest } = MADISON;
		expect(parseZiptaxV60({ ...rest, results: [{ taxSales: 0.055 }] }, 200)).toMatchObject({
			status: "ambiguous",
		});
	});

	// Live v60 (2026-10-15) answers code 100 for degraded matches and has no match-quality field;
	// only normalizedAddress shows the precision lost.
	const at = (normalizedAddress: string) => ({
		...MADISON,
		addressDetail: { ...MADISON.addressDetail, normalizedAddress },
	});

	it("treats an address lookup matched without a house number as ambiguous", () => {
		for (const a of [
			"53701, Madison, WI, United States", // PO box → ZIP centroid
			"E Main St, Madison, WI 53703, United States", // unknown house number → street
			"Highway 12, Lake Delton, WI 53940, United States",
			"",
		]) {
			expect(parseZiptaxV60(at(a), 200), a).toMatchObject({ status: "ambiguous" });
		}
	});

	it("accepts house-number forms: plain, suffixed, hyphenated, and Wisconsin grid", () => {
		for (const a of [
			"12398 W Greenfield Ave, West Allis, WI 53214-2057, United States",
			"12A Main St, Madison, WI 53703, United States",
			"123-45 Queens Blvd, Queens, NY 11375, United States",
			"N56W24879 N Corporate Cir, Sussex, WI 53089, United States",
			"W204 N11509 Goldendale Rd, Germantown, WI 53022, United States",
		]) {
			expect(parseZiptaxV60(at(a), 200), a).toMatchObject({ status: "ok" });
		}
	});

	it("does not require a house number on a coordinate lookup", () => {
		const landmark = at(
			"Wisconsin State Capitol, 201 E Washington Ave, Madison, WI 53703, United States"
		);
		expect(parseZiptaxV60(landmark, 200)).toMatchObject({ status: "ambiguous" });
		expect(parseZiptaxV60(landmark, 200, "coords")).toMatchObject({ status: "ok" });
	});

	it("drops the 0% mailing-city row on an unincorporated address, never a taxed one", () => {
		const city = (rate: number) => ({
			...MADISON,
			baseRates: [
				...MADISON.baseRates,
				{ rate, jurType: "US_CITY_SALES_TAX", jurName: "WAUNAKEE", jurTaxCode: null },
			],
			addressDetail: { ...MADISON.addressDetail, incorporated: "false" },
		});
		const types = (r: ReturnType<typeof parseZiptaxV60>) =>
			r.status === "ok" ? r.components.map((c) => c.jurisdiction_type) : r.status;
		expect(types(parseZiptaxV60(city(0), 200))).toEqual(["state", "county"]);
		expect(types(parseZiptaxV60(city(0.01), 200))).toEqual(["state", "county", "city"]);
		const incorporated = city(0);
		incorporated.addressDetail.incorporated = "true";
		expect(types(parseZiptaxV60(incorporated, 200))).toEqual(["state", "county", "city"]);
	});

	it("treats a missing addressDetail as ambiguous", () => {
		const { addressDetail: _a, ...rest } = MADISON;
		expect(parseZiptaxV60(rest, 200)).toMatchObject({ status: "ambiguous" });
	});

	it("treats a non-success address code as ambiguous", () => {
		expect(
			parseZiptaxV60({ metadata: { response: { code: 104, name: "INVALID_POSTAL_CODE", message: "Invalid Postal Code" } } }, 200),
		).toMatchObject({ status: "ambiguous" });
	});

	it("treats a key or quota code as a provider failure, not a bad address", () => {
		expect(
			parseZiptaxV60({ metadata: { response: { code: 108, name: "REQUEST_LIMIT_EXCEEDED", message: "Monthly request limit exceeded" } } }, 200),
		).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(null, 429)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(null, 401)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(null, 503)).toMatchObject({ status: "failed" });
	});

	// Only a 400/422 says the address itself is bad; any other 4xx must not be cached to month end.
	it("treats only HTTP 400 and 422 as ambiguous; any other 4xx is a failure", () => {
		expect(parseZiptaxV60(null, 400)).toMatchObject({ status: "ambiguous" });
		expect(parseZiptaxV60(null, 422)).toMatchObject({ status: "ambiguous" });
		expect(parseZiptaxV60(null, 404)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(null, 408)).toMatchObject({ status: "failed" });
	});

	// Review Focus 4: a failure is never cached; an ambiguous answer is cached to month end.
	it("treats a 200 whose body is not the v60 shape as a provider failure", () => {
		expect(parseZiptaxV60("<html>Bad gateway</html>", 200)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(null, 200)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60({}, 200)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60({ baseRates: "nope" }, 200)).toMatchObject({ status: "failed" });
		const { metadata: _m, ...noMetadata } = MADISON;
		expect(parseZiptaxV60(noMetadata, 200)).toMatchObject({ status: "failed" });
		expect(
			parseZiptaxV60({ metadata: { response: { code: 100, name: "RESPONSE_CODE_SUCCESS" } } }, 200),
		).toMatchObject({ status: "failed" });
	});

	it("fails, not a 0% rate or code 0, on a null or empty rate or code", () => {
		const withRate = (rate: unknown) => ({
			...MADISON,
			baseRates: [{ ...MADISON.baseRates[0], rate }, MADISON.baseRates[2]],
		});
		expect(parseZiptaxV60(withRate(null), 200)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(withRate(""), 200)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(withRate("abc"), 200)).toMatchObject({ status: "failed" });
		expect(parseZiptaxV60(withRate("0.05"), 200)).toMatchObject({ status: "ok" });
		expect(
			parseZiptaxV60({ ...MADISON, metadata: { response: { code: null } } }, 200),
		).toMatchObject({ status: "failed" });
		expect(
			parseZiptaxV60({ ...MADISON, metadata: { response: { code: "" } } }, 200),
		).toMatchObject({ status: "failed" });
	});

	it("keeps null provider coords as null, not 0,0", () => {
		const r = parseZiptaxV60(
			{ ...MADISON, addressDetail: { ...MADISON.addressDetail, geoLat: null, geoLng: null } },
			200,
		);
		expect(r).toMatchObject({ status: "ok", lat: null, lng: null });
	});
});

describe("createZiptaxProvider", () => {
	it("sends key + address to GET /request/v60", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(MADISON), { status: 200 }));
		const p = createZiptaxProvider("k-123", fetchImpl as unknown as typeof fetch);
		const r = await p.lookup({ address: "200 MLK JR BLVD, MADISON, WI 53703" }, new AbortController().signal);
		const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
		expect(url.origin + url.pathname).toBe("https://api.zip-tax.com/request/v60");
		expect(url.searchParams.get("key")).toBe("k-123");
		expect(url.searchParams.get("address")).toBe("200 MLK JR BLVD, MADISON, WI 53703");
		expect(r.status).toBe("ok");
	});

	it("sends lat + lng when given coords", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(MADISON), { status: 200 }));
		await createZiptaxProvider("k", fetchImpl as unknown as typeof fetch).lookup(
			{ lat: 43.07305, lng: -89.40123 },
			new AbortController().signal,
		);
		const url = new URL(String((fetchImpl.mock.calls[0] as unknown[])[0]));
		expect(url.searchParams.get("lat")).toBe("43.07305");
		expect(url.searchParams.get("lng")).toBe("-89.40123");
		expect(url.searchParams.has("address")).toBe(false);
	});

	it("returns failed, not a throw, on a network error or abort", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNRESET");
		});
		const r = await createZiptaxProvider("k", fetchImpl as unknown as typeof fetch).lookup(
			{ address: "X" },
			new AbortController().signal,
		);
		expect(r).toMatchObject({ status: "failed" });
	});

	it("returns failed for a 200 whose body is not JSON", async () => {
		const fetchImpl = vi.fn(
			async () => new Response("<html>Bad gateway</html>", { status: 200 }),
		);
		const r = await createZiptaxProvider("k", fetchImpl as unknown as typeof fetch).lookup(
			{ address: "X" },
			new AbortController().signal,
		);
		expect(r).toMatchObject({ status: "failed" });
	});
});

describe("fixtureTaxRateProvider", () => {
	const signal = new AbortController().signal;
	it("is deterministic per state", async () => {
		const a = await fixtureTaxRateProvider.lookup({ address: "1 A ST, MADISON, WI 53703" }, signal);
		const b = await fixtureTaxRateProvider.lookup({ address: "9 Z AVE, MILWAUKEE, WI 53202" }, signal);
		expect(a).toEqual(b);
		expect(a).toMatchObject({ status: "ok", state_code: "WI", sourcing: "D" });
	});
	it("reports the origin flag for IL as data", async () => {
		expect(await fixtureTaxRateProvider.lookup({ address: "1 A ST, CHICAGO, IL 60601" }, signal)).toMatchObject({ sourcing: "O" });
	});
	it("is ambiguous for a PO box and for coords", async () => {
		expect(await fixtureTaxRateProvider.lookup({ address: "PO BOX 12, MADISON, WI 53703" }, signal)).toMatchObject({ status: "ambiguous" });
		expect(await fixtureTaxRateProvider.lookup({ lat: 43, lng: -89 }, signal)).toMatchObject({ status: "ambiguous" });
	});
});

describe("getTaxRateProvider", () => {
	const KEYS = ["TAX_RATE_PROVIDER", "ZIPTAX_API_KEY", "NODE_ENV"] as const;
	let saved: Record<string, string | undefined>;
	beforeEach(() => {
		saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
		for (const k of KEYS) delete process.env[k];
	});
	afterEach(() => {
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("defaults to the fixture without a key", () => {
		expect(getTaxRateProvider()?.name).toBe("fixture");
	});
	it("defaults to ziptax with a key", () => {
		process.env.ZIPTAX_API_KEY = "k";
		expect(getTaxRateProvider()?.name).toBe("ziptax");
	});
	it("honours an explicit fixture choice even with a key", () => {
		process.env.ZIPTAX_API_KEY = "k";
		process.env.TAX_RATE_PROVIDER = "fixture";
		expect(getTaxRateProvider()?.name).toBe("fixture");
	});
	it("refuses the fixture in production", () => {
		process.env.NODE_ENV = "production";
		expect(getTaxRateProvider()).toBeNull();
	});
	it("returns null for ziptax without a key, and for an unknown value", () => {
		process.env.TAX_RATE_PROVIDER = "ziptax";
		expect(getTaxRateProvider()).toBeNull();
		process.env.TAX_RATE_PROVIDER = "avalara";
		expect(getTaxRateProvider()).toBeNull();
	});
});
