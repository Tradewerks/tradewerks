// backend/src/services/tax/index.ts
import { log } from "../appLogger.js";
import { fixtureTaxRateProvider } from "./fixtureProvider.js";
import type { TaxRateProvider } from "./provider.js";
import { createZiptaxProvider } from "./ziptax.js";

export * from "./provider.js";

/**
 * Resolved per call, not cached at import, so a rotated key applies on the next lookup.
 * Null is a supported end state: the resolver treats it as a provider failure and the
 * fallback chain takes over.
 */
export function getTaxRateProvider(): TaxRateProvider | null {
	const key = process.env.ZIPTAX_API_KEY?.trim();
	const configured = (process.env.TAX_RATE_PROVIDER ?? "").trim().toLowerCase();
	const choice = configured || (key ? "ziptax" : "fixture");

	if (choice === "fixture") {
		// Its rates are invented; in production they would be charged to real customers.
		if (process.env.NODE_ENV === "production") {
			log.error(
				"TAX_RATE_PROVIDER=fixture is refused in production - tax lookups disabled"
			);
			return null;
		}
		return fixtureTaxRateProvider;
	}
	if (choice === "ziptax") {
		if (!key) {
			log.warn(
				"TAX_RATE_PROVIDER=ziptax needs ZIPTAX_API_KEY - tax lookups disabled"
			);
			return null;
		}
		return createZiptaxProvider(key);
	}
	log.warn({ configured }, "Unknown TAX_RATE_PROVIDER - tax lookups disabled");
	return null;
}
