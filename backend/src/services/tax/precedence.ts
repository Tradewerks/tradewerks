import type { TaxGroupConfig } from "../taxEngine.js";
import { rateSetToTaxGroupConfig, type RateSetView } from "./rateSet.js";
import type { TaxMode } from "./taxMode.js";
import type { AddressOutcome } from "./taxResolver.js";

export const TAX_SOURCES = [
	"provider",
	"cached_stale",
	"manual_override",
	"org_default",
	"legacy",
	"qb_ast",
] as const;
export type TaxSource = (typeof TAX_SOURCES)[number];

export const LEGACY_GROUP_ID = "legacy";

/** The address rate a not-issued document was taxed at in auto mode, carried into manual mode. */
export interface KeptRate {
	rate_set: RateSetView;
	source: "provider" | "cached_stale";
	needs_review: boolean;
	review_reason: string | null;
	resolution_id: string | null;
	sourcing: "O" | "D" | null;
}

export interface DefaultTaxInput {
	mode: TaxMode;
	clientExempt: boolean;
	clientHasGroup: boolean;
	/** At least one taxable line carries its own tax_group_id. */
	explicitTaxableLine: boolean;
	/** At least one taxable, non-zero line has no group and the client has none either. */
	needsDefault: boolean;
	/** Null when no lookup was attempted (manual mode, or nothing needs a default). */
	outcome: AddressOutcome | null;
	orgDefault: TaxGroupConfig | null;
	legacyRate: number;
	registeredStates: string[];
	/** Manual mode only; auto mode looks the address up again. */
	kept: KeptRate | null;
}

export interface DefaultTaxDecision {
	/** Applies to lines with no group of their own when the client has none. */
	group: TaxGroupConfig | null;
	source: TaxSource | null;
	needs_review: boolean;
	review_reason: string | null;
	resolution_id: string | null;
	rate_set_id: string | null;
	/** Provider O/D flag, recorded as data only. */
	sourcing: "O" | "D" | null;
	/** The group is a kept address rate, not a lookup or a dispatcher's pick. */
	kept_from_auto: boolean;
}

const legacyGroup = (rate: number): TaxGroupConfig => ({
	id: LEGACY_GROUP_ID,
	name: "Organization tax rate",
	rates: [{ id: LEGACY_GROUP_ID, name: "Sales tax", rate }],
});

/**
 * First match wins. The document-level source describes how lines WITHOUT their
 * own group were taxed; with no such line it is manual_override (explicit groups) or null.
 * Review flags exist only in auto mode, or in manual mode on a kept address rate (they carry
 * over with it); otherwise manual mode is today's behaviour plus the source.
 */
export function decideDefaultTax(i: DefaultTaxInput): DefaultTaxDecision {
	const base = {
		group: null,
		needs_review: false,
		review_reason: null,
		resolution_id: null,
		rate_set_id: null,
		sourcing: null,
		kept_from_auto: false,
	};
	if (i.clientExempt) return { ...base, source: null };
	if (!i.needsDefault) {
		return {
			...base,
			source:
				i.clientHasGroup || i.explicitTaxableLine
					? "manual_override"
					: null,
		};
	}
	if (i.mode === "manual") {
		// Review state carries over: keeping a flagged rate must never launder it into a silent one.
		if (i.kept) {
			return {
				group: rateSetToTaxGroupConfig(i.kept.rate_set),
				source: i.kept.source,
				needs_review: i.kept.needs_review,
				review_reason: i.kept.review_reason,
				resolution_id: i.kept.resolution_id,
				rate_set_id: i.kept.rate_set.id,
				sourcing: i.kept.sourcing,
				kept_from_auto: true,
			};
		}
		return {
			...base,
			group: i.orgDefault,
			source: i.orgDefault ? "org_default" : null,
		};
	}

	const o = i.outcome;
	if (o?.kind === "rate") {
		const reasons = [...o.reasons];
		if (!i.registeredStates.includes(o.rate_set.state_code)) {
			reasons.push(`Not registered to collect in ${o.rate_set.state_code}`);
		}
		return {
			group: rateSetToTaxGroupConfig(o.rate_set),
			source: o.stale ? "cached_stale" : "provider",
			needs_review: o.stale || reasons.length > 0,
			review_reason: reasons.length ? reasons.join("; ") : null,
			resolution_id: o.resolution_id,
			rate_set_id: o.rate_set.id,
			sourcing: o.sourcing,
			kept_from_auto: false,
		};
	}

	const reasons = [...(o?.reasons ?? [])];
	const resolution_id = o?.resolution_id ?? null;
	if (i.orgDefault) {
		return {
			...base,
			group: i.orgDefault,
			source: "org_default",
			needs_review: true,
			review_reason: reasons.join("; ") || "No address-based rate is available",
			resolution_id,
		};
	}
	reasons.push(
		i.legacyRate > 0
			? "No default tax group; using the organization tax rate"
			: "No default tax group or organization tax rate is set"
	);
	return {
		...base,
		group: i.legacyRate > 0 ? legacyGroup(i.legacyRate) : null,
		source: "legacy",
		needs_review: true,
		review_reason: reasons.join("; "),
		resolution_id,
	};
}

/**
 * A previous acknowledgment covered a different degraded state; the new one needs its own.
 * "Different" means a new review, a changed source, or a changed reason (same source can still
 * be a different problem, e.g. an address moving from one unregistered state to another).
 */
export function shouldResetAck(
	prev: {
		tax_source: string | null;
		tax_needs_review: boolean;
		review_reason?: string | null;
	},
	next: Pick<DefaultTaxDecision, "source" | "needs_review" | "review_reason">
): boolean {
	if (!next.needs_review) return false;
	return (
		!prev.tax_needs_review ||
		prev.tax_source !== next.source ||
		(prev.review_reason ?? null) !== (next.review_reason ?? null)
	);
}
