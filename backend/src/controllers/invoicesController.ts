import { ZodError } from "zod";
import { db } from "../db.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { findForeignInventoryItemIds, unknownInventoryItemsMessage } from "../lib/inventory.js";
import { resolveDocumentLineage } from "../lib/documentLineage.js";
import { formatCurrency } from "../lib/money.js";
import { isQBConnected, getOrgRealmId } from "../services/quickbooksService.js";
import { mirrorInvoiceVoidToQuickBooks, pushInvoice } from "../services/qb/qbInvoices.js"
import {
	createInvoiceSchema,
	updateInvoiceSchema,
	createInvoicePaymentSchema,
	createInvoiceNoteSchema,
	updateInvoiceNoteSchema,
	type CreateRefundInput,
} from "../lib/validate/invoices.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import {
	assertValidInvoiceTransition,
	DocumentRuleError,
	InvalidTransitionError,
	isInvoiceFinalizingTransition,
} from "../lib/statusTransitions.js";
import {
	voidBlockedByAdjustmentReason,
	voidBlockedByPaymentReason,
} from "../services/disputeAdapters.js";
import { openDisputeStatusChangeRefusal } from "../services/disputeService.js";
import { ErrorCodes, createSuccessResponse, createErrorResponse } from "../types/responses.js";
import {
	type CreateInvoicePayload,
	createInvoiceRecord,
	syncBilledAmounts,
	syncInvoicePaymentTotals,
	recomputeInvoiceTotals,
	lockInvoiceTaxSnapshot,
	invoiceInclude,
} from "../services/invoiceService.js";
import { logExternalSync } from "../services/qb/qbSyncLog.js";
import { pushPaymentToQB, deleteQBPayment } from "../services/qb/qbPayments.js"
import { notifyDispatchers } from "./notificationsController.js";

// ============================================================================
// INVOICE CRUD
// ============================================================================

export const getAllInvoices = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.invoice.findMany({
		include: invoiceInclude,
		orderBy: { created_at: "desc" },
	});
};

/**
 * The invoice without its revision-chain walk. The PDF renderer, the email
 * sender and the pre-send transition guard all call this and none read
 * `lineage`, so resolving the two recursive CTEs here made every send pay for
 * a value nobody uses — twice, on POST /:id/send. getInvoiceDetail adds it.
 */
export const getInvoiceById = async (id: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.invoice.findFirst({
		where: { id },
		include: invoiceInclude,
	});
};

/**
 * The job and visit rows a line names that the join tables do not.
 *
 * `source_job_id` / `source_visit_id` are bare scalars with no FK, so no include
 * reaches them, and an adjustment inherits its root's line attribution without
 * the root's `invoice_job` rows. Kept out of `jobs` / `visits`: these are not
 * billing links, carry no `billed_amount`, and must never be summed as one.
 */
const resolveUnlinkedLineSources = async (
	invoice: {
		line_items: { source_job_id: string | null; source_visit_id: string | null }[];
		jobs: { job_id: string }[];
		visits: { visit_id: string }[];
	},
	organizationId: string,
) => {
	const linkedJobIds = new Set(invoice.jobs.map((j) => j.job_id));
	const linkedVisitIds = new Set(invoice.visits.map((v) => v.visit_id));

	const jobIds = new Set<string>();
	const visitIds = new Set<string>();
	for (const line of invoice.line_items) {
		if (line.source_job_id && !linkedJobIds.has(line.source_job_id)) {
			jobIds.add(line.source_job_id);
		}
		if (line.source_visit_id && !linkedVisitIds.has(line.source_visit_id)) {
			visitIds.add(line.source_visit_id);
		}
	}
	if (jobIds.size === 0 && visitIds.size === 0) return { jobs: [], visits: [] };

	// Scoped: an id copied down an adjustment chain is still an id, and cross-org
	// attribution must resolve to nothing, not to another org's job number.
	const sdb = getScopedDb(organizationId);
	const [jobs, visits] = await Promise.all([
		jobIds.size > 0
			? sdb.job.findMany({
					where: { id: { in: [...jobIds] } },
					select: invoiceInclude.jobs.include.job.select,
				})
			: [],
		visitIds.size > 0
			? sdb.job_visit.findMany({
					where: { id: { in: [...visitIds] } },
					select: invoiceInclude.visits.include.visit.select,
				})
			: [],
	]);
	return { jobs, visits };
};

/** getInvoiceById plus the resolved revision lineage — for the detail GET. */
export const getInvoiceDetail = async (id: string, organizationId: string) => {
	const invoice = await getInvoiceById(id, organizationId);
	if (!invoice) return null;
	const [lineage, unlinked_sources] = await Promise.all([
		resolveDocumentLineage("invoice", id, organizationId),
		resolveUnlinkedLineSources(invoice, organizationId),
	]);
	return { ...invoice, lineage, unlinked_sources };
};

export const getInvoicesByClientId = async (clientId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.invoice.findMany({
		where: { client_id: clientId },
		include: invoiceInclude,
		orderBy: { created_at: "desc" },
	});
};

export const getInvoicesByJobId = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.invoice.findMany({
		where: { jobs: { some: { job_id: jobId } } },
		include: invoiceInclude,
		orderBy: { created_at: "desc" },
	});
};

export const getInvoicesByVisitId = async (visitId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.invoice.findMany({
		where: { visits: { some: { visit_id: visitId } } },
		include: invoiceInclude,
		orderBy: { created_at: "desc" },
	});
};

export const insertInvoice = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const parsed = createInvoiceSchema.parse(req.body);

		let created: Awaited<ReturnType<typeof db.invoice.findFirst>> | undefined;

		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				created = await createInvoiceRecord(
					parsed,
					organizationId,
					context?.dispatcherId,
				);

				// Transaction committed — log outside so it is never rolled back
				if (created) {
					await logActivity({
						event_type: "invoice.created",
						action: "created",
						entity_type: "invoice",
						entity_id: created.id,
						organization_id: organizationId,
						actor_type: context?.dispatcherId
							? "dispatcher"
							: context?.techId
								? "technician"
								: "system",
						actor_id: context?.dispatcherId ?? context?.techId,
						changes: {
							invoice_number: {
								old: null,
								new: created.invoice_number,
							},
							client_id: { old: null, new: created.client_id },
							total: { old: null, new: created.total },
							status: { old: null, new: created.status },
						},
						ip_address: context?.ipAddress,
						user_agent: context?.userAgent,
					});
				}
				// Fire-and-forget QB sync — failure must not block invoice creation
				if (created) {
					isQBConnected(organizationId)
						.then((connected) => (connected ? pushInvoice(created!.id, organizationId) : null))
						.catch((err) => {
							log.error(
								{ err, invoiceId: created!.id, organizationId },
								"QuickBooks invoice push failed",
							);
							db.invoice
								.update({ where: { id: created!.id }, data: { qb_sync_status: "failed" } })
								.catch((markErr) =>
									log.error(
										{ err: markErr, invoiceId: created!.id, organizationId },
										"Could not mark the invoice's QuickBooks sync as failed",
									),
								);
						});
				}

				break; // success — exit retry loop
			} catch (e) {
				// Retry on invoice_number unique constraint collision
				if (
					attempt < 4 &&
					e instanceof Prisma.PrismaClientKnownRequestError &&
					e.code === "P2002" &&
					(e.meta?.target as string[] | undefined)?.includes(
						"invoice_number",
					)
				) {
					continue;
				}
				throw e;
			}
		}

		return { err: "", item: created ?? undefined };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		if (e instanceof Error) return { err: e.message };
		log.error({ err: e }, "Insert invoice error");
		return { err: "Internal server error" };
	}
};

export const updateInvoice = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const id = req.params.id as string;
		const parsed = updateInvoiceSchema.parse(req.body);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.invoice.findFirst({
			where: { id },
			include: { line_items: true },
		});
		if (!existing) return { err: "Invoice not found" };

		if (existing.status === "Void") {
			return { err: "Void invoices cannot be modified" };
		}

		// Moving an invoice out of Disputed from here strands the dispute: the
		// resolve endpoint requires the invoice to still be Disputed, and Void
		// is terminal, so the open row could never be closed — and it holds the
		// one-open-dispute index forever. Resolution is the only exit.
		if (parsed.status && parsed.status !== existing.status) {
			const openRefusal = await openDisputeStatusChangeRefusal(
				sdb as unknown as Prisma.TransactionClient,
				"invoice",
				id,
			);
			if (openRefusal) return { err: openRefusal };
		}

		if (parsed.status === "Void" && !parsed.void_reason) {
			return { err: "void_reason is required when voiding an invoice" };
		}

		// Before the transaction, because the void write also stamps voided_at
		// and fires voidQBInvoice — a partially-paid invoice was being voided
		// in QuickBooks with its payment rows still standing. Same rule the
		// dispute outcomes enforce, same sentence, one source.
		if (parsed.status === "Void") {
			const blocked = voidBlockedByPaymentReason(
				Number(existing.amount_paid ?? 0),
			);
			if (blocked) return { err: blocked };
			// The rule Repeal enforces too: an adjustment is its own live
			// document, so voiding the invoice it adjusts would leave the credit
			// standing in receivables against a dead parent.
			const liveAdjustments = await sdb.invoice.findMany({
				where: { adjusts_invoice_id: id, status: { not: "Void" } },
				select: { invoice_number: true },
			});
			const adjusted = voidBlockedByAdjustmentReason(liveAdjustments);
			if (adjusted) return { err: adjusted };
		}

		// Enforce valid status transitions
		if (parsed.status && parsed.status !== existing.status) {
			try {
				assertValidInvoiceTransition(existing.status, parsed.status);
			} catch (e) {
				if (e instanceof InvalidTransitionError) {
					return { err: e.message };
				}
				throw e;
			}
		}

		const { line_items: _li, ...parsedScalars } = parsed;

		const changes = buildChanges(existing, parsedScalars, [
			"status",
			"issue_date",
			"due_date",
			"payment_terms_days",
			"sent_at",
			"viewed_at",
			"subtotal",
			"tax_rate",
			"tax_amount",
			"discount_type",
			"discount_value",
			"discount_amount",
			"total",
			"memo",
			"internal_notes",
			"void_reason",
		] as const);

		// Did anything that QuickBooks mirrors change? Drives both the
		// qb_sync_status write below and whether we fire a re-push.
		const qbRelevantChanged =
			parsed.line_items !== undefined ||
			"status" in changes ||
			"due_date" in changes ||
			"memo" in changes ||
			"discount_type" in changes ||
			"discount_value" in changes ||
			"total" in changes;

		// Returned rather than thrown: the catch below collapses every non-Zod
		// Error into "Internal server error".
		if (parsed.line_items && parsed.line_items.length > 0) {
			const foreignItems = await findForeignInventoryItemIds(
				sdb,
				organizationId,
				parsed.line_items.map((li) => li.inventory_item_id),
			);
			if (foreignItems.length > 0) {
				return { err: unknownInventoryItemsMessage(foreignItems) };
			}
		}

		const isLocked =
			existing.tax_snapshot != null &&
			(existing.tax_snapshot as { locked_at?: string }).locked_at !== "draft";

		const updated = await sdb.$transaction(async (tx) => {
			// ── Line item replacement ──────────────────────────────────────
			if (parsed.line_items !== undefined) {
				// Guard: cannot modify line items on a finalized (snapshot-locked) invoice
				if (isLocked) {
					throw new DocumentRuleError(
						"This invoice is no longer a draft — its line items are locked. Issue an adjustment instead.",
					);
				}

				const incoming = parsed.line_items;
				const existingIds = new Set(
					existing.line_items.map((i) => i.id),
				);
				const incomingIds = new Set(
					incoming.filter((i) => i.id).map((i) => i.id!),
				);

				for (const item of existing.line_items) {
					if (!incomingIds.has(item.id)) {
						await tx.invoice_line_item.delete({
							where: { id: item.id },
						});
					}
				}

				for (const item of incoming) {
					if (item.id && existingIds.has(item.id)) {
						await tx.invoice_line_item.update({
							where: { id: item.id },
							data: {
								name: item.name,
								description: item.description ?? null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								total:
									item.total !== undefined
										? item.total
										: item.quantity * item.unit_price,
								item_type: item.item_type ?? null,
								sort_order: item.sort_order ?? 0,
								source_job_id: item.source_job_id ?? null,
								source_visit_id: item.source_visit_id ?? null,
								inventory_item_id: item.inventory_item_id ?? null,
								...(item.tax_group_id !== undefined && {
									tax_group_id: item.tax_group_id,
								}),
								...(item.taxable !== undefined && {
									taxable: item.taxable,
								}),
							},
						});
					} else {
						await tx.invoice_line_item.create({
							data: {
								invoice_id: id,
								name: item.name,
								description: item.description ?? null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								total:
									item.total !== undefined
										? item.total
										: item.quantity * item.unit_price,
								item_type: item.item_type ?? null,
								sort_order: item.sort_order ?? 0,
								source_job_id: item.source_job_id ?? null,
								source_visit_id: item.source_visit_id ?? null,
								inventory_item_id: item.inventory_item_id ?? null,
								tax_group_id: item.tax_group_id ?? null,
								taxable: item.taxable !== undefined ? item.taxable : true,
							},
						});
					}
				}

				// Recompute billed_amount for all linked jobs and visits
				// from the now-current line items' source attribution.
				await syncBilledAmounts(id, tx as unknown as Prisma.TransactionClient);

				// Recompute invoice tax totals via taxEngine
				await recomputeInvoiceTotals(id, organizationId, tx as unknown as Prisma.TransactionClient);
			}

			// Recompute when discount changes without a line_items replacement
			const discountChanged =
				parsed.discount_type !== undefined || parsed.discount_value !== undefined;
			if (discountChanged && parsed.line_items === undefined && !isLocked) {
				await tx.invoice.update({
					where: { id },
					data: {
						...(parsed.discount_type !== undefined && {
							discount_type: parsed.discount_type,
						}),
						...(parsed.discount_value !== undefined && {
							discount_value: parsed.discount_value,
						}),
					},
				});
				await recomputeInvoiceTotals(id, organizationId, tx as unknown as Prisma.TransactionClient);
			}

			/**
			 * Finalization — this app's posting act. It freezes the tax basis
			 * and dates the document, and it fires on the FIRST EXIT FROM
			 * DRAFT, not on a particular target status.
			 *
			 * Issued and Sent are two delivery choices, not two steps: Issued
			 * means "it is final and I am delivering it myself" (download the
			 * PDF, hand it over, use your own mail), Sent means "it is final
			 * and the system emailed it". Both commit to the same claim for the
			 * same amount, so both must freeze the same way — keying this on
			 * `=== "Issued"` left the emailed path unfrozen and undated.
			 *
			 * Void is excluded on purpose: killing a draft commits to nothing.
			 */
			const finalizedAt = isInvoiceFinalizingTransition(
				existing.status,
				parsed.status,
			)
				? new Date()
				: undefined;

			/**
			 * Both doors date the document. The `parsed.status === "Sent"`
			 * fallback is a safety net for rows finalized before this stamped
			 * on both doors — a document in the client's hands must carry a
			 * date, and reports fall back to created_at when it is null, which
			 * dates the revenue to when the draft was first opened.
			 * `!existing.issue_date` keeps it idempotent and preserves the
			 * TxnDate on invoices imported from QuickBooks.
			 */
			const issueDateStamp =
				finalizedAt ??
				(parsed.status === "Sent" ? new Date() : undefined);

			const invoice = await tx.invoice.update({
				where: { id },
				data: {
					...(parsed.status !== undefined && {
						status: parsed.status,
					}),
					...(parsed.issue_date !== undefined && {
						issue_date: parsed.issue_date,
					}),
					...(parsed.due_date !== undefined && {
						due_date: parsed.due_date,
					}),
					...(parsed.payment_terms_days !== undefined && {
						payment_terms_days: parsed.payment_terms_days,
					}),
					...(parsed.sent_at !== undefined && {
						sent_at: parsed.sent_at,
					}),
					...(parsed.viewed_at !== undefined && {
						viewed_at: parsed.viewed_at,
					}),
					...(!isLocked && parsed.subtotal !== undefined && {
						subtotal: parsed.subtotal,
					}),
					...(!isLocked && parsed.tax_rate !== undefined && {
						tax_rate: parsed.tax_rate,
					}),
					...(!isLocked && parsed.tax_amount !== undefined && {
						tax_amount: parsed.tax_amount,
					}),
					...(!isLocked && !discountChanged && parsed.discount_type !== undefined && {
						discount_type: parsed.discount_type,
					}),
					...(!isLocked && !discountChanged && parsed.discount_value !== undefined && {
						discount_value: parsed.discount_value,
					}),
					...(!isLocked && !discountChanged && parsed.discount_amount !== undefined && {
						discount_amount: parsed.discount_amount,
					}),
					...(!isLocked && parsed.total !== undefined && { total: parsed.total }),
					...(parsed.memo !== undefined && { memo: parsed.memo }),
					...(parsed.internal_notes !== undefined && {
						internal_notes: parsed.internal_notes,
					}),
					...(parsed.void_reason !== undefined && {
						void_reason: parsed.void_reason,
					}),
					...(finalizedAt !== undefined &&
						!existing.issued_at && { issued_at: finalizedAt }),
					...(parsed.status === "Sent" &&
						!existing.sent_at && { sent_at: new Date() }),
					...(issueDateStamp !== undefined &&
						!existing.issue_date && {
							issue_date: issueDateStamp,
						}),
					...(parsed.status === "Void" && {
						voided_at: new Date(),
					}),
					...(!isLocked && parsed.total !== undefined && {
						balance_due: Math.max(
							0,
							parsed.total - Number(existing.amount_paid),
						),
					}),
					...(parsed.qb_sync_status !== undefined
						? { qb_sync_status: parsed.qb_sync_status }
						: qbRelevantChanged
							? { qb_sync_status: "not_synced" }
							: {}),
				},
				include: invoiceInclude,
			});

			// Voiding an adjustment has to stop its credit counting against the
			// job; every void door re-derives the chain.
			if (parsed.status === "Void") {
				await syncBilledAmounts(id, tx as unknown as Prisma.TransactionClient);
			}

			// Freeze the tax basis on whichever door the document left Draft
			// through. Without this on the Sent branch, an invoice the client
			// is already holding keeps editable line items: isLocked is
			// derived from the snapshot, so an unlocked snapshot means the
			// server still accepts a line-item rewrite.
			if (finalizedAt !== undefined) {
				await lockInvoiceTaxSnapshot(
					id,
					organizationId,
					tx as unknown as Prisma.TransactionClient,
					finalizedAt,
				);
			}

			return invoice;
		});

		// QB sync — fire only when a QB-mirrored field changed
		if (qbRelevantChanged) {
			if (parsed.status === "Void") {
				mirrorInvoiceVoidToQuickBooks(organizationId, id, existing.qb_invoice_id);
			} else {
				isQBConnected(organizationId)
					.then((connected) => (connected ? pushInvoice(updated.id, organizationId) : null))
					.catch((err) => {
						log.error({ err, invoiceId: id, organizationId }, "QuickBooks invoice push failed");
						db.invoice
							.update({ where: { id }, data: { qb_sync_status: "failed" } })
							.catch((markErr) =>
								log.error(
									{ err: markErr, invoiceId: id, organizationId },
									"Could not mark the invoice's QuickBooks sync as failed",
								),
							);
					});
			}
		}

		if (Object.keys(changes).length > 0) {
			await logActivity({
				event_type: "invoice.updated",
				action: "updated",
				entity_type: "invoice",
				entity_id: id,
				organization_id: organizationId,
				actor_type: context?.dispatcherId
					? "dispatcher"
					: context?.techId
						? "technician"
						: "system",
				actor_id: context?.dispatcherId ?? context?.techId,
				changes: { ...changes, _invoice_number: { old: null, new: existing.invoice_number } },
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
		}

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		// A rule refusing the write is the caller's answer, not a fault, so it
		// must not flatten into "Internal server error".
		if (e instanceof DocumentRuleError) {
			return { err: e.message };
		}
		// An unrecognised throw is a fault, not the caller's answer. Returning
		// a string here mapped it to 400 at the route and kept it out of the
		// 5xx metrics; rethrow so the global handler logs it and answers 500.
		throw e;
	}
};

export const deleteInvoice = async (id: string, organizationId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.invoice.findFirst({ where: { id } });
		if (!existing) return { err: "Invoice not found" };

		if (existing.status !== "Draft") {
			return {
				err: "Only Draft invoices can be deleted. Void the invoice instead.",
			};
		}

		await sdb.invoice.delete({ where: { id } });

		await logActivity({
			event_type: "invoice.deleted",
			action: "deleted",
			entity_type: "invoice",
			entity_id: id,
			organization_id: organizationId,
			actor_type: context?.dispatcherId
				? "dispatcher"
				: context?.techId
					? "technician"
					: "system",
			actor_id: context?.dispatcherId ?? context?.techId,
			changes: {
				invoice_number: { old: existing.invoice_number, new: null },
				status: { old: existing.status, new: null },
				total: { old: existing.total, new: null },
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: { id } };
	} catch (e) {
		log.error({ err: e }, "Delete invoice error");
		return { err: "Internal server error" };
	}
};

// ============================================================================
// PAYMENTS
// ============================================================================

export const getInvoicePayments = async (invoiceId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.invoice_payment.findMany({
		where: { invoice_id: invoiceId },
		orderBy: { paid_at: "asc" },
		include: {
			recorded_by_dispatcher: { select: { id: true, name: true } },
			recorded_by_tech: { select: { id: true, name: true } },
		},
	});
};

export const insertInvoicePayment = async (
	invoiceId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createInvoicePaymentSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		// Every check below reads under the invoice row lock. Payments stay
		// allowed while a dispute is open, so a payment racing a Repeal on
		// the same invoice is ordinary use: resolveDispute takes the same lock,
		// and whichever commits second reads the other's write instead of both
		// passing a money check made against stale rows. organization_id is in
		// the predicate because raw SQL bypasses getScopedDb.
		const outcome = await sdb.$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;
			await txc.$queryRaw`SELECT id FROM invoice WHERE id = ${invoiceId} AND organization_id = ${organizationId} FOR UPDATE`;

			const invoice = await tx.invoice.findFirst({
				where: { id: invoiceId },
			});
			if (!invoice) return { err: "Invoice not found" };

			if (invoice.status === "Void") {
				return { err: "Cannot record payment on a void invoice" };
			}

			// A draft is not yet a receivable, so there is nothing to pay against
			// it. This is not only a bookkeeping nicety: syncInvoicePaymentTotals
			// writes the payment-derived status directly, bypassing both the
			// transition table and updateInvoice, so a payment on a draft promoted
			// it straight to PartiallyPaid/Paid without ever finalizing — no
			// issued_at, no issue_date (which dates the revenue to when the draft
			// was opened), and no locked tax snapshot, leaving a PAID invoice whose
			// line items the server still accepted a rewrite of. Issue or email the
			// invoice first; both doors finalize it.
			// The UI has always refused this; the server now agrees.
			if (invoice.status === "Draft") {
				return {
					err: "Create or send the invoice before recording a payment.",
				};
			}

			const existingPaymentsAgg = await tx.invoice_payment.aggregate({
				where: { invoice_id: invoiceId },
				_sum: { amount: true },
			});
			const alreadyPaid = Number(existingPaymentsAgg._sum.amount ?? 0);
			if (alreadyPaid + parsed.amount > Number(invoice.total)) {
				return { err: "Payment would exceed invoice total" };
			}

			const payment = await tx.invoice_payment.create({
				data: {
					invoice_id: invoiceId,
					amount: parsed.amount,
					paid_at: parsed.paid_at ?? new Date(),
					method: parsed.method ?? null,
					note: parsed.note ?? null,
					recorded_by_dispatcher_id: context?.dispatcherId ?? null,
					recorded_by_tech_id: context?.techId ?? null,
				},
			});

			await syncInvoicePaymentTotals(invoiceId, txc);

			return { err: "", payment, invoiceNumber: invoice.invoice_number };
		});
		if (!outcome.payment) return { err: outcome.err };
		const created = outcome.payment;

		await logActivity({
			event_type: "invoice_payment.created",
			action: "created",
			entity_type: "invoice_payment",
			entity_id: created.id,
			organization_id: organizationId,
			actor_type: context?.dispatcherId
				? "dispatcher"
				: context?.techId
					? "technician"
					: "system",
			actor_id: context?.dispatcherId ?? context?.techId,
			changes: {
				invoice_id: { old: null, new: invoiceId },
				amount: { old: null, new: parsed.amount },
				method: { old: null, new: parsed.method ?? null },
				_invoice_number: { old: null, new: outcome.invoiceNumber },
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		notifyDispatchers({
			type: "invoice_paid",
			title: `Payment on Invoice ${outcome.invoiceNumber}`,
			body: `${formatCurrency(parsed.amount)} recorded${parsed.method ? ` by ${parsed.method}` : ""}.`,
			actionUrl: `/dispatch/invoices/${invoiceId}`,
		}, organizationId, context?.dispatcherId).catch(() => {});

		isQBConnected(organizationId)
		.then((connected) => (connected ? pushPaymentToQB(created.id, organizationId) : null))
		.catch((e) => logExternalSync({
			provider: "quickbooks",
			external_id: created.id,
			entity_type: "payment",
			action: "push_failed",
			payload: { message: String(e) },
			organization_id: organizationId
		}));

		return { err: "", item: created };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Insert invoice payment error");
		return { err: "Internal server error" };
	}
};

export const deleteInvoicePayment = async (
	invoiceId: string,
	paymentId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.invoice_payment.findFirst({
			where: { id: paymentId, invoice_id: invoiceId },
		});
		if (!existing) return { err: "Payment not found" };

		const invoice = await sdb.invoice.findFirst({
			where: { id: invoiceId },
		});
		if (invoice?.status === "Void") {
			return { err: "Cannot modify payments on a void invoice" };
		}

		await sdb.$transaction(async (tx) => {
			await tx.invoice_payment.delete({ where: { id: paymentId } });
			await syncInvoicePaymentTotals(invoiceId, tx as unknown as Prisma.TransactionClient);
		});

		await logActivity({
			event_type: "invoice_payment.deleted",
			action: "deleted",
			entity_type: "invoice_payment",
			entity_id: paymentId,
			organization_id: organizationId,
			actor_type: context?.dispatcherId
				? "dispatcher"
				: context?.techId
					? "technician"
					: "system",
			actor_id: context?.dispatcherId ?? context?.techId,
			changes: {
				invoice_id: { old: invoiceId, new: null },
				amount: { old: existing.amount, new: null },
				...parentBreadcrumb("invoice", invoiceId),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		// Mirror to QB only if this payment was actually synced
		// Skip if the payment belongs to a different QB account
		const qbPaymentId = existing.qb_payment_id;
		const currentRealmId = await getOrgRealmId(organizationId);
		if (qbPaymentId && existing.account_id === currentRealmId) {
			isQBConnected(organizationId)
			.then((connected) => (connected ? deleteQBPayment(qbPaymentId, organizationId) : null))
			.catch((e) => logExternalSync({
				provider: "quickbooks",
				external_id: qbPaymentId,
				entity_type: "payment",
				action: "delete_failed",
				payload: { message: String(e) },
				organization_id: organizationId
			}));
		}

		return { err: "", item: { id: paymentId } };
	} catch (e) {
		log.error({ err: e }, "Delete invoice payment error");
		return { err: "Internal server error" };
	}
};

/**
 * Records a refund as a negative invoice_payment row — same table, same
 * syncInvoicePaymentTotals arithmetic, no new model. Recording a refund does
 * not move money: the card/bank action happens outside the system (Housecall
 * Pro model). Refund rows are never pushed to QuickBooks — qb_payment_id
 * stays null and qb_sync_status is untouched.
 *
 * Return shape follows this file's convention (insertInvoicePayment above):
 * `{ err: "", item }` on success, `{ err: "<message>" }` on failure — NOT the
 * bare-object-or-{err} shape some other callers use.
 */
export const recordRefund = async (
	invoiceId: string,
	input: CreateRefundInput,
	organizationId: string,
	context: UserContext,
) => {
	const sdb = getScopedDb(organizationId);

	return await sdb.$transaction(async (tx) => {
		const txc = tx as unknown as Prisma.TransactionClient;

		// Lock the invoice before reading it: two near-simultaneous refunds
		// (double-click, client retry) must not both read the same
		// pre-refund paid total and both pass the ceiling check below.
		// organization_id is in the predicate because getScopedDb's extension
		// cannot reach raw SQL: without it a caller in one org can take a row
		// lock on another org's invoice for the life of this transaction, even
		// though the scoped findFirst below then correctly refuses to read it.
		await txc.$queryRaw`SELECT id FROM invoice WHERE id = ${invoiceId} AND organization_id = ${organizationId} FOR UPDATE`;

		const invoice = await tx.invoice.findFirst({ where: { id: invoiceId } });
		if (!invoice) return { err: "Invoice not found" };
		if (invoice.status === "Void") return { err: "Void invoices cannot be modified" };

		// Derived from the payment rows rather than the cached amount_paid
		// column: under the lock this is authoritative, where the cached
		// column is a denormalisation that can drift.
		const paidAgg = await tx.invoice_payment.aggregate({
			where: { invoice_id: invoiceId },
			_sum: { amount: true },
		});
		const paid = Number(paidAgg._sum.amount ?? 0);
		if (input.amount > paid) {
			return {
				err: `Cannot refund ${input.amount.toFixed(2)} — only ${paid.toFixed(2)} has been paid on this invoice.`,
			};
		}

		const refund = await tx.invoice_payment.create({
			data: {
				invoice_id: invoiceId,
				amount: -input.amount,
				note: input.reason,
				method: input.method ?? null,
				recorded_by_dispatcher_id: context.dispatcherId ?? null,
			},
		});

		// amount_paid is the signed sum, so a refunded invoice falls back out
		// of Paid on its own.
		await syncInvoicePaymentTotals(invoiceId, txc);

		await logActivity({
			event_type: "invoice_payment.refunded",
			action: "created",
			entity_type: "invoice_payment",
			entity_id: refund.id,
			organization_id: organizationId,
			actor_type: context.dispatcherId ? "dispatcher" : "system",
			actor_id: context.dispatcherId,
			reason: input.reason,
			changes: {
				amount_paid: { old: paid, new: paid - input.amount },
				_invoice_number: { old: null, new: invoice.invoice_number },
			},
			ip_address: context.ipAddress,
			user_agent: context.userAgent,
		});

		return { err: "", item: refund };
	});
};

// ============================================================================
// NOTES
// ============================================================================

export const getInvoiceNotes = async (invoiceId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.invoice_note.findMany({
		where: { invoice_id: invoiceId },
		orderBy: { created_at: "desc" },
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
	});
};

export const insertInvoiceNote = async (
	invoiceId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createInvoiceNoteSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const invoice = await sdb.invoice.findFirst({
			where: { id: invoiceId },
		});
		if (!invoice) return { err: "Invoice not found" };

		const created = await sdb.invoice_note.create({
			data: {
				organization_id: organizationId,
				invoice_id: invoiceId,
				content: parsed.content,
				creator_tech_id: context?.techId ?? null,
				creator_dispatcher_id: context?.dispatcherId ?? null,
				last_editor_tech_id: context?.techId ?? null,
				last_editor_dispatcher_id: context?.dispatcherId ?? null,
			},
			include: {
				creator_tech: {
					select: { id: true, name: true, email: true },
				},
				creator_dispatcher: {
					select: { id: true, name: true, email: true },
				},
			},
		});

		await logActivity({
			event_type: "invoice_note.created",
			action: "created",
			entity_type: "invoice_note",
			entity_id: created.id,
			organization_id: organizationId,
			actor_type: context?.dispatcherId
				? "dispatcher"
				: context?.techId
					? "technician"
					: "system",
			actor_id: context?.dispatcherId ?? context?.techId,
			changes: {
				invoice_id: { old: null, new: invoiceId },
				content: { old: null, new: parsed.content },
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: created };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Insert invoice note error");
		return { err: "Internal server error" };
	}
};

export const updateInvoiceNote = async (
	invoiceId: string,
	noteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateInvoiceNoteSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const existing = await sdb.invoice_note.findFirst({
			where: { id: noteId, invoice_id: invoiceId },
		});
		if (!existing) return { err: "Note not found" };

		const updated = await sdb.invoice_note.update({
			where: { id: noteId },
			data: {
				...(parsed.content !== undefined && {
					content: parsed.content,
				}),
				last_editor_tech_id: context?.techId ?? null,
				last_editor_dispatcher_id: context?.dispatcherId ?? null,
			},
			include: {
				creator_tech: {
					select: { id: true, name: true, email: true },
				},
				creator_dispatcher: {
					select: { id: true, name: true, email: true },
				},
				last_editor_tech: {
					select: { id: true, name: true, email: true },
				},
				last_editor_dispatcher: {
					select: { id: true, name: true, email: true },
				},
			},
		});

		if (parsed.content !== undefined) {
			await logActivity({
				event_type: "invoice_note.updated",
				action: "updated",
				entity_type: "invoice_note",
				entity_id: noteId,
				organization_id: organizationId,
				actor_type: context?.dispatcherId
					? "dispatcher"
					: context?.techId
						? "technician"
						: "system",
				actor_id: context?.dispatcherId ?? context?.techId,
				changes: {
					content: { old: existing.content, new: parsed.content },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
		}

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((i) => i.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Update invoice note error");
		return { err: "Internal server error" };
	}
};

export const deleteInvoiceNote = async (
	invoiceId: string,
	noteId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.invoice_note.findFirst({
			where: { id: noteId, invoice_id: invoiceId },
		});
		if (!existing) return { err: "Note not found" };

		await sdb.invoice_note.delete({ where: { id: noteId } });

		await logActivity({
			event_type: "invoice_note.deleted",
			action: "deleted",
			entity_type: "invoice_note",
			entity_id: noteId,
			organization_id: organizationId,
			actor_type: context?.dispatcherId
				? "dispatcher"
				: context?.techId
					? "technician"
					: "system",
			actor_id: context?.dispatcherId ?? context?.techId,
			changes: {
				invoice_id: { old: invoiceId, new: null },
				content: { old: existing.content, new: null },
				...parentBreadcrumb("invoice", invoiceId),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", message: "Note deleted successfully" };
	} catch (e) {
		log.error({ err: e }, "Delete invoice note error");
		return { err: "Internal server error" };
	}
};
