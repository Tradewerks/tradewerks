import { db } from "../../db.js";
import { isModuleOn } from "../entitlementService.js";

export const TAX_MODES = ["auto", "manual"] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export interface OrgTaxContext {
	stored_mode: TaxMode;
	auto_entitled: boolean;
	/** What documents actually use. */
	mode: TaxMode;
	registered_states: string[];
	legacy_rate: number;
	address: string | null;
}

export function effectiveTaxMode(stored: string | null | undefined, entitled: boolean): TaxMode {
	return stored === "auto" && entitled ? "auto" : "manual";
}

export async function getOrgTaxContext(orgId: string): Promise<OrgTaxContext> {
	const [org, entitled] = await Promise.all([
		db.organization.findUnique({
			where: { id: orgId },
			select: {
				tax_mode: true,
				tax_registered_states: true,
				tax_rate: true,
				address: true,
			},
		}),
		// isModuleOn reads a cached entitlement and answers false on failure: an entitlement
		// outage degrades auto to manual rather than spending lookups it cannot account for.
		isModuleOn(orgId, "tax_auto"),
	]);
	const stored: TaxMode = org?.tax_mode === "auto" ? "auto" : "manual";
	return {
		stored_mode: stored,
		auto_entitled: entitled,
		mode: effectiveTaxMode(stored, entitled),
		registered_states: org?.tax_registered_states ?? [],
		legacy_rate: Number(org?.tax_rate ?? 0),
		address: org?.address ?? null,
	};
}

export async function getEffectiveTaxMode(orgId: string): Promise<TaxMode> {
	return (await getOrgTaxContext(orgId)).mode;
}

export const CLIENT_TOTAL_KEYS = [
	"subtotal",
	"tax_rate",
	"tax_amount",
	"discount_amount",
	"total",
	"estimated_total",
] as const;

/** In auto mode the server's resolved figures are the only truth; an older client may still send its own. */
export function dropClientTaxTotals<T extends object>(parsed: T, mode: TaxMode): T {
	if (mode !== "auto") return parsed;
	const copy: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
	for (const k of CLIENT_TOTAL_KEYS) delete copy[k];
	return copy as T;
}
