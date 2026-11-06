import type { Job, JobVisit } from "../types/jobs";
import type { Invoice } from "../types/invoices";
import { isV2Snapshot, snapshotSource, type TaxSnapshot, type TaxSource } from "../types/tax";
import {
	autoRateLocation,
	currentJobSnapshot,
	isAddressRateSnapshot,
	jobTaxSnapshots,
} from "./taxBreakdown";
import { ungroupedLineGroup } from "./taxEditorMode";

export interface JobTaxSummary {
	wholeJobTaxCents: number;
	invoiced: { invoiceId: string; number: string; taxCents: number; draft: boolean }[];
	notYetInvoicedCents: number;
	differs: { visitId: string; text: string }[];
}

interface Basis {
	key: string;
	phrase: string;
}

/** Mid-sentence names for a source when no group or place is known. */
const SOURCE_PHRASE: Record<TaxSource, string> = {
	provider: "the address rate",
	cached_stale: "the last known rate",
	manual_override: "a tax group",
	org_default: "the default tax group",
	legacy: "the organization rate",
	qb_ast: "QuickBooks",
};

function basisOf(snapshot: TaxSnapshot | null | undefined, source: TaxSource | null): Basis | null {
	if (!source) return null;
	if (isAddressRateSnapshot(snapshot, source)) {
		const place = autoRateLocation(snapshot);
		return {
			key: `address:${place ?? ""}`,
			phrase: place ? `the ${place} address rate` : "the address rate",
		};
	}
	if (source === "org_default" || source === "manual_override") {
		const name = ungroupedLineGroup(snapshot, source, [])?.name;
		if (name) return { key: `group:${name}`, phrase: name };
	}
	return { key: `source:${source}`, phrase: SOURCE_PHRASE[source] };
}

/** An address rate whose place is unknown matches any address rate. */
function sameBasis(a: Basis, b: Basis): boolean {
	if (a.key === b.key) return true;
	const unknownPlace = a.key === "address:" || b.key === "address:";
	return unknownPlace && a.key.startsWith("address:") && b.key.startsWith("address:");
}

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function jobTaxSummary(
	job: Job,
	completedVisits: JobVisit[],
	linkedInvoices: Invoice[]
): JobTaxSummary {
	const wholeJobTaxCents = jobTaxSnapshots(job, completedVisits).reduce(
		(sum, s) => sum + s.total_tax_cents,
		0
	);

	const invoiced = linkedInvoices
		.filter((inv) => inv.status !== "Void")
		.map((inv) => ({
			invoiceId: inv.id,
			number: inv.invoice_number,
			taxCents: Math.round(Number(inv.tax_amount ?? 0) * 100),
			draft: inv.status === "Draft",
		}));
	const invoicedCents = invoiced.reduce((sum, i) => sum + i.taxCents, 0);

	const visitBases = completedVisits.map((v) => ({
		visit: v,
		basis: v.tax_snapshot
			? basisOf(v.tax_snapshot, snapshotSource(v.tax_snapshot) ?? job.tax_source ?? null)
			: null,
	}));

	// A stale or absent job snapshot cannot name the job's group or place; its source still says
	// how the job was taxed.
	const jobSnap = currentJobSnapshot(job);
	let jobBasis: Basis | null = null;
	if (Number(job.tax_amount) !== 0) {
		jobBasis = basisOf(jobSnap, job.tax_source ?? snapshotSource(jobSnap));
	} else {
		const tally = new Map<string, { n: number; basis: Basis }>();
		for (const { basis } of visitBases) {
			if (!basis) continue;
			const t = tally.get(basis.key) ?? { n: 0, basis };
			t.n += 1;
			tally.set(basis.key, t);
		}
		jobBasis = [...tally.values()].sort((a, b) => b.n - a.n)[0]?.basis ?? null;
	}

	const reviewIds: string[] = [];
	const exemptIds: string[] = [];
	const bySource = new Map<string, { ids: string[]; phrase: string }>();
	for (const { visit, basis } of visitBases) {
		const snap = visit.tax_snapshot;
		if (!snap) continue;
		if (isV2Snapshot(snap) && snap.review_reason) reviewIds.push(visit.id);
		else if (snap.client_exempt && !jobSnap?.client_exempt) exemptIds.push(visit.id);
		else if (basis && jobBasis && !sameBasis(basis, jobBasis)) {
			const entry = bySource.get(basis.key) ?? { ids: [], phrase: basis.phrase };
			entry.ids.push(visit.id);
			bySource.set(basis.key, entry);
		}
	}

	const differs: JobTaxSummary["differs"] = [];
	if (reviewIds.length)
		differs.push({
			visitId: reviewIds[0],
			text: `${count(reviewIds.length, "visit needs", "visits need")} tax review`,
		});
	if (exemptIds.length)
		differs.push({
			visitId: exemptIds[0],
			text:
				exemptIds.length === 1
					? "1 visit's client is tax exempt"
					: `${exemptIds.length} visits' clients are tax exempt`,
		});
	for (const { ids, phrase } of bySource.values())
		differs.push({
			visitId: ids[0],
			text: `${count(ids.length, "visit is", "visits are")} taxed with ${phrase}; the job uses ${jobBasis?.phrase}`,
		});

	return {
		wholeJobTaxCents,
		invoiced,
		notYetInvoicedCents: Math.max(0, wholeJobTaxCents - invoicedCents),
		differs,
	};
}
