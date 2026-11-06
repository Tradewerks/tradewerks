/**
 * The address-change prompt for documents taxed at a kept address rate (spec §1). An update that
 * moves the address of such a document must say which tax to use; a non-UI caller is refused
 * rather than having the document silently re-taxed.
 */
import { Prisma } from "../../generated/prisma/client.js";
import { ErrorCodes } from "../types/responses.js";
import { logActivity } from "../services/logger.js";
import { readTaxSnapshot } from "../services/tax/snapshot.js";
import { rateSetLabel } from "../services/tax/rateSet.js";
import { loadRateSet } from "../services/tax/taxResolver.js";
import { OPEN } from "./statusTransitions.js";
import { keptRateRef } from "./documentTaxPlan.js";
import { recomputeDocumentTotals } from "./recomputeDocumentTotals.js";
import type { AddressTaxChoice } from "./validate/addressTaxChoice.js";

export type { AddressTaxChoice } from "./validate/addressTaxChoice.js";
export { addressTaxChoiceSchema } from "./validate/addressTaxChoice.js";

export interface KeptFamilyMember {
	kind: "quote" | "job" | "job_visit" | "invoice";
	id: string;
	number: string | null;
}

export interface AddressTaxChoiceRefusal {
	err: string;
	code: typeof ErrorCodes.ADDRESS_TAX_CHOICE_REQUIRED;
	details: { rate_label: string; rate: number; documents: KeptFamilyMember[] };
}

export const isAddressTaxChoiceRefusal = (r: object): r is AddressTaxChoiceRefusal =>
	(r as { code?: unknown }).code === ErrorCodes.ADDRESS_TAX_CHOICE_REQUIRED;

export class AddressTaxChoiceError extends Error {}

const REFUSAL =
	"The address changed on a document taxed at a kept address rate. Choose which tax to use.";
const AUTO_SUFFIX = " (auto)";

type Snap = Prisma.JsonValue | null;

const unlocked = (s: Snap) => (s as { locked_at?: unknown } | null)?.locked_at === "draft";
const kept = (s: Snap) => keptRateRef(s, null) != null;

/** Mirrors recomputeDocumentTotals' inheritance: own snapshot first, else the parent's. */
const effective = (own: Snap, parent: Snap): Snap => own ?? parent;

/**
 * The address (or pin) really moves. An empty address is not a change: no update endpoint can
 * clear one (quotes and clients reject it, jobs ignore it).
 */
export function addressMoves(
	body: unknown,
	parsed: { address?: string | null; coords?: unknown },
	existing: { address: string | null; coords: unknown },
): boolean {
	const raw = (body ?? {}) as { coords?: unknown };
	if (parsed.address !== undefined && parsed.address !== existing.address) return true;
	if (raw.coords === undefined || parsed.coords === undefined) return false;
	const a = parsed.coords as { lat?: unknown; lon?: unknown } | null;
	const b = existing.coords as { lat?: unknown; lon?: unknown } | null;
	return Number(a?.lat) !== Number(b?.lat) || Number(a?.lon) !== Number(b?.lon);
}

export function addressTaxChoiceRefusal(family: {
	members: KeptFamilyMember[];
	rateLabel: string;
	rate: number;
}): AddressTaxChoiceRefusal {
	return {
		err: REFUSAL,
		code: ErrorCodes.ADDRESS_TAX_CHOICE_REQUIRED,
		details: { rate_label: family.rateLabel, rate: family.rate, documents: family.members },
	};
}

/** "La Crosse, WI" — the place of the kept group, never with the internal "(auto)" suffix. */
async function describeRate(snapshot: Snap): Promise<{ rateLabel: string; rate: number }> {
	const snap = readTaxSnapshot(snapshot);
	const rateSetId = snap?.version === 2 ? snap.rate_set_id : undefined;
	const set = rateSetId ? await loadRateSet(rateSetId) : null;
	if (set) {
		const label = rateSetLabel(set);
		return {
			rateLabel: label.endsWith(AUTO_SUFFIX) ? label.slice(0, -AUTO_SUFFIX.length) : label,
			rate: set.total_rate,
		};
	}
	const group = snap?.groups.find((g) => g.id === rateSetId || g.name.endsWith(AUTO_SUFFIX));
	if (!group) return { rateLabel: "the address", rate: 0 };
	return {
		rateLabel: group.name.endsWith(AUTO_SUFFIX)
			? group.name.slice(0, -AUTO_SUFFIX.length)
			: group.name,
		rate: group.rates.reduce((sum, r) => sum + r.rate, 0),
	};
}

/** The not-issued documents whose kept address rate an address edit on `root` would affect. */
export async function keptFamily(
	tx: Prisma.TransactionClient,
	orgId: string,
	root: { kind: "quote" | "job" | "client"; id: string },
): Promise<{ members: KeptFamilyMember[]; rateLabel: string; rate: number } | null> {
	const members: KeptFamilyMember[] = [];
	let firstKept: Snap = null;
	const add = (m: KeptFamilyMember, snap: Snap) => {
		members.push(m);
		firstKept ??= snap;
	};

	if (root.kind === "quote") {
		const quote = await tx.quote.findFirst({
			where: { id: root.id, organization_id: orgId },
			select: { id: true, quote_number: true, tax_snapshot: true },
		});
		if (quote && unlocked(quote.tax_snapshot) && kept(quote.tax_snapshot)) {
			add({ kind: "quote", id: quote.id, number: quote.quote_number }, quote.tax_snapshot);
		}
	} else if (root.kind === "job") {
		const job = await tx.job.findFirst({
			where: { id: root.id, organization_id: orgId },
			select: {
				id: true,
				job_number: true,
				status: true,
				tax_snapshot: true,
				quote: { select: { tax_snapshot: true } },
			},
		});
		if (!job) return null;
		const jobSnap = effective(job.tax_snapshot, job.quote?.tax_snapshot ?? null);
		// A completed or cancelled job keeps the tax it closed with, as its closed visits do.
		const jobOpen = !OPEN.notIn.includes(job.status as (typeof OPEN.notIn)[number]);
		if (jobOpen && kept(jobSnap)) add({ kind: "job", id: job.id, number: job.job_number }, jobSnap);

		const visits = await tx.job_visit.findMany({
			where: { job_id: job.id, status: OPEN },
			select: { id: true, tax_snapshot: true },
			orderBy: { scheduled_start_at: "asc" },
		});
		for (const v of visits) {
			const snap = effective(v.tax_snapshot, jobSnap);
			if (kept(snap)) add({ kind: "job_visit", id: v.id, number: null }, snap);
		}

		const invoices = await tx.invoice.findMany({
			where: {
				organization_id: orgId,
				status: "Draft",
				jobs: { some: { job_id: job.id } },
			},
			select: {
				id: true,
				invoice_number: true,
				tax_snapshot: true,
				adjusts_invoice_id: true,
				jobs: {
					take: 1,
					orderBy: { job: { created_at: "asc" } },
					select: { job_id: true },
				},
			},
			orderBy: { created_at: "asc" },
		});
		for (const inv of invoices) {
			// The invoice's address is its earliest linked job's; another job owns this one.
			if (inv.jobs[0]?.job_id !== job.id) continue;
			const snap =
				inv.tax_snapshot != null
					? unlocked(inv.tax_snapshot)
						? inv.tax_snapshot
						: null
					: inv.adjusts_invoice_id
						? null
						: job.tax_snapshot;
			if (kept(snap)) add({ kind: "invoice", id: inv.id, number: inv.invoice_number }, snap);
		}
	} else {
		const invoices = await tx.invoice.findMany({
			where: {
				organization_id: orgId,
				client_id: root.id,
				status: "Draft",
				jobs: { none: {} },
			},
			select: { id: true, invoice_number: true, tax_snapshot: true },
			orderBy: { created_at: "asc" },
		});
		for (const inv of invoices) {
			if (unlocked(inv.tax_snapshot) && kept(inv.tax_snapshot)) {
				add({ kind: "invoice", id: inv.id, number: inv.invoice_number }, inv.tax_snapshot);
			}
		}
	}

	if (members.length === 0) return null;
	return { members, ...(await describeRate(firstKept)) };
}

const LINE_MODEL = {
	quote: "quote_line_item",
	job: "job_line_item",
	job_visit: "job_visit_line_item",
	invoice: "invoice_line_item",
} as const;
const PARENT_KEY = {
	quote: "quote_id",
	job: "job_id",
	job_visit: "visit_id",
	invoice: "invoice_id",
} as const;

export const choiceActor = (context?: {
	techId?: string;
	dispatcherId?: string;
}): { type: "dispatcher" | "technician" | "system"; id?: string } => ({
	type: context?.techId ? "technician" : context?.dispatcherId ? "dispatcher" : "system",
	id: context?.techId || context?.dispatcherId,
});

/**
 * Applies the dispatcher's answer to every member and records it on each one's activity log.
 * A member whose snapshot locked since the family was read is skipped: not stamped, not logged.
 */
export async function applyAddressTaxChoice(
	tx: Prisma.TransactionClient,
	orgId: string,
	members: KeptFamilyMember[],
	choice: AddressTaxChoice,
	rateLabel: string,
	actor: { type: "dispatcher" | "technician" | "system"; id?: string },
): Promise<void> {
	let reason: string;
	let applied = members;
	if (choice === "keep") {
		reason = `Tax kept at ${rateLabel} rate after address change`;
	} else {
		let group: { id: string; name: string } | null = null;
		if (choice === "default") {
			const def = await tx.tax_group.findFirst({
				where: { organization_id: orgId, is_default: true, is_active: true },
				select: { id: true, name: true },
			});
			reason = `Tax moved to ${def?.name ?? "the default tax rate"} after address change`;
		} else {
			group = await tx.tax_group.findFirst({
				where: { id: choice.group_id, organization_id: orgId, is_active: true },
				select: { id: true, name: true },
			});
			if (!group) throw new AddressTaxChoiceError("Choose an active tax group");
			reason = `Tax moved to ${group.name} after address change`;
		}
		applied = [];
		for (const m of members) {
			// `any`: four line-item delegates with the same findMany/updateMany shape.
			const lines = (tx as any)[LINE_MODEL[m.kind]];
			let stamped: string[] = [];
			if (group) {
				const rows: { id: string }[] = await lines.findMany({
					where: { [PARENT_KEY[m.kind]]: m.id, taxable: true, tax_group_id: null },
					select: { id: true },
				});
				stamped = rows.map((r) => r.id);
				await lines.updateMany({
					where: { id: { in: stamped } },
					data: { tax_group_id: group.id },
				});
			}
			const result = await recomputeDocumentTotals(m.kind, m.id, orgId, tx, undefined, {
				dropKeptRate: true,
			});
			if (result.ok) {
				applied.push(m);
			} else if (stamped.length > 0) {
				await lines.updateMany({
					where: { id: { in: stamped } },
					data: { tax_group_id: null },
				});
			}
		}
	}

	for (const m of applied) {
		await logActivity({
			event_type: `${m.kind}.tax_address_choice`,
			action: "updated",
			entity_type: m.kind,
			entity_id: m.id,
			organization_id: orgId,
			actor_type: actor.type,
			actor_id: actor.id,
			reason,
		});
	}
}

/** Re-reads the family inside the write transaction, so a document issued since the gate is left alone. */
export async function applyAddressTaxChoiceToFamily(
	tx: Prisma.TransactionClient,
	orgId: string,
	root: { kind: "quote" | "job" | "client"; id: string },
	choice: AddressTaxChoice,
	actor: { type: "dispatcher" | "technician" | "system"; id?: string },
): Promise<void> {
	const family = await keptFamily(tx, orgId, root);
	if (!family) return;
	await applyAddressTaxChoice(tx, orgId, family.members, choice, family.rateLabel, actor);
}
