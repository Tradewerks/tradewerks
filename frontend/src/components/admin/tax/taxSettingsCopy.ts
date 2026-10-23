import type { TaxGroup } from "../../../types/tax";
import { formatRatePercent } from "../../../lib/formatTax";

// Wording follows effective_tax_mode and must match backend/src/services/tax/precedence.ts.
export type TaxMode = "auto" | "manual";

export const RATES_EXPLAINER =
	"Rates are parts of groups. Editing a rate changes every group that uses it.";

export function defaultRowLabel(mode: TaxMode): string {
	return mode === "auto"
		? "When the address lookup fails, use"
		: "Default group — taxes lines without their own group";
}

export function defaultRowNote(mode: TaxMode): string {
	return mode === "auto"
		? "Applies the next time a document's address can't be looked up."
		: "New lines get this group. Saved drafts keep the group already on their lines.";
}

const MANUAL_NO_DEFAULT = "lines with no group, on clients with no group, aren't taxed.";

// Auto mode falls to the org flat rate, or $0 when that is 0.
function autoFallbackOutcome(legacyRate: number): string {
	return legacyRate > 0
		? `use your organization rate of ${formatRatePercent(legacyRate)}%`
		: "get no tax";
}

export function noDefaultWarning(mode: TaxMode, legacyRate: number): string {
	return mode === "auto"
		? `No fallback group. If an address can't be looked up, documents ${autoFallbackOutcome(legacyRate)} and are flagged for review.`
		: "No default group. Lines with no group, on clients with no group, aren't taxed.";
}

export function deactivateDefaultWarning(mode: TaxMode, legacyRate: number): string {
	return mode === "auto"
		? `This is your fallback group. After deactivating, documents whose address can't be looked up ${autoFallbackOutcome(legacyRate)} and are flagged for review.`
		: `This is your default group. After deactivating, ${MANUAL_NO_DEFAULT}`;
}

export function defaultChipLabel(mode: TaxMode): "Fallback" | "Default" {
	return mode === "auto" ? "Fallback" : "Default";
}

export function defaultCheckboxLabel(mode: TaxMode): string {
	return mode === "auto" ? "Use as fallback group" : "Set as default group";
}

export function groupsExplainer(mode: TaxMode): string {
	return mode === "auto"
		? "Picked on a line or a client. Everything else uses the address rate."
		: "Picked on a line or a client. Otherwise the default group is filled in.";
}

/** The resolver only counts an active default; a stale flag on an inactive group is no default. */
export function activeDefaultGroup(groups: TaxGroup[]): TaxGroup | null {
	return groups.find((g) => g.is_active && g.is_default) ?? null;
}

export function ratesOutsideActiveGroups(groups: TaxGroup[]): (rateId: string) => boolean {
	const used = new Set(
		groups.filter((g) => g.is_active).flatMap((g) => g.rates.map((r) => r.tax_rate.id)),
	);
	return (rateId) => !used.has(rateId);
}
