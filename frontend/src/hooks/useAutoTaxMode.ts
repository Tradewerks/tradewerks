import { useEntitlements, useModuleOn } from "./useEntitlements";
import { useOrgSettings } from "./useOrg";

/**
 * Mirrors the server's effective tax mode: stored "auto" only counts while `tax_auto` is on
 * (a downgraded org is taxed as manual). Undefined until both are known, so callers can hold
 * off on mode-dependent defaults instead of guessing.
 */
export function useAutoTaxMode(): boolean | undefined {
	const { data: org } = useOrgSettings();
	const { data: entitlements } = useEntitlements();
	const moduleOn = useModuleOn("tax_auto");
	if (!org || !entitlements) return undefined;
	return org.tax_mode === "auto" && moduleOn;
}
