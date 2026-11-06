// backend/src/services/tax/ziptax.ts
import { z } from "zod";
import { addressState, stateCode } from "./address.js";
import type { JurisdictionType, RateComponent } from "./rateSet.js";
import type { ProviderResult, TaxRateProvider } from "./provider.js";

// Field names are unconfirmed until checked against a live Starter response.
export const ZIPTAX_V60_URL = "https://api.zip-tax.com/request/v60";
const ZIPTAX_SUCCESS = 100;
const ACCOUNT_PROBLEM = /key|quota|limit|exceed|enabled|plan|auth|permission|suspend/i;

const SALES_TAX_TYPES: Record<string, JurisdictionType> = {
	US_STATE_SALES_TAX: "state",
	US_COUNTY_SALES_TAX: "county",
	US_CITY_SALES_TAX: "city",
	US_DISTRICT_SALES_TAX: "district",
};

// Not z.coerce: it turns null and "" into 0, so a drifted payload would read as a 0% rate (or
// code 0) instead of failing the parse.
const ZNum = z
	.union([z.number(), z.string().trim().min(1)])
	.transform(Number)
	.refine(Number.isFinite);

// Lenient on purpose: only the fields we read are required, everything else passes through.
const ZBaseRate = z
	.object({
		rate: ZNum,
		jurType: z.string(),
		jurName: z.string().default(""),
		jurTaxCode: z
			.union([z.string(), z.number()])
			.nullish()
			.transform((v) => (v == null || v === "" ? null : String(v))),
	})
	.passthrough();

// Not z.coerce: it turns a null coordinate into 0, which would store the point 0,0.
const ZGeo = z
	.union([z.number(), z.string()])
	.nullish()
	.transform((v) => {
		const n = v == null || v === "" ? Number.NaN : Number(v);
		return Number.isFinite(n) ? n : null;
	});

const ZiptaxV60 = z
	.object({
		metadata: z
			.object({
				response: z
					.object({
						code: ZNum,
						name: z.string().optional(),
						message: z.string().optional(),
					})
					.passthrough(),
			})
			.passthrough()
			.optional(),
		baseRates: z.array(ZBaseRate).optional(),
		results: z.array(z.unknown()).optional(),
		sourcingRules: z.object({ value: z.string() }).passthrough().nullish(),
		addressDetail: z
			.object({
				normalizedAddress: z.string().optional(),
				incorporated: z.string().nullish(),
				geoLat: ZGeo,
				geoLng: ZGeo,
			})
			.passthrough()
			.nullish(),
	})
	.passthrough();

// Plain ("12A", "123-45") or Wisconsin grid ("N56W24879", "W204 N11509"). Live v60 answers
// code 100 for a PO box (ZIP centroid) or an unknown house number (street level) and has no
// match-quality field; a normalizedAddress without a leading house number is how that shows.
const HOUSE_NUMBER = /^(?:[NSEW]\d+\s?[NSEW]\d+|\d+(?:-\d+)?[A-Z]?)\s+\S/i;

const failed = (reason: string): ProviderResult => ({ status: "failed", reason });
const ambiguous = (reason: string): ProviderResult => ({ status: "ambiguous", reason });

function jurisdictionType(jurType: string): JurisdictionType | null {
	const t = jurType.toUpperCase();
	if (!t.endsWith("_SALES_TAX")) return null; // *_USE_TAX is the buyer's liability, not ours to charge
	// An unrecognised sales-tax layer is still charged: dropping it would under-collect.
	return SALES_TAX_TYPES[t] ?? "district";
}

export function parseZiptaxV60(
	body: unknown,
	httpStatus: number,
	lookupBy: "address" | "coords" = "address"
): ProviderResult {
	if (httpStatus === 429) return failed("Tax rate service rate limit reached");
	if (httpStatus === 401 || httpStatus === 403)
		return failed("Tax rate service refused the API key");
	if (httpStatus >= 500) return failed(`Tax rate service error (HTTP ${httpStatus})`);
	// Only these say the address itself is bad; `ambiguous` is cached to month end, so any other
	// 4xx (404, 408, ...) must stay a failure.
	if (httpStatus === 400 || httpStatus === 422) {
		return ambiguous(
			`Tax rate service could not read the address (HTTP ${httpStatus})`
		);
	}
	if (httpStatus >= 400) return failed(`Tax rate service error (HTTP ${httpStatus})`);

	const parsed = ZiptaxV60.safeParse(body);
	if (!parsed.success || typeof body !== "object" || body === null) {
		return failed("Tax rate service returned an unexpected response");
	}
	const r = parsed.data;

	// Not the v60 shape ({}, renamed fields): fail, since `ambiguous` is cached to month end.
	const response = r.metadata?.response;
	if (!response) return failed("Tax rate service returned an unexpected response");
	if (response.code !== ZIPTAX_SUCCESS) {
		const text =
			`${response.name ?? ""} ${response.message ?? ""}`.trim() ||
			`code ${response.code}`;
		return ACCOUNT_PROBLEM.test(text)
			? failed(`Tax rate service: ${text}`)
			: ambiguous(`Address not matched: ${text}`);
	}
	if (r.baseRates === undefined && r.results === undefined) {
		return failed("Tax rate service returned an unexpected response");
	}
	if (!r.baseRates?.length) {
		return ambiguous(
			r.results
				? "Only a ZIP-level match was found for this address"
				: "No jurisdiction rates were returned for this address"
		);
	}
	if (!r.addressDetail) return ambiguous("The address could not be matched exactly");
	const matched = r.addressDetail.normalizedAddress?.trim() ?? "";
	if (lookupBy === "address" && !HOUSE_NUMBER.test(matched)) {
		return ambiguous("The address was matched only to its street or ZIP code");
	}

	// Unincorporated land gets a 0% city row named after the mailing city, which is not the
	// jurisdiction. A non-zero city rate is kept: dropping it would under-collect.
	const unincorporated = r.addressDetail.incorporated?.trim().toLowerCase() === "false";
	const components: RateComponent[] = r.baseRates.flatMap((b) => {
		const type = jurisdictionType(b.jurType);
		if (type === "city" && unincorporated && b.rate === 0) return [];
		return type
			? [
					{
						jurisdiction_type: type,
						jurisdiction_name: b.jurName.trim() || type,
						jurisdiction_code: b.jurTaxCode,
						rate: b.rate,
					},
				]
			: [];
	});
	if (components.length === 0) return ambiguous("No sales-tax jurisdictions were returned");

	const stateRow = components.find((c) => c.jurisdiction_type === "state");
	const state =
		(stateRow && stateCode(stateRow.jurisdiction_name)) ||
		addressState(r.addressDetail.normalizedAddress);
	if (!state) return ambiguous("The state could not be determined for this address");

	const sourcing = r.sourcingRules?.value?.trim().toUpperCase();
	return {
		status: "ok",
		state_code: state,
		components,
		sourcing: sourcing === "O" || sourcing === "D" ? sourcing : null,
		lat: r.addressDetail.geoLat ?? null,
		lng: r.addressDetail.geoLng ?? null,
	};
}

export function createZiptaxProvider(
	apiKey: string,
	fetchImpl: typeof fetch = fetch
): TaxRateProvider {
	return {
		name: "ziptax",
		async lookup(input, signal) {
			const params = new URLSearchParams({ key: apiKey });
			if ("address" in input) params.set("address", input.address);
			else {
				params.set("lat", String(input.lat));
				params.set("lng", String(input.lng));
			}
			let res: Response;
			try {
				// The URL carries the key: never log it.
				res = await fetchImpl(`${ZIPTAX_V60_URL}?${params}`, {
					signal,
					headers: { Accept: "application/json" },
				});
			} catch {
				return failed(
					signal.aborted
						? "Tax rate lookup timed out"
						: "Tax rate service unreachable"
				);
			}
			let body: unknown = null;
			try {
				body = await res.json();
			} catch {
				body = null;
			}
			return parseZiptaxV60(
				body,
				res.status,
				"address" in input ? "address" : "coords"
			);
		},
	};
}
