// backend/src/services/tax/provider.ts
import type { RateComponent } from "./rateSet.js";
import type { TaxLookupInput } from "./address.js";

export type { TaxLookupInput };

export type ProviderResult =
	| {
			status: "ok";
			state_code: string;
			components: RateComponent[];
			sourcing: "O" | "D" | null;
			lat: number | null;
			lng: number | null;
	  }
	| { status: "ambiguous"; reason: string }
	| { status: "failed"; reason: string };

export interface TaxRateProvider {
	name: string;
	/**
	 * Never throws for HTTP, network or parse problems: those come back as `failed` (the
	 * service) or `ambiguous` (the address), because the two take different fallback paths.
	 */
	lookup(input: TaxLookupInput, signal: AbortSignal): Promise<ProviderResult>;
}
