export interface TaxRate {
	id: string;
	organization_id: string;
	name: string;
	rate: number; // 0-1 decimal
	description: string | null;
	jurisdiction: string | null;
	is_default: boolean;
	is_active: boolean;
	created_at: string;
	updated_at: string;
}

export interface TaxGroupRate {
	id: string;
	tax_rate: TaxRate;
	sort_order: number;
}

export interface TaxGroup {
	id: string;
	organization_id: string;
	name: string;
	description: string | null;
	is_default: boolean;
	is_active: boolean;
	rates: TaxGroupRate[];
	combined_rate: number; // backend-computed: sum of rates[].tax_rate.rate
	created_at: string;
	updated_at: string;
	qb_tax_code_id?: string | null;
}

export type TaxSource =
	| "provider"
	| "cached_stale"
	| "manual_override"
	| "org_default"
	| "legacy"
	| "qb_ast";

export interface TaxSnapshotRate {
	id: string;
	name: string;
	rate: number;
	jurisdiction?: string;
	/** v2 only; absent on v1 and on manual group rates without a recognised jurisdiction. */
	jurisdiction_type?: string;
}

export interface TaxSnapshotGroup {
	id: string;
	name: string;
	rates: TaxSnapshotRate[];
	taxable_amount_cents: number;
	tax_amount_cents: number;
}

interface TaxSnapshotBase {
	/** ISO time once locked; "draft" while the document is still editable. */
	locked_at: string;
	client_exempt: boolean;
	groups: TaxSnapshotGroup[];
	non_taxable_amount_cents: number;
	total_tax_cents: number;
	subtotal_cents: number;
	discount_cents: number;
	total_cents: number;
	effective_rate: number;
}

export interface TaxSnapshotV1 extends TaxSnapshotBase {
	version: 1;
}

export interface TaxSnapshotV2 extends TaxSnapshotBase {
	version: 2;
	source: TaxSource | null;
	rate_set_id?: string | null;
	/** Manual mode holding an address rate found while auto was on. */
	kept_from_auto?: boolean;
	review_reason?: string | null;
	rounding: "line_floor" | "jurisdiction_half_up";
	/** qb_ast only: QuickBooks' tax is authoritative; groups stay our estimate. */
	qb_tax_cents?: number;
	qb_fingerprint?: string;
	qb_review?: boolean;
}

/** 409 QB_TAX_ZERO details: QuickBooks charged $0 on lines we tax. */
export interface QbTaxZero {
	items: string[];
	line_ids: string[];
}

/** The dispatcher's answer when the address of a document taxed at a kept address rate changes. */
export type AddressTaxChoice = "keep" | "default" | { group_id: string };

/** `error.details` of a 409 ADDRESS_TAX_CHOICE_REQUIRED refusal. */
export interface AddressTaxChoiceDetails {
	rate_label: string;
	rate: number;
	documents: {
		kind: "quote" | "job" | "job_visit" | "invoice";
		id: string;
		number: string | null;
	}[];
}

/** Every reader branches on version. */
export type TaxSnapshot = TaxSnapshotV1 | TaxSnapshotV2;

export const isV2Snapshot = (s: TaxSnapshot | null | undefined): s is TaxSnapshotV2 =>
	s?.version === 2;

export const snapshotSource = (s: TaxSnapshot | null | undefined): TaxSource | null =>
	isV2Snapshot(s) ? s.source : null;

/** Taxable lines with no group were taxed at the service address's rate. */
export const isAddressTaxSource = (s: TaxSource | null | undefined): boolean =>
	s === "provider" || s === "cached_stale";

/** Document-level tax provenance (quote, job, invoice). Visits carry only the v2 snapshot. */
export interface TaxProvenance {
	tax_source?: TaxSource | null;
	tax_needs_review?: boolean;
	tax_review_ack_by?: string | null;
	tax_review_ack_at?: string | null;
}

import { formatRatePercent, formatRatePercentLabel } from "../lib/formatTax";

// Helper: compute display label for a tax group
// e.g. "Standard Rate 8%" or "Labor Only 6%"
export function formatTaxGroupLabel(group: TaxGroup): string {
	if (group.rates.length === 0) return group.name;
	return `${group.name} ${formatRatePercent(group.combined_rate)}%`;
}

// Helper: format combined rate as percentage string
export function formatCombinedRate(rate: number): string {
	return formatRatePercentLabel(rate);
}
