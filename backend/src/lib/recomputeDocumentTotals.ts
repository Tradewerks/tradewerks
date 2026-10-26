/**
 * recomputeDocumentTotals.ts
 *
 * Shared tax recomputation for quotes, invoices, jobs and job visits — one path, so the four
 * cannot drift. Locked snapshots never recompute (and so never resolve a rate).
 */
import { Prisma } from "../../generated/prisma/client.js";
import { calculateDocumentTax, centsToDollars } from "../services/taxEngine.js";
import { invoiceServiceLocation } from "../services/tax/address.js";
import {
	readTaxSnapshot,
	roundingFor,
	toSnapshotV2,
	type TaxSnapshotV2,
} from "../services/tax/snapshot.js";
import { applyQbAdoption, QB_UNAVAILABLE_REASON } from "../services/qb/qbAdoption.js";
import { loadTaxableItem } from "../services/qb/qbTaxableItem.js";
import {
	buildInvoicePayload,
	invoiceForQBInclude,
	qbPushFingerprint,
} from "../services/qb/qbInvoiceTax.js";
import {
	keptRateRef,
	planDocumentTax,
	shouldResetAck,
	type KeptRateRef,
} from "./documentTaxPlan.js";
import {
	resolveLineItemTaxInputs,
	type DocumentLineItemRaw,
} from "./taxHelpers.js";

export type DocumentModel = "invoice" | "quote" | "job" | "job_visit";

/**
 * The recompute either ran, or was skipped for a reason the caller may need
 * to act on: `not_found` means the id resolves to nothing (a lock caller
 * must not treat that as a successful no-op), `locked` means the snapshot is
 * already frozen (a legitimate no-op).
 */
export type RecomputeResult =
	| { ok: true }
	| { ok: false; reason: "not_found" | "locked" };

type LineRow = {
	id: string;
	total: Prisma.Decimal | number;
	tax_group_id: string | null;
	taxable: boolean;
};

interface PrevTaxState {
	tax_source: string | null;
	tax_needs_review: boolean;
	tax_resolution_id: string | null;
	review_reason: string | null;
}

export interface RecomputeOptions {
	/** Tax ungrouped lines at the org default even if the document carries a kept address rate. */
	dropKeptRate?: boolean;
}

interface LoadedDoc {
	client_id: string;
	tax_snapshot: Prisma.JsonValue | null;
	discount_type: string | null;
	discount_value: Prisma.Decimal | null;
	amount_paid?: Prisma.Decimal | number | null;
	/** Invoice only. Non-null marks this row as an adjustment document. */
	adjusts_invoice_id?: string | null;
	/** Null for job_visit, which has no source columns of its own. */
	prev: PrevTaxState | null;
	/** The document this one was made from: job ← quote, visit ← job, invoice ← first linked job. */
	parent_snapshot: Prisma.JsonValue | null;
	parent_prev: KeptPrev | null;
	address: string | null;
	coords: unknown;
	line_items: LineRow[];
}

const LINE_SELECT = {
	select: {
		id: true,
		total: true,
		tax_group_id: true,
		taxable: true,
	},
} as const;
const TAX_INPUTS = {
	tax_snapshot: true,
	discount_type: true,
	discount_value: true,
} as const;
const PREV = { tax_source: true, tax_needs_review: true, tax_resolution_id: true } as const;
const PARENT = { tax_snapshot: true, tax_needs_review: true, tax_resolution_id: true } as const;

type KeptPrev = { tax_needs_review: boolean; tax_resolution_id: string | null };
type ParentRow = { tax_snapshot: Prisma.JsonValue | null } & KeptPrev;

function parentOf(p: ParentRow | null | undefined) {
	return {
		parent_snapshot: p?.tax_snapshot ?? null,
		parent_prev: p
			? { tax_needs_review: p.tax_needs_review, tax_resolution_id: p.tax_resolution_id }
			: null,
	};
}

/** The previous review reason lives only in the v2 snapshot; it gates ack resets on a reason change. */
function prevTaxState(d: {
	tax_source: string | null;
	tax_needs_review: boolean;
	tax_resolution_id: string | null;
	tax_snapshot: Prisma.JsonValue | null;
}): PrevTaxState {
	const snap = readTaxSnapshot(d.tax_snapshot);
	return {
		tax_source: d.tax_source,
		tax_needs_review: d.tax_needs_review,
		tax_resolution_id: d.tax_resolution_id,
		review_reason:
			snap?.version === 2 ? (snap.review_reason ?? null) : null,
	};
}

/** State an invoice draft carries from a QuickBooks confirm. */
interface QbPrior {
	adoption: { qbTaxCents: number; fingerprint: string } | null;
	/** A review raised by confirm (delta or unavailable), not by the resolver. */
	reviewReason: string | null;
}

function qbPrior(raw: Prisma.JsonValue | null): QbPrior | null {
	const snap = readTaxSnapshot(raw);
	if (snap?.version !== 2) return null;
	const adoption =
		typeof snap.qb_tax_cents === "number" && typeof snap.qb_fingerprint === "string"
			? { qbTaxCents: snap.qb_tax_cents, fingerprint: snap.qb_fingerprint }
			: null;
	const reviewReason = snap.qb_review === true ? (snap.review_reason ?? null) : null;
	return adoption || reviewReason ? { adoption, reviewReason } : null;
}

/**
 * Hash of what the next push would send, given the totals this recompute is about to write.
 * Exported for the seam test that holds it equal to doPushInvoice's hash.
 */
export async function currentQbFingerprint(
	tx: Prisma.TransactionClient,
	invoiceId: string,
	organizationId: string,
	snapshot: TaxSnapshotV2,
	discountAmount: number,
): Promise<string | null> {
	const org = await tx.organization.findUnique({
		where: { id: organizationId },
		select: { qb_realm_id: true },
	});
	const inv = await tx.invoice.findFirst({
		where: { id: invoiceId, organization_id: organizationId },
		include: invoiceForQBInclude(org?.qb_realm_id ?? ""),
	});
	if (!inv) return null;
	const withSnapshot = { ...inv, tax_snapshot: snapshot, discount_amount: discountAmount };
	// An adoption only exists for a push made under AST, where the push sends the taxable
	// stand-in; loading it the same way keeps the hashes equal.
	const taxableItem = await loadTaxableItem(tx, organizationId, org?.qb_realm_id ?? "");
	const { lines, shipAddr, clientExempt } = buildInvoicePayload(withSnapshot, taxableItem);
	return qbPushFingerprint(lines, shipAddr, clientExempt);
}

/**
 * A document made from a kept-rate one inherits the rate until it has a snapshot of its own;
 * otherwise a kept-rate job would invoice at the default group. An adjustment inherits from the
 * invoice it adjusts instead (planDocumentTax).
 */
function docKeptRate(doc: LoadedDoc): KeptRateRef | null {
	if (doc.tax_snapshot != null) {
		return keptRateRef(
			doc.tax_snapshot,
			doc.prev
				? {
						tax_needs_review: doc.prev.tax_needs_review,
						tax_resolution_id: doc.prev.tax_resolution_id,
					}
				: null,
		);
	}
	if (doc.adjusts_invoice_id) return null;
	return keptRateRef(doc.parent_snapshot, doc.parent_prev);
}

/**
 * A job that holds a kept rate is taxed server-side in manual mode, as in auto mode. A quote
 * answers for the job about to be made from it; an invoice answers as recompute will tax it.
 */
export async function holdsKeptRate(
	model: "job" | "quote" | "invoice",
	id: string,
	tx: Prisma.TransactionClient,
): Promise<boolean> {
	if (model === "invoice") {
		const doc = await loadDocument("invoice", id, tx);
		return doc != null && docKeptRate(doc) != null;
	}
	if (model === "quote") {
		const quote = await tx.quote.findFirst({ where: { id }, select: { tax_snapshot: true } });
		return keptRateRef(quote?.tax_snapshot ?? null, null) != null;
	}
	const job = await tx.job.findFirst({
		where: { id },
		select: { tax_snapshot: true, quote: { select: { tax_snapshot: true } } },
	});
	if (!job) return false;
	return keptRateRef(job.tax_snapshot ?? job.quote?.tax_snapshot ?? null, null) != null;
}

async function loadDocument(
	model: DocumentModel,
	documentId: string,
	tx: Prisma.TransactionClient,
): Promise<LoadedDoc | null> {
	if (model === "invoice") {
		const inv = await tx.invoice.findFirst({
			where: { id: documentId },
			select: {
				client_id: true,
				...TAX_INPUTS,
				...PREV,
				amount_paid: true,
				adjusts_invoice_id: true,
				line_items: LINE_SELECT,
				// Invoices have no address of their own; same ordering as the QB push (qbInvoices.ts).
				jobs: {
					take: 1,
					orderBy: { job: { created_at: "asc" } },
					select: {
						job: {
							select: {
								address: true,
								coords: true,
								...PARENT,
							},
						},
					},
				},
				client: { select: { address: true, coords: true } },
			},
		});
		if (!inv) return null;
		const location = invoiceServiceLocation(inv.jobs[0]?.job, inv.client);
		return {
			client_id: inv.client_id,
			tax_snapshot: inv.tax_snapshot,
			discount_type: inv.discount_type,
			discount_value: inv.discount_value,
			amount_paid: inv.amount_paid,
			adjusts_invoice_id: inv.adjusts_invoice_id,
			prev: prevTaxState(inv),
			...parentOf(inv.jobs[0]?.job),
			address: location.address,
			coords: location.coords,
			line_items: inv.line_items,
		};
	}
	if (model === "quote" || model === "job") {
		const select = {
			client_id: true,
			...TAX_INPUTS,
			...PREV,
			address: true,
			coords: true,
			line_items: LINE_SELECT,
		} as const;
		const d =
			model === "quote"
				? await tx.quote.findFirst({
						where: { id: documentId },
						select,
					})
				: await tx.job.findFirst({
						where: { id: documentId },
						select: { ...select, quote: { select: PARENT } },
					});
		if (!d) return null;
		return {
			client_id: d.client_id,
			tax_snapshot: d.tax_snapshot,
			discount_type: d.discount_type,
			discount_value: d.discount_value,
			prev: prevTaxState(d),
			...parentOf("quote" in d ? (d.quote as ParentRow | null) : null),
			address: d.address,
			coords: d.coords,
			line_items: d.line_items,
		};
	}
	const visit = await tx.job_visit.findFirst({
		where: { id: documentId },
		select: {
			...TAX_INPUTS,
			line_items: LINE_SELECT,
			job: {
				select: {
					client_id: true,
					address: true,
					coords: true,
					...PARENT,
					quote: { select: PARENT },
				},
			},
		},
	});
	if (!visit) return null;
	// Same lookup order as holdsKeptRate: the job's snapshot, else the quote it came from.
	const parent: ParentRow | null =
		visit.job.tax_snapshot != null ? visit.job : (visit.job.quote ?? visit.job);
	return {
		client_id: visit.job.client_id,
		tax_snapshot: visit.tax_snapshot,
		discount_type: visit.discount_type,
		discount_value: visit.discount_value,
		prev: null,
		...parentOf(parent),
		address: visit.job.address,
		coords: visit.job.coords,
		line_items: visit.line_items,
	};
}

/**
 * Recompute tax/discount/total fields for any document model.
 *
 * @param lockedAt When provided, the snapshot is locked with this timestamp, and the rate is
 *                 re-resolved if its resolution is expired or older than 7 days.
 */
export async function recomputeDocumentTotals(
	model: DocumentModel,
	documentId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	lockedAt?: Date,
	opts?: RecomputeOptions,
): Promise<RecomputeResult> {
	const doc = await loadDocument(model, documentId, tx);
	if (!doc) return { ok: false, reason: "not_found" };
	if (
		(model === "invoice" || model === "quote") &&
		doc.tax_snapshot != null
	) {
		const snap = doc.tax_snapshot as { locked_at?: string };
		// "draft" = unlocked (recompute freely); ISO string = locked (skip).
		if (snap.locked_at !== "draft") return { ok: false, reason: "locked" };
	}

	const rawItems: DocumentLineItemRaw[] = doc.line_items.map((li) => ({
		id: li.id,
		total: Number(li.total),
		tax_group_id: li.tax_group_id,
		taxable: li.taxable,
	}));

	const plan = await planDocumentTax({
		organizationId,
		clientId: doc.client_id,
		lines: rawItems,
		address: doc.address,
		coords: doc.coords,
		lockedAt,
		adjustsInvoiceId: doc.adjusts_invoice_id ?? null,
		cacheOnly: model === "job_visit",
		kept: opts?.dropKeptRate ? null : docKeptRate(doc),
		tx,
	});
	const { decision } = plan;

	const { inputs, clientExempt } = await resolveLineItemTaxInputs(
		rawItems,
		doc.client_id,
		organizationId,
		tx,
		{ client: plan.client, defaultGroup: plan.defaultGroup },
	);

	// A credit reverses tax with the rounding the original charged it with; half-up on a
	// line_floor original could refund a cent or two that was never collected.
	const rounding =
		doc.tax_snapshot == null && doc.adjusts_invoice_id
			? roundingFor(
					(
						await tx.invoice.findFirst({
							where: { id: doc.adjusts_invoice_id, organization_id: organizationId },
							select: { tax_snapshot: true },
						})
					)?.tax_snapshot,
				)
			: roundingFor(doc.tax_snapshot);
	const taxOutput = calculateDocumentTax(
		{
			line_items: inputs,
			discount_type: (doc.discount_type as "percent" | "amount") ?? null,
			discount_value: doc.discount_value
				? Number(doc.discount_value)
				: null,
		},
		clientExempt,
		lockedAt,
		rounding,
	);

	const inputMap = new Map(inputs.map((i) => [i.id, i]));
	// `any`: 4-branch ternary over incompatible Prisma update types; each branch is type-safe.
	const lineItemUpdate: (id: string, data: any) => Promise<any> =
		model === "invoice"
			? (id, data) => tx.invoice_line_item.update({ where: { id }, data })
			: model === "job"
				? (id, data) => tx.job_line_item.update({ where: { id }, data })
				: model === "job_visit"
					? (id, data) =>
							tx.job_visit_line_item.update({
								where: { id },
								data,
							})
					: (id, data) =>
							tx.quote_line_item.update({ where: { id }, data });

	await Promise.all(
		rawItems.map((li) => {
			const resolvedInput = inputMap.get(li.id);
			return lineItemUpdate(li.id, {
				tax_amount: centsToDollars(
					taxOutput.line_item_tax_amounts[li.id] ?? 0,
				),
				// `taxable` is not written: an exempt client resolves every line to false as a
				// tax input, and storing that would outlive the exemption.
				// Auto mode never writes the default onto the line: a rate-set id is not a
				// tax_group, and a written default would read as a dispatcher's choice later.
				tax_group_id: plan.stampDefaults
					? (resolvedInput?.tax_group?.id ?? li.tax_group_id ?? null)
					: li.tax_group_id,
			});
		}),
	);

	const subtotal = centsToDollars(taxOutput.subtotal_cents);
	const taxAmount = centsToDollars(taxOutput.total_tax_cents);
	const discountAmount = centsToDollars(taxOutput.discount_cents);
	const total = centsToDollars(taxOutput.total_cents);
	let snapshot = toSnapshotV2(taxOutput.snapshot, {
		source: decision.source,
		rate_set_id: decision.rate_set_id,
		review_reason: decision.review_reason,
		sourcing: decision.sourcing,
		rounding,
		kept_from_auto: decision.kept_from_auto,
	});

	// An adopted QuickBooks figure stands while what QuickBooks taxed is unchanged.
	const qb = model === "invoice" ? qbPrior(doc.tax_snapshot) : null;
	let keptAdoption: QbPrior["adoption"] = null;
	if (qb?.adoption) {
		const fresh = await currentQbFingerprint(
			tx,
			documentId,
			organizationId,
			snapshot,
			discountAmount,
		);
		if (fresh === qb.adoption.fingerprint) keptAdoption = qb.adoption;
	}
	const carriedQbReview =
		qb?.reviewReason && (keptAdoption || qb.reviewReason === QB_UNAVAILABLE_REASON)
			? qb.reviewReason
			: null;
	if (carriedQbReview) {
		snapshot = { ...snapshot, review_reason: carriedQbReview, qb_review: true };
	}

	const sharedData = {
		subtotal,
		tax_rate: taxOutput.effective_rate,
		tax_amount: taxAmount,
		discount_amount: discountAmount,
		total,
		// Double cast: Prisma.InputJsonValue index sig incompatible with named type.
		tax_snapshot: snapshot as unknown as Prisma.InputJsonValue,
	};
	// The stored source reads qb_ast while adopted; a kept adoption judges the ack on the review alone.
	const ackPrev =
		doc.prev && keptAdoption ? { ...doc.prev, tax_source: decision.source } : doc.prev;
	const sourceData = ackPrev
		? {
				tax_source: decision.source,
				tax_resolution_id: decision.resolution_id,
				tax_needs_review: carriedQbReview ? true : decision.needs_review,
				...(!carriedQbReview && shouldResetAck(ackPrev, decision)
					? { tax_review_ack_by: null, tax_review_ack_at: null }
					: {}),
			}
		: {};

	if (model === "invoice") {
		// An adjustment document may be a credit, and a credit's balance is
		// genuinely negative — the organisation owes it back. Flooring it at
		// zero made every credit invisible to receivables (which filter on a
		// non-zero balance), so AR kept reporting the original's full amount
		// while the revenue reports had already netted the credit.
		//
		// The floor stays for ordinary invoices: there a balance below zero
		// means over-payment, which belongs on the payment record rather than
		// turning the invoice itself into a liability.
		const isAdjustment = doc.adjusts_invoice_id != null;
		const rawBalance = total - Number(doc.amount_paid ?? 0);
		const balanceDue = isAdjustment ? rawBalance : Math.max(0, rawBalance);
		await tx.invoice.update({
			where: { id: documentId },
			data: { ...sharedData, ...sourceData, balance_due: balanceDue },
		});
		if (keptAdoption) {
			await applyQbAdoption(tx, documentId, organizationId, keptAdoption, {
				needsReview: decision.needs_review,
				reason: decision.review_reason ?? null,
			});
		}
	} else if (model === "quote") {
		await tx.quote.update({
			where: { id: documentId },
			data: { ...sharedData, ...sourceData },
		});
	} else if (model === "job") {
		const { total: calculatedTotal, ...jobData } = sharedData;
		await tx.job.update({
			where: { id: documentId },
			data: {
				...jobData,
				...sourceData,
				estimated_total: calculatedTotal,
			},
		});
	} else {
		await tx.job_visit.update({
			where: { id: documentId },
			data: sharedData,
		});
	}

	return { ok: true };
}

export async function recomputeJobTotals(
	jobId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
): Promise<RecomputeResult> {
	return recomputeDocumentTotals("job", jobId, organizationId, tx);
}

export async function recomputeVisitTotals(
	visitId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
): Promise<RecomputeResult> {
	return recomputeDocumentTotals("job_visit", visitId, organizationId, tx);
}

type SnapshotModel = Extract<DocumentModel, "invoice" | "quote">;

/**
 * Lock the tax snapshot on an invoice or quote when it transitions to Issued.
 * Only valid for "invoice" and "quote" models — job/visit snapshots are never
 * locked (they recompute freely on every save).
 * If the snapshot is already locked, this is a no-op.
 */
export async function lockDocumentTaxSnapshot(
	model: SnapshotModel,
	documentId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	lockedAt: Date = new Date(),
): Promise<void> {
	const result = await recomputeDocumentTotals(
		model,
		documentId,
		organizationId,
		tx,
		lockedAt,
	);
	// A missing document means the caller handed us an id that resolves to
	// nothing; silently skipping the lock would let createAdjustmentInvoice
	// write a zero-tax credit and report success. An already-locked
	// snapshot is a legitimate no-op.
	if (!result.ok && result.reason === "not_found") {
		throw new Error(
			`Cannot lock tax snapshot: ${model} ${documentId} not found`,
		);
	}
}
