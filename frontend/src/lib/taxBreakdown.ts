import { isAddressTaxSource, isV2Snapshot, type TaxSnapshot, type TaxSource } from "../types/tax";
import { stateName } from "./usStates";
import { roundingFor, snapshotRateCents } from "./taxRounding";
import { formatCurrency } from "../util/util";
import type { Job, JobVisit } from "../types/jobs";

type SnapshotInput = TaxSnapshot | readonly TaxSnapshot[] | null | undefined;
export const toList = (input: SnapshotInput): readonly TaxSnapshot[] =>
	input == null ? [] : "version" in input ? [input] : input;

export interface CollapsedRate {
	id: string;
	name: string;
	rate: number;
	amountCents: number;
}

const RANK: Record<string, number> = { state: 0, county: 1, city: 2, district: 3 };
const rank = (t: string | undefined) => (t != null && t in RANK ? RANK[t] : 4);

// Set by backend services/tax/rateSet.ts when it names an address-looked-up group.
const AUTO_SUFFIX = " (auto)";

const titleCase = (s: string) =>
	s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, sep: string, c: string) => sep + c.toUpperCase());
// Provider names arrive upper-cased ("LA CROSSE"); mixed-case names are already deliberate.
const fixCase = (s: string) => (s === s.toUpperCase() ? titleCase(s) : s);

/** Reader-facing name for a provider-looked-up jurisdiction: "Wisconsin state", "La Crosse County". */
export function jurisdictionLabel(rate: { name: string; jurisdiction_type?: string }): string {
	const { name, jurisdiction_type: type } = rate;
	const has = (word: string) => name.toLowerCase().includes(word);
	switch (type) {
		case "state": {
			const full = /^[A-Za-z]{2}$/.test(name) ? stateName(name.toUpperCase()) : titleCase(name);
			return `${full} state`;
		}
		case "county":
			return has("county") ? fixCase(name) : `${fixCase(name)} County`;
		case "district":
			return has("district") ? fixCase(name) : `${fixCase(name)} district`;
		case "city":
			return `${titleCase(name)} city`;
		default:
			return titleCase(name);
	}
}

/** Taxable lines with no group of their own were taxed at the address rate (incl. adopted QB invoices). */
export function isAddressRateSnapshot(
	snapshot: TaxSnapshot | null | undefined,
	source: TaxSource | null | undefined
): boolean {
	if (isAddressTaxSource(source)) return true;
	return source === "qb_ast" && isV2Snapshot(snapshot) && !!snapshot.rate_set_id;
}

/**
 * Tax per rate across one or more snapshots: each is split with its own rounding, rows are
 * deduplicated by rate id, amounts summed, ordered state → county → city → district → untyped.
 */
export function collapseSnapshotRates(snapshot: SnapshotInput): CollapsedRate[] {
	const byId = new Map<string, CollapsedRate & { type?: string }>();
	for (const snap of toList(snapshot)) {
		const rounding = roundingFor(snap);
		const addressGroupId = isV2Snapshot(snap) ? snap.rate_set_id : null;
		for (const group of snap.groups ?? []) {
			const isAddressGroup = addressGroupId != null && group.id === addressGroupId;
			const rates = group.rates ?? [];
			const rateCents = snapshotRateCents(
				{
					rates,
					taxable_amount_cents: group.taxable_amount_cents ?? 0,
					tax_amount_cents: group.tax_amount_cents ?? 0,
				},
				rounding
			);
			for (const [idx, rate] of rates.entries()) {
				const existing = byId.get(rate.id);
				if (existing) existing.amountCents += rateCents[idx];
				else
					byId.set(rate.id, {
						id: rate.id,
						name: isAddressGroup ? jurisdictionLabel(rate) : rate.name,
						rate: rate.rate,
						type: rate.jurisdiction_type,
						amountCents: rateCents[idx],
					});
			}
		}
	}
	return [...byId.values()]
		.sort((a, b) => rank(a.type) - rank(b.type) || a.name.localeCompare(b.name))
		.map(({ id, name, rate, amountCents }) => ({ id, name, rate, amountCents }));
}

/** "Chicago, IL" for an address-looked-up snapshot; null otherwise. */
export function autoRateLocation(snapshot: TaxSnapshot | null | undefined): string | null {
	if (!isV2Snapshot(snapshot)) return null;
	const group = snapshot.groups.find((g) => g.name.endsWith(AUTO_SUFFIX));
	return group ? group.name.slice(0, -AUTO_SUFFIX.length) : null;
}

/**
 * "Taxable lines $420.00 · $190.00 not taxed": the subtotal split by line taxability, so it
 * reconciles with the line amounts above it. Pre-discount on purpose: the per-group taxable base
 * is post-discount and line-rounded, and would not add up to anything on screen.
 */
export function taxBasis(snapshot: SnapshotInput): string | null {
	const counted = toList(snapshot).filter((s) => !s.client_exempt && s.subtotal_cents != null);
	if (!counted.some((s) => (s.groups ?? []).some((g) => (g.tax_amount_cents ?? 0) !== 0))) return null;
	const subtotalCents = counted.reduce((sum, s) => sum + s.subtotal_cents, 0);
	const excludedCents = counted.reduce((sum, s) => sum + (s.non_taxable_amount_cents ?? 0), 0);
	const taxable = `Taxable lines ${formatCurrency((subtotalCents - excludedCents) / 100)}`;
	return excludedCents !== 0
		? `${taxable} · ${formatCurrency(excludedCents / 100)} not taxed`
		: taxable;
}

const lineCents = (li: { total?: number | string | null; quantity: number | string; unit_price: number | string }) => {
	const t = li.total != null ? Number(li.total) : Number(li.quantity) * Number(li.unit_price);
	return Math.round((Number.isNaN(t) ? 0 : t) * 100);
};

/** The job's own snapshot while it still matches the stored tax; null when absent or stale. */
export function currentJobSnapshot(job: Job): TaxSnapshot | null {
	const own = job.tax_snapshot;
	const taxCents = Math.round(Number(job.tax_amount) * 100);
	return own != null && taxCents === own.total_tax_cents ? own : null;
}

/**
 * Snapshots behind a job's merged financials: the job's own while it is current, else (a manual
 * job, or a stale auto-era snapshot) one built from the job's stored tax so its row still shows;
 * then each completed visit's.
 */
export function jobTaxSnapshots(job: Job, completedVisits: JobVisit[]): TaxSnapshot[] {
	const taxCents = Math.round(Number(job.tax_amount) * 100);
	let jobSnapshot: TaxSnapshot | null = currentJobSnapshot(job);
	if (!jobSnapshot && taxCents !== 0 && !Number.isNaN(taxCents)) {
		const lines = job.line_items ?? [];
		const subtotalCents = lines.reduce((s, li) => s + lineCents(li), 0);
		const nonTaxableCents = lines.reduce((s, li) => s + (li.taxable === false ? lineCents(li) : 0), 0);
		const name = "Job charges tax";
		jobSnapshot = {
			version: 1,
			locked_at: "draft",
			client_exempt: false,
			groups: [
				{
					id: "job-legacy",
					name,
					rates: [{ id: "job-legacy", name, rate: Number(job.tax_rate ?? 0) }],
					taxable_amount_cents: subtotalCents - nonTaxableCents,
					tax_amount_cents: taxCents,
				},
			],
			non_taxable_amount_cents: nonTaxableCents,
			total_tax_cents: taxCents,
			subtotal_cents: subtotalCents,
			discount_cents: Math.round(Number(job.discount_amount ?? 0) * 100),
			total_cents: Math.round(Number(job.total ?? 0) * 100),
			effective_rate: Number(job.tax_rate ?? 0),
		};
	}
	return [
		...(jobSnapshot ? [jobSnapshot] : []),
		...completedVisits.flatMap((v) => (v.tax_snapshot ? [v.tax_snapshot] : [])),
	];
}
