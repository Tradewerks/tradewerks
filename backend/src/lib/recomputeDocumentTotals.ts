/**
 * recomputeDocumentTotals.ts
 *
 * Shared tax recomputation logic for quotes, invoices, jobs, and job visits.
 * Single source of truth: quotes, invoices, jobs, and job visits all call
 * this instead of each keeping its own near-identical recompute function that
 * could drift out of sync with the others.
 */
import { Prisma } from "../../generated/prisma/client.js";
import { calculateDocumentTax, centsToDollars } from "../services/taxEngine.js";
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

/**
 * Recompute tax/discount/total fields for any document model.
 *
 * - If the document does not exist, returns `false`.
 * - If `tax_snapshot` is already set (locked), skips and returns `false`.
 * - Otherwise, updates all line item `tax_amount` fields and the document
 *   totals, then returns `true`.
 *
 * Invoice-only: also updates `balance_due`.
 *
 * @param model         "invoice" | "quote" | "job" | "job_visit"
 * @param documentId    Primary key of the document
 * @param organizationId  Required for org-scoped tax group resolution
 * @param tx            Prisma transaction client — caller must wrap in $transaction
 * @param lockedAt      When provided, the tax snapshot is locked with this timestamp
 */
export async function recomputeDocumentTotals(
	model: DocumentModel,
	documentId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	lockedAt?: Date,
): Promise<RecomputeResult> {
	// ── 1. Fetch document fields needed for tax calculation ──────────────────
	const lineItemSelect = {
		select: {
			id: true,
			total: true,
			tax_group_id: true,
			taxable: true,
		},
	};

	// Fetch from the correct model, including amount_paid for invoices
	let doc: {
		client_id: string;
		tax_snapshot?: Prisma.JsonValue | null;
		discount_type: string | null;
		discount_value: Prisma.Decimal | null;
		amount_paid?: Prisma.Decimal | null;
		/** Invoice only. Non-null marks this row as an adjustment document. */
		adjusts_invoice_id?: string | null;
		line_items: Array<{
			id: string;
			total: Prisma.Decimal;
			tax_group_id: string | null;
			taxable: boolean;
		}>;
	} | null = null;

	if (model === "invoice") {
		doc = await tx.invoice.findFirst({
			where: { id: documentId },
			select: {
				client_id: true,
				tax_snapshot: true,
				discount_type: true,
				discount_value: true,
				amount_paid: true,
				adjusts_invoice_id: true,
				line_items: lineItemSelect,
			},
		});
	} else if (model === "quote") {
		doc = await tx.quote.findFirst({
			where: { id: documentId },
			select: {
				client_id: true,
				tax_snapshot: true,
				discount_type: true,
				discount_value: true,
				line_items: lineItemSelect,
			},
		});
	} else if (model === "job") {
		const job = await tx.job.findFirst({
			where: { id: documentId },
			select: {
				client_id: true,
				tax_snapshot: true,
				discount_type: true,
				discount_value: true,
				line_items: lineItemSelect,
			},
		});
		doc = job ?? null;
	} else {
		// job_visit — client_id is on the parent job
		const visit = await tx.job_visit.findFirst({
			where: { id: documentId },
			select: {
				tax_snapshot: true,
				discount_type: true,
				discount_value: true,
				line_items: lineItemSelect,
				job: { select: { client_id: true } },
			},
		});
		doc = visit ? { ...visit, client_id: visit.job.client_id } : null;
	}

	if (!doc) return { ok: false, reason: "not_found" };
	if (
		(model === "invoice" || model === "quote") &&
		doc.tax_snapshot != null
	) {
		const snap = doc.tax_snapshot as { locked_at?: string };
		// "draft" = unlocked (recompute freely); ISO string = locked (skip).
		if (snap.locked_at !== "draft") return { ok: false, reason: "locked" };
	}

	// ── 2. Resolve tax inputs for each line item ─────────────────────────────
	const rawItems: DocumentLineItemRaw[] = doc.line_items.map((li) => ({
		id: li.id,
		total: Number(li.total),
		tax_group_id: li.tax_group_id,
		taxable: li.taxable,
	}));

	const { inputs, clientExempt } = await resolveLineItemTaxInputs(
		rawItems,
		doc.client_id,
		organizationId,
		tx,
	);

	// ── 3. Calculate tax ─────────────────────────────────────────────────────
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
	);

	// ── 4. Write per-line-item tax amounts ───────────────────────────────────
	const inputMap = new Map(inputs.map((i) => [i.id, i]));
	// `any`: 4-branch ternary over incompatible Prisma update types; each branch is type-safe.
	const lineItemUpdate: (id: string, data: any) => Promise<any> =
		model === "invoice"
			? (
					id: string,
					data: Parameters<
						typeof tx.invoice_line_item.update
					>[0]["data"],
				) => tx.invoice_line_item.update({ where: { id }, data })
			: model === "job"
				? (
						id: string,
						data: Parameters<
							typeof tx.job_line_item.update
						>[0]["data"],
					) => tx.job_line_item.update({ where: { id }, data })
				: model === "job_visit"
					? (
							id: string,
							data: Parameters<
								typeof tx.job_visit_line_item.update
							>[0]["data"],
						) =>
							tx.job_visit_line_item.update({
								where: { id },
								data,
							})
					: (
							id: string,
							data: Parameters<
								typeof tx.quote_line_item.update
							>[0]["data"],
						) => tx.quote_line_item.update({ where: { id }, data });

	// Parallelise all updates — they are independent within the transaction.
	await Promise.all(
		rawItems.map((li) => {
			const taxAmountCents = taxOutput.line_item_tax_amounts[li.id] ?? 0;
			const resolvedInput = inputMap.get(li.id);
			return lineItemUpdate(li.id, {
				tax_amount: centsToDollars(taxAmountCents),
				taxable: resolvedInput?.taxable ?? li.taxable,
				tax_group_id:
					resolvedInput?.tax_group?.id ?? li.tax_group_id ?? null,
			});
		}),
	);

	// ── 5. Write document-level totals ───────────────────────────────────────
	const subtotal = centsToDollars(taxOutput.subtotal_cents);
	const taxAmount = centsToDollars(taxOutput.total_tax_cents);
	const discountAmount = centsToDollars(taxOutput.discount_cents);
	const total = centsToDollars(taxOutput.total_cents);

	const sharedData = {
		subtotal,
		tax_rate: taxOutput.effective_rate,
		tax_amount: taxAmount,
		discount_amount: discountAmount,
		total,
		// locked_at: "draft" while unlocked, ISO string once issued.
		// Double cast: Prisma.InputJsonValue index sig incompatible with named type.
		tax_snapshot: taxOutput.snapshot as unknown as Prisma.InputJsonValue,
	};

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
			data: { ...sharedData, balance_due: balanceDue },
		});
	} else if (model === "quote") {
		await tx.quote.update({ where: { id: documentId }, data: sharedData });
	} else if (model === "job") {
		const { total: calculatedTotal, ...jobDataWithSnapshot } = sharedData;
		await tx.job.update({
			where: { id: documentId },
			data: { ...jobDataWithSnapshot, estimated_total: calculatedTotal },
		});
	} else {
		// job_visit
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
	// write a zero-tax credit and report success (DW-32). An already-locked
	// snapshot is a legitimate no-op.
	if (!result.ok && result.reason === "not_found") {
		throw new Error(
			`Cannot lock tax snapshot: ${model} ${documentId} not found`,
		);
	}
}
