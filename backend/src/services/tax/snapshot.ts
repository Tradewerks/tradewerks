import type { TaxSnapshot } from "../taxEngine.js";
import type { TaxSource } from "./precedence.js";
import { JURISDICTION_TYPES, type JurisdictionType } from "./rateSet.js";
import type { TaxRounding } from "./rounding.js";

type V1Group = TaxSnapshot["groups"][number];
type V1Rate = V1Group["rates"][number];

export interface TaxSnapshotV2 extends Omit<TaxSnapshot, "version" | "groups"> {
	version: 2;
	source: TaxSource | null;
	rate_set_id?: string;
	review_reason?: string;
	/** Provider O/D flag, recorded as data only. */
	sourcing?: "O" | "D";
	/** New documents round half-up per jurisdiction; documents first taxed earlier keep line_floor. */
	rounding: TaxRounding;
	qb_tax_cents?: number;
	/** Hash of the QB payload the adopted qb_tax_cents was computed for. */
	qb_fingerprint?: string;
	/** True when review_reason came from a QB-vs-estimate delta, so a drop clears only that review. */
	qb_review?: boolean;
	/** Manual mode kept the address rate this document was taxed at in auto mode. */
	kept_from_auto?: true;
	groups: (Omit<V1Group, "rates"> & {
		rates: (V1Rate & { jurisdiction_type?: JurisdictionType })[];
	})[];
}

export type AnyTaxSnapshot = TaxSnapshot | TaxSnapshotV2;

export interface SnapshotMeta {
	source: TaxSource | null;
	rate_set_id: string | null;
	review_reason: string | null;
	sourcing: "O" | "D" | null;
	/** Omitted means line_floor, the rounding every snapshot before half-up was taxed with. */
	rounding?: TaxRounding;
	kept_from_auto?: boolean;
}

function jurisdictionTypeOf(label: string | undefined): JurisdictionType | undefined {
	const t = label?.trim().toLowerCase() ?? "";
	return (JURISDICTION_TYPES as readonly string[]).includes(t)
		? (t as JurisdictionType)
		: undefined;
}

export function toSnapshotV2(v1: TaxSnapshot, meta: SnapshotMeta): TaxSnapshotV2 {
	return {
		...v1,
		version: 2,
		source: meta.source,
		...(meta.rate_set_id ? { rate_set_id: meta.rate_set_id } : {}),
		...(meta.review_reason ? { review_reason: meta.review_reason } : {}),
		...(meta.sourcing ? { sourcing: meta.sourcing } : {}),
		rounding: meta.rounding ?? "line_floor",
		...(meta.kept_from_auto ? { kept_from_auto: true as const } : {}),
		groups: v1.groups.map((g) => ({
			...g,
			rates: g.rates.map((r) => {
				const t = jurisdictionTypeOf(r.jurisdiction);
				return t ? { ...r, jurisdiction_type: t } : r;
			}),
		})),
	};
}

/** Every reader branches on version; anything else is not a snapshot we wrote. */
export function readTaxSnapshot(value: unknown): AnyTaxSnapshot | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const v = value as { version?: unknown; groups?: unknown };
	if (!Array.isArray(v.groups)) return null;
	if (v.version === 2) return value as TaxSnapshotV2;
	if (v.version === 1) return value as TaxSnapshot;
	return null;
}

/**
 * A document keeps the rounding it was first taxed with, so recomputing a draft taxed before
 * half-up rounding never moves its cents. Only a document with no snapshot yet starts half-up.
 */
export function roundingFor(stored: unknown): TaxRounding {
	if (stored == null) return "jurisdiction_half_up";
	return (stored as { rounding?: unknown }).rounding === "jurisdiction_half_up"
		? "jurisdiction_half_up"
		: "line_floor";
}

/**
 * QuickBooks' authoritative tax for an adopted invoice, else null. An adopted snapshot's
 * groups/lines are only our estimate, so readers that sum them must branch on this.
 */
export function qbAstTaxCents(stored: unknown): number | null {
	const s = stored as { source?: unknown; qb_tax_cents?: unknown } | null;
	if (s?.source !== "qb_ast" || typeof s.qb_tax_cents !== "number") return null;
	return s.qb_tax_cents;
}

export function isLockedSnapshot(value: unknown): boolean {
	return value != null && (value as { locked_at?: unknown }).locked_at !== "draft";
}
