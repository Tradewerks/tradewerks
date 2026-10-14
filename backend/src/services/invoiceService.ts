import { getScopedDb } from "../lib/context.js";
import { assertInventoryItemsInOrg } from "../lib/inventory.js";
import { Prisma } from "../../generated/prisma/client.js";
import { generateInvoiceNumber } from "../db.js";
import {
	dollarsToCents,
	centsToDollars,
} from "./taxEngine.js";
import {
	type DocumentLineItemRaw,
	resolveLineItemTaxInputs,
} from "../lib/taxHelpers.js";
import {
	recomputeDocumentTotals,
	lockDocumentTaxSnapshot,
	type RecomputeResult,
} from "../lib/recomputeDocumentTotals.js";

// ============================================================================
// TYPES
// ============================================================================

export interface CreateInvoicePayload {
	client_id: string;
	recurring_plan_id?: string | null;
	issue_date?: Date | string | null;
	due_date?: Date | string | null;
	payment_terms_days?: number | null;
	subtotal?: number;
	tax_rate?: number;
	tax_amount?: number;             // advisory — service always recomputes
	discount_type?: "percent" | "amount" | null;
	discount_value?: number | null;
	discount_amount?: number | null; // advisory — service always recomputes
	total?: number;                  // advisory — service always recomputes
	memo?: string | null;
	internal_notes?: string | null;
	line_items?: Array<{
		name: string;
		description?: string | null;
		quantity: number;
		unit_price: number;
		total?: number;
		item_type?: "labor" | "material" | "equipment" | "other" | null;
		sort_order?: number;
		source_job_id?: string | null;
		source_visit_id?: string | null;
		inventory_item_id?: string | null;
		tax_group_id?: string | null;
		taxable?: boolean;
	}>;
	job_ids?: string[];
	job_billings?: Array<{ job_id: string; billed_amount: number }>;
	visit_billings?: Array<{ visit_id: string; billed_amount: number }>;
}

// ============================================================================
// SHARED INCLUDE — exported so controller and other read paths can reuse
// ============================================================================

/**
 * How far up the chain an invoice can be backtracked: the job's own quote and
 * request. Spread into both join paths, which don't overlap — an invoice built
 * from visits alone has no `invoice_job` row, so its only route to a quote is
 * through each visit's parent job.
 */
const JOB_UPSTREAM_SELECT = {
	quote: {
		select: {
			id: true,
			quote_number: true,
			title: true,
			status: true,
			total: true,
			created_at: true,
		},
	},
	request: { select: { id: true, title: true, status: true, created_at: true } },
} as const;

export const invoiceInclude = {
	client: {
		select: {
			id: true,
			name: true,
			address: true,
			is_active: true,
			is_tax_exempt: true,
			tax_group_id: true,
			contacts: {
				where: { is_primary: true },
				include: {
					contact: {
						select: {
							id: true,
							name: true,
							email: true,
							phone: true,
						},
					},
				},
				take: 1,
			},
		},
	},
	created_by_dispatcher: {
		select: { id: true, name: true, email: true },
	},
	line_items: {
		orderBy: { sort_order: "asc" as const },
		include: {
			tax_group: { select: { name: true } },
		},
	},
	jobs: {
		include: {
			job: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
					...JOB_UPSTREAM_SELECT,
				},
			},
		},
	},
	visits: {
		include: {
			visit: {
				select: {
					id: true,
					scheduled_start_at: true,
					scheduled_end_at: true,
					status: true,
					job: {
						select: {
							id: true,
							job_number: true,
							name: true,
							// status, because VisitReference types this
							// job as a full JobReference.
							status: true,
							...JOB_UPSTREAM_SELECT,
						},
					},
				},
			},
		},
	},
	payments: {
		orderBy: { paid_at: "asc" as const },
		include: {
			recorded_by_dispatcher: {
				select: { id: true, name: true },
			},
			recorded_by_tech: {
				select: { id: true, name: true },
			},
		},
	},
	notes: {
		orderBy: { created_at: "desc" as const },
		include: {
			creator_tech: { select: { id: true, name: true, email: true } },
			creator_dispatcher: {
				select: { id: true, name: true, email: true },
			},
			last_editor_tech: { select: { id: true, name: true, email: true } },
			last_editor_dispatcher: {
				select: { id: true, name: true, email: true },
			},
		},
	},
	recurring_plan: {
		select: { id: true, name: true, status: true },
	},
	// Chain cross-references. The scalars alone cannot render "Adjusts
	// INV-1039" / "Adjusted by INV-1040" — the detail page needs the other
	// document's number, and "adjusted by" has no scalar at all.
	previous_invoice: { select: { id: true, invoice_number: true } },
	revised_invoice: { select: { id: true, invoice_number: true } },
	adjusts_invoice: { select: { id: true, invoice_number: true } },
	adjustments: {
		orderBy: { invoice_number: "asc" as const },
		select: { id: true, invoice_number: true },
	},
} satisfies Prisma.invoiceInclude;

// ============================================================================
// EXPORTED HELPERS — used by invoicesController
// ============================================================================

/** Recalculate amount_paid, balance_due, and status after any payment change. */
export async function syncInvoicePaymentTotals(
	invoiceId: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const [invoice, payments] = await Promise.all([
		tx.invoice.findFirst({
			where: { id: invoiceId },
			select: { total: true, status: true, adjusts_invoice_id: true },
		}),
		tx.invoice_payment.findMany({
			where: { invoice_id: invoiceId },
			select: { amount: true },
		}),
	]);

	if (!invoice) return;

	const total = Number(invoice.total);
	const amountPaid = payments.reduce((sum, p) => sum + Number(p.amount), 0);
	// Same rule as recomputeDocumentTotals: a credit adjustment's balance is
	// legitimately negative and must survive a payment resync, or the credit
	// silently disappears from receivables the next time anything touches the
	// document's payments. Ordinary invoices keep the floor.
	const rawBalance = total - amountPaid;
	const balanceDue =
		invoice.adjusts_invoice_id != null ? rawBalance : Math.max(0, rawBalance);

	// Only auto-transition to PartiallyPaid or Paid.
	// Disputed and Void are set manually and must not be overwritten here.
	// Draft/Issued/Sent/Viewed are preserved when payments are removed.
	let status = invoice.status;
	if (status !== "Disputed" && status !== "Void") {
		if (amountPaid <= 0) {
			if (status === "PartiallyPaid" || status === "Paid") {
				status = "Sent";
			}
		} else if (amountPaid >= total) {
			status = "Paid";
		} else {
			status = "PartiallyPaid";
		}
	}

	await tx.invoice.update({
		where: { id: invoiceId },
		data: {
			amount_paid: amountPaid,
			balance_due: balanceDue,
			status,
			...(status === "Paid" ? { paid_at: new Date() } : {}),
		},
	});
}

/**
 * How much has actually been paid on this invoice, summed from the payment
 * rows — the authoritative figure. `invoice.amount_paid` is a denormalisation
 * kept in step by syncInvoicePaymentTotals; a skipped or failed resync leaves
 * it stale, so the guards that would strand money on a dead document read this
 * instead of the column (matching the refund guard).
 */
export async function invoicePaidTotal(
	invoiceId: string,
	tx: Prisma.TransactionClient,
): Promise<number> {
	const agg = await tx.invoice_payment.aggregate({
		where: { invoice_id: invoiceId },
		_sum: { amount: true },
	});
	return Number(agg._sum.amount ?? 0);
}

/**
 * Recompute billed_amount for every invoice_job and invoice_visit row
 * linked to this invoice by summing the line items attributed to each
 * via source_job_id / source_visit_id.
 *
 * An adjustment carries part of the same job's billing, so profitability is
 * the sum across the original and every live adjustment written against it.
 * Callers may pass either end of the chain — the join rows always live on
 * the root (original) invoice.
 */
export async function syncBilledAmounts(
	invoiceId: string,
	tx: Prisma.TransactionClient,
): Promise<void> {
	const self = await tx.invoice.findFirst({
		where: { id: invoiceId },
		select: { id: true, adjusts_invoice_id: true },
	});
	// Throw rather than return quietly: every caller passes an id it created or
	// read inside the same transaction, so a miss means the chain root could
	// not be resolved — and returning would leave every linked job's
	// billed_amount stale with nothing to say the recompute never ran.
	if (!self) throw new Error(`Invoice ${invoiceId} not found`);

	const rootId = self.adjusts_invoice_id ?? self.id;
	// A voided adjustment credits nothing: left in the chain, it keeps reducing
	// the job's revenue after the credit itself is dead, and "void the
	// adjustment first" would leave profitability short by exactly that credit.
	const adjustments = await tx.invoice.findMany({
		where: { adjusts_invoice_id: rootId, status: { not: "Void" } },
		select: { id: true },
	});
	const chainIds = [rootId, ...adjustments.map((a) => a.id)];

	const lineItems = await tx.invoice_line_item.findMany({
		where: { invoice_id: { in: chainIds } },
		select: {
			total: true,
			source_job_id: true,
			source_visit_id: true,
		},
	});

	const linkedVisits = await tx.invoice_visit.findMany({
		where: { invoice_id: rootId },
		select: { visit_id: true },
	});

	for (const { visit_id } of linkedVisits) {
		const billedAmount = lineItems
			.filter((li) => li.source_visit_id === visit_id)
			.reduce((sum, li) => sum + Number(li.total), 0);

		await tx.invoice_visit.update({
			where: { invoice_id_visit_id: { invoice_id: rootId, visit_id } },
			data: { billed_amount: billedAmount },
		});
	}

	const linkedJobs = await tx.invoice_job.findMany({
		where: { invoice_id: rootId },
		select: { job_id: true },
	});

	for (const { job_id } of linkedJobs) {
		const billedAmount = lineItems
			.filter(
				(li) => li.source_job_id === job_id && li.source_visit_id === null,
			)
			.reduce((sum, li) => sum + Number(li.total), 0);

		await tx.invoice_job.update({
			where: { invoice_id_job_id: { invoice_id: rootId, job_id } },
			data: { billed_amount: billedAmount },
		});
	}
}

// ============================================================================
// EXPORTED HELPERS — tax recalculation
// ============================================================================

/**
 * Recompute tax totals for an invoice from its current line items.
 * Thin wrapper around the shared recomputeDocumentTotals helper.
 */
export async function recomputeInvoiceTotals(
	invoiceId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	lockedAt?: Date,
): Promise<RecomputeResult> {
	return recomputeDocumentTotals("invoice", invoiceId, organizationId, tx, lockedAt);
}

/**
 * Lock the tax snapshot on an invoice when it transitions to Issued.
 * If the snapshot is already set, this is a no-op.
 */
export async function lockInvoiceTaxSnapshot(
	invoiceId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	lockedAt: Date = new Date(),
): Promise<void> {
	await lockDocumentTaxSnapshot("invoice", invoiceId, organizationId, tx, lockedAt);
}

// ============================================================================
// MAIN: createInvoiceRecord
// ============================================================================

export async function createInvoiceRecord(
	payload: CreateInvoicePayload,
	organizationId: string,
	createdByDispatcherId?: string | null,
	existingTx?: Prisma.TransactionClient,
) {
	const doWork = async (tx: Prisma.TransactionClient) => {
		// Validate client exists — select tax fields here so we don't need a second query below.
		const client = await tx.client.findFirst({
			where: { id: payload.client_id, organization_id: organizationId },
			select: { id: true, is_tax_exempt: true, tax_group_id: true },
		});
		if (!client) throw new Error("Client not found");

		// Validate recurring plan if provided
		if (payload.recurring_plan_id) {
			const plan = await tx.recurring_plan.findFirst({
				where: { id: payload.recurring_plan_id, organization_id: organizationId },
			});
			if (!plan) throw new Error("Recurring plan not found");
		}

		// Validate all linked jobs belong to this client and org
		const allJobIds = [
			...(payload.job_ids ?? []),
			...(payload.job_billings?.map((jb) => jb.job_id) ?? []),
		];
		const uniqueJobIds = [...new Set(allJobIds)];

		if (uniqueJobIds.length > 0) {
			const jobs = await tx.job.findMany({
				where: { id: { in: uniqueJobIds }, organization_id: organizationId },
				select: { id: true, client_id: true },
			});
			if (jobs.length !== uniqueJobIds.length) {
				throw new Error("One or more jobs not found");
			}
			const wrongClient = jobs.find((j) => j.client_id !== payload.client_id);
			if (wrongClient) {
				throw new Error("All linked jobs must belong to the same client");
			}
		}

		// Validate all linked visits belong to this org (via parent job)
		const allVisitIds = payload.visit_billings?.map((vb) => vb.visit_id) ?? [];
		if (allVisitIds.length > 0) {
			const visits = await tx.job_visit.findMany({
				where: {
					id: { in: allVisitIds },
					job: { organization_id: organizationId },
				},
				select: {
					id: true,
					job: { select: { client_id: true } },
				},
			});
			if (visits.length !== allVisitIds.length) {
				throw new Error("One or more visits not found");
			}
			const wrongVisitClient = visits.find(
				(v) => v.job.client_id !== payload.client_id,
			);
			if (wrongVisitClient) {
				throw new Error("All linked visits must belong to the same client");
			}
		}

		// Compute line item totals (needed for discount calculation before DB write)
		const lineItemsForTax = (payload.line_items ?? []).map((item, idx) => ({
			// Temp id — replaced after DB create, but we need stable keys for the map
			id: `_tmp_${idx}`,
			total: item.total !== undefined ? item.total : item.quantity * item.unit_price,
			tax_group_id: item.tax_group_id ?? null,
			taxable: item.taxable !== undefined ? item.taxable : true,
		}));

		// client already fetched above with tax fields selected — no second query needed.
		const clientExempt = client.is_tax_exempt;

		// Preliminary subtotal and discount via inline arithmetic — avoid calling the full
		// tax engine here because all tax_group lookups would be null anyway (line items
		// don't exist in the DB yet). The engine is called properly after line items are created.
		const subtotal_cents = lineItemsForTax.reduce((s, li) => s + dollarsToCents(li.total), 0);
		const rawDiscount_cents = (() => {
			const v = payload.discount_value ?? 0;
			if (!payload.discount_type || !v) return 0;
			return payload.discount_type === "percent"
				? Math.floor(subtotal_cents * (v / 100))
				: dollarsToCents(v);
		})();
		const discount_cents = Math.min(Math.max(rawDiscount_cents, 0), subtotal_cents);

		const subtotal = centsToDollars(subtotal_cents);
		const discountAmount = centsToDollars(discount_cents);
		// Tax amount will be recomputed properly after line items exist; use 0 for now
		const taxAmount = 0;
		const total = centsToDollars(subtotal_cents - discount_cents);

		const invoiceNumber = await generateInvoiceNumber(tx, organizationId);

		// Calculate due_date from payment_terms_days if due_date not provided
		let dueDate = payload.due_date;
		if (!dueDate && payload.payment_terms_days) {
			const base = payload.issue_date ?? new Date();
			dueDate = new Date(base);
			dueDate.setDate(dueDate.getDate() + payload.payment_terms_days);
		}

		const invoice = await tx.invoice.create({
			data: {
				organization_id: organizationId,
				invoice_number: invoiceNumber,
				client_id: payload.client_id,
				recurring_plan_id: payload.recurring_plan_id ?? null,
				status: "Draft",
				...(payload.issue_date !== undefined && { issue_date: payload.issue_date }),
				due_date: dueDate ?? null,
				payment_terms_days: payload.payment_terms_days ?? null,
				subtotal,
				tax_rate: 0, // legacy field — kept for schema compat; actual tax is per-line-item
				tax_amount: taxAmount,
				discount_type: payload.discount_type ?? null,
				discount_value: payload.discount_value ?? null,
				discount_amount: discountAmount,
				total,
				amount_paid: 0,
				balance_due: total,
				memo: payload.memo ?? null,
				internal_notes: payload.internal_notes ?? null,
				created_by_dispatcher_id: createdByDispatcherId ?? null,
			},
		});

		// Create line items
		if (payload.line_items && payload.line_items.length > 0) {
			// Thrown, matching the "Client not found" style above: this function's
			// callers surface Error.message.
			await assertInventoryItemsInOrg(
				tx,
				organizationId,
				payload.line_items.map((li) => li.inventory_item_id),
			);
			await tx.invoice_line_item.createMany({
				data: payload.line_items.map((item, idx) => ({
					invoice_id: invoice.id,
					name: item.name,
					description: item.description ?? null,
					quantity: item.quantity,
					unit_price: item.unit_price,
					total:
						item.total !== undefined
							? item.total
							: item.quantity * item.unit_price,
					item_type: item.item_type ?? null,
					sort_order: item.sort_order ?? idx,
					source_job_id: item.source_job_id ?? null,
					source_visit_id: item.source_visit_id ?? null,
					inventory_item_id: item.inventory_item_id ?? null,
					tax_group_id: item.tax_group_id ?? null,
					taxable: item.taxable !== undefined ? item.taxable : true,
				})),
			});

			// Recompute invoice totals using taxEngine now that line items exist with real IDs
			await recomputeInvoiceTotals(invoice.id, organizationId, tx);
		}

		// Link jobs (traceability-only — no billed_amount)
		if (payload.job_ids && payload.job_ids.length > 0) {
			const billedJobIds = new Set(
				payload.job_billings?.map((jb) => jb.job_id) ?? [],
			);
			const tracingOnlyJobIds = payload.job_ids.filter(
				(id) => !billedJobIds.has(id),
			);
			if (tracingOnlyJobIds.length > 0) {
				await tx.invoice_job.createMany({
					data: tracingOnlyJobIds.map((job_id) => ({
						invoice_id: invoice.id,
						job_id,
						billed_amount: null,
					})),
				});
			}
		}

		// Link jobs with explicit billed_amount
		if (payload.job_billings && payload.job_billings.length > 0) {
			await tx.invoice_job.createMany({
				data: payload.job_billings.map((jb) => ({
					invoice_id: invoice.id,
					job_id: jb.job_id,
					billed_amount: jb.billed_amount,
				})),
			});
		}

		// Link visits with explicit billed_amount
		if (payload.visit_billings && payload.visit_billings.length > 0) {
			await tx.invoice_visit.createMany({
				data: payload.visit_billings.map((vb) => ({
					invoice_id: invoice.id,
					visit_id: vb.visit_id,
					billed_amount: vb.billed_amount,
				})),
			});
		}

		await tx.client.update({
			where: { id: payload.client_id },
			data: { last_activity: new Date() },
		});

		const created = await tx.invoice.findFirst({
			where: { id: invoice.id },
			include: invoiceInclude,
		});
		if (!created) throw new Error("Invoice not found after creation");
		return created;
	};

	if (existingTx) return doWork(existingTx);
	const sdb = getScopedDb(organizationId);
	// Prisma $extends changes the tx callback type; cast is safe — runtime methods are identical
	return sdb.$transaction((tx) => doWork(tx as unknown as Prisma.TransactionClient));
}
