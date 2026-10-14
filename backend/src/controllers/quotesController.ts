import { ZodError } from "zod";
import {
	createQuoteSchema,
	updateQuoteSchema,
	createQuoteItemSchema,
	updateQuoteItemSchema,
} from "../lib/validate/quotes.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { Prisma } from "../../generated/prisma/client.js";
import { log } from "../services/appLogger.js";
import { assertValidQuoteTransition, InvalidTransitionError } from "../lib/statusTransitions.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { fillCoords } from "../lib/geocode.js";
import { assertInventoryItemsInOrg } from "../lib/inventory.js";
import { resolveDocumentLineage } from "../lib/documentLineage.js";
import { formatCurrency } from "../lib/money.js";
import { SOLD_BY_QUOTE_JOBS } from "../services/disputeAdapters.js";
import { quoteDetailInclude } from "../services/quoteService.js";
import { openDisputeStatusChangeRefusal } from "../services/disputeService.js";
import { notifyDispatchers } from "./notificationsController.js";
import { db, generateQuoteNumber } from "../db.js";
import {
	centsToDollars,
} from "../services/taxEngine.js";
import {
	recomputeDocumentTotals,
	lockDocumentTaxSnapshot,
	type RecomputeResult,
} from "../lib/recomputeDocumentTotals.js";

// ============================================================================
// TAX HELPERS (quotes)
// ============================================================================

/** Thin wrapper — delegates to shared recomputeDocumentTotals. */
async function recomputeQuoteTotals(
	quoteId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	lockedAt?: Date,
): Promise<RecomputeResult> {
	return recomputeDocumentTotals("quote", quoteId, organizationId, tx, lockedAt);
}

async function lockQuoteTaxSnapshot(
	quoteId: string,
	organizationId: string,
	tx: Prisma.TransactionClient,
	lockedAt: Date = new Date(),
): Promise<void> {
	await lockDocumentTaxSnapshot("quote", quoteId, organizationId, tx, lockedAt);
}


export const getAllQuotes = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.quote.findMany({
		include: {
			client: {
				select: {
					id: true,
					name: true,
				},
			},
			request: {
				select: {
					id: true,
					title: true,
					status: true,
				},
			},
			job: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
		},
		orderBy: { created_at: "desc" },
	});
};

/**
 * The quote without its revision-chain walk. The PDF renderer, the email
 * sender and the pre-send transition guard all call this and none read
 * `lineage`, so resolving the two recursive CTEs here made every send pay for
 * a value nobody uses. getQuoteDetail adds it.
 */
export const getQuoteById = async (quoteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.quote.findFirst({
		where: { id: quoteId },
		include: quoteDetailInclude,
	});
};

/** getQuoteById plus the resolved revision lineage — for the detail GET. */
export const getQuoteDetail = async (
	quoteId: string,
	organizationId: string,
) => {
	const quote = await getQuoteById(quoteId, organizationId);
	if (!quote) return null;
	// A walk, not a join — kept out of the include so it is paid for only here.
	const lineage = await resolveDocumentLineage(
		"quote",
		quoteId,
		organizationId,
	);
	return { ...quote, lineage };
};

export const getQuotesByClientId = async (clientId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.quote.findMany({
		where: { client_id: clientId },
		include: {
			client: true,
			request: {
				select: {
					id: true,
					title: true,
					status: true,
				},
			},
			job: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
		},
		orderBy: { created_at: "desc" },
	});
};

export const insertQuote = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const parsed = createQuoteSchema.parse(req.body);
		await fillCoords(parsed, false);
		const sdb = getScopedDb(organizationId);

		let created: Awaited<ReturnType<typeof db.quote.findFirst>> | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				created = await sdb.$transaction(async (tx) => {
			const client = await tx.client.findFirst({
				where: { id: parsed.client_id, organization_id: organizationId },
			});

			if (!client) {
				throw new Error("Client not found");
			}

			let address = parsed.address;
			let coords: { lat: number; lon: number } | undefined =
				parsed.coords;
			let priority = parsed.priority;
			let title = parsed.title;
			let description = parsed.description;

			// If linked to request, inherit missing fields
			if (parsed.request_id) {
				const request = await tx.request.findFirst({
					where: { id: parsed.request_id, organization_id: organizationId },
				});

				if (!request) {
					throw new Error("Request not found");
				}

				// Inherit fields from request if not explicitly provided
				if (!address && request.address) {
					address = request.address;
				}
				if (!coords && request.coords) {
					coords = request.coords as { lat: number; lon: number };
				}
				if (!priority && request.priority) {
					priority = request.priority;
				}
				if (!title) {
					title = request.title;
				}
				if (!description) {
					description = request.description;
				}

				// Update request status to show it has been quoted
				await tx.request.update({
					where: { id: parsed.request_id },
					data: { status: "Quoted" },
				});

				await logActivity({
					event_type: "request.quoted",
					action: "converted",
					entity_type: "request",
					entity_id: parsed.request_id,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: {
						status: { old: request.status, new: "Quoted" },
					},
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			if (!address) {
				throw new Error("Address is required for quote");
			}
			if (!title) {
				throw new Error("Title is required for quote");
			}
			if (!description) {
				throw new Error("Description is required for quote");
			}

			const quoteNumber = await generateQuoteNumber(tx, organizationId);

			const quoteData: Prisma.quoteCreateInput = {
				quote_number: quoteNumber,

				organization: { connect: { id: organizationId } },
				client: { connect: { id: parsed.client_id } },

				...(parsed.request_id && {
					request: { connect: { id: parsed.request_id } },
				}),
				...(context?.dispatcherId && {
					created_by_dispatcher: {
						connect: { id: context.dispatcherId },
					},
				}),

				title: title,
				description: description,
				address: address,
				priority: priority,
				status: parsed.status,
				subtotal: parsed.subtotal ?? 0,
				total: parsed.total ?? 0,

				...(parsed.tax_rate !== undefined && { tax_rate: parsed.tax_rate }),
				...(parsed.tax_amount !== undefined && { tax_amount: parsed.tax_amount }),
				...(parsed.discount_type !== undefined && { discount_type: parsed.discount_type }),
				...(parsed.discount_value !== undefined && { discount_value: parsed.discount_value }),
				...(parsed.discount_amount !== undefined && { discount_amount: parsed.discount_amount }),
				...(coords && { coords: coords }),
				...(parsed.valid_until && {
					valid_until: new Date(parsed.valid_until),
				}),
				...(parsed.expires_at && {
					expires_at: new Date(parsed.expires_at),
				}),
			};

			const quote = await tx.quote.create({
				data: quoteData,
			});
			if (parsed.line_items && parsed.line_items.length > 0) {
				await assertInventoryItemsInOrg(
					tx,
					organizationId,
					parsed.line_items.map((i) => i.inventory_item_id),
				);
				await tx.quote_line_item.createMany({
					data: parsed.line_items.map((item, index) => ({
						quote_id: quote.id,
						name: item.name,
						description: item.description || null,
						quantity: item.quantity,
						unit_price: item.unit_price,
						total: item.total ?? item.quantity * item.unit_price,
						item_type: item.item_type || null,
						sort_order: item.sort_order ?? index,
						tax_group_id: item.tax_group_id ?? null,
						taxable: item.taxable !== undefined ? item.taxable : true,
						inventory_item_id: item.inventory_item_id ?? null,
					})),
				});

				// Recompute quote tax totals now that line items exist
				await recomputeQuoteTotals(quote.id, organizationId, tx as unknown as Prisma.TransactionClient);
			}

			await tx.client.update({
				where: { id: parsed.client_id },
				data: { last_activity: new Date() },
			});

			await logActivity({
				event_type: "quote.created",
				action: "created",
				entity_type: "quote",
				entity_id: quote.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					quote_number: { old: null, new: quote.quote_number },
					title: { old: null, new: quote.title },
					client_id: { old: null, new: quote.client_id },
					status: { old: null, new: quote.status },
					total: { old: null, new: quote.total },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			return tx.quote.findUnique({
				where: { id: quote.id },
				include: quoteDetailInclude,
			});
				});
				break;
			} catch (e) {
				if (
					attempt < 4 &&
					e instanceof Prisma.PrismaClientKnownRequestError &&
					e.code === "P2002" &&
					(e.meta?.target as string[] | undefined)?.includes("quote_number")
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
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		if (e instanceof Error) {
			return { err: e.message };
		}
		log.error({ err: e }, "Insert quote error");
		return { err: "Internal server error" };
	}
};

export const updateQuote = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const quoteId = req.params.id as string;
		const parsed = updateQuoteSchema.parse(req.body);
		await fillCoords(parsed, false);
		const sdb = getScopedDb(organizationId);

		const existing = await sdb.quote.findFirst({
			where: { id: quoteId },
			include: { job: true, line_items: true },
		});

		if (!existing) {
			return { err: "Quote not found" };
		}

		// Terminal quotes are immutable, matching how Void invoices behave.
		// A repealed quote must stay repealed.
		const QUOTE_TERMINAL_STATUSES = ["Cancelled", "Rejected", "Revised"];
		if (QUOTE_TERMINAL_STATUSES.includes(existing.status)) {
			return { err: `${existing.status} quotes cannot be modified` };
		}

		// Mirrors updateInvoice: moving a quote out of Disputed from here
		// strands the dispute. resolveDispute requires the quote to still be
		// Disputed, and both exits from Disputed (Cancelled, Revised) are
		// themselves terminal, so the open row could never be closed — and it
		// holds the one-open-dispute index forever. Resolution is the only exit.
		if (parsed.status && parsed.status !== existing.status) {
			const openRefusal = await openDisputeStatusChangeRefusal(
				sdb as unknown as Prisma.TransactionClient,
				"quote",
				quoteId,
			);
			if (openRefusal) return { err: openRefusal };
		}

		if (existing.job) {
			return {
				err: "Cannot modify quote that has been converted to a job",
			};
		}

		const { line_items: _lineItems, ...parsedWithoutLineItems } = parsed;

		const changes = buildChanges(existing, parsedWithoutLineItems, [
			"title",
			"description",
			"priority",
			"address",
			"status",
			"rejection_reason",
			"discount_type",
			"subtotal",
			"tax_rate",
			"tax_amount",
			"discount_value",
			"discount_amount",
			"total",
			"valid_until",
			"expires_at",
			"coords",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			if (parsed.line_items !== undefined) {
				const incomingItems = parsed.line_items || [];
				await assertInventoryItemsInOrg(
					tx,
					organizationId,
					incomingItems.map((i) => i.inventory_item_id),
				);
				const existingItemIds = new Set(
					existing.line_items.map((item) => item.id),
				);
				const incomingItemIds = new Set(
					incomingItems
						.filter((item) => item.id)
						.map((item) => item.id!),
				);

				// Delete items not in incoming list
				const itemsToDelete = existing.line_items.filter(
					(item) => !incomingItemIds.has(item.id),
				);

				for (const item of itemsToDelete) {
					await tx.quote_line_item.delete({
						where: { id: item.id },
					});

					await logActivity({
						event_type: "quote_line_item.deleted",
						action: "deleted",
						entity_type: "quote_line_item",
						entity_id: item.id,
						organization_id: organizationId,
						actor_type: context?.techId
							? "technician"
							: context?.dispatcherId
								? "dispatcher"
								: "system",
						actor_id: context?.techId || context?.dispatcherId,
						changes: {
							name: { old: item.name, new: null },
							quote_id: { old: item.quote_id, new: null },
							...parentBreadcrumb("quote", item.quote_id),
						},
						ip_address: context?.ipAddress,
						user_agent: context?.userAgent,
					});
				}

				// Create or update items
				for (const [index, item] of incomingItems.entries()) {
					if (item.id && existingItemIds.has(item.id)) {
						// Update existing item
						const existingItem = existing.line_items.find(
							(i) => i.id === item.id,
						);

						if (existingItem) {
							const itemChanges: Record<string, { old: unknown; new: unknown }> = {};

							if (item.name !== existingItem.name) {
								itemChanges.name = {
									old: existingItem.name,
									new: item.name,
								};
							}
							if (item.description !== existingItem.description) {
								itemChanges.description = {
									old: existingItem.description,
									new: item.description,
								};
							}
							if (
								Number(item.quantity) !==
								Number(existingItem.quantity)
							) {
								itemChanges.quantity = {
									old: existingItem.quantity,
									new: item.quantity,
								};
							}
							if (
								Number(item.unit_price) !==
								Number(existingItem.unit_price)
							) {
								itemChanges.unit_price = {
									old: existingItem.unit_price,
									new: item.unit_price,
								};
							}
							if (
								Number(item.total) !==
								Number(existingItem.total)
							) {
								itemChanges.total = {
									old: existingItem.total,
									new: item.total,
								};
							}
							if (item.item_type !== existingItem.item_type) {
								itemChanges.item_type = {
									old: existingItem.item_type,
									new: item.item_type,
								};
							}

							await tx.quote_line_item.update({
								where: { id: item.id },
								data: {
									name: item.name,
									description: item.description || null,
									quantity: item.quantity,
									unit_price: item.unit_price,
									total: item.total ?? item.quantity * item.unit_price,
									item_type: item.item_type || null,
									sort_order: item.sort_order ?? index,
									...(item.tax_group_id !== undefined && {
										tax_group_id: item.tax_group_id,
									}),
									...(item.taxable !== undefined && {
										taxable: item.taxable,
									}),
									...(item.inventory_item_id !== undefined && {
										inventory_item_id: item.inventory_item_id,
									}),
								},
							});

							if (Object.keys(itemChanges).length > 0) {
								await logActivity({
									event_type: "quote_line_item.updated",
									action: "updated",
									entity_type: "quote_line_item",
									entity_id: item.id,
									organization_id: organizationId,
									actor_type: context?.techId
										? "technician"
										: context?.dispatcherId
											? "dispatcher"
											: "system",
									actor_id:
										context?.techId ||
										context?.dispatcherId,
									changes: itemChanges,
									ip_address: context?.ipAddress,
									user_agent: context?.userAgent,
								});
							}
						}
					} else {
						// Create new item
						const newItem = await tx.quote_line_item.create({
							data: {
								quote_id: quoteId,
								name: item.name,
								description: item.description || null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								total: item.total ?? item.quantity * item.unit_price,
								item_type: item.item_type || null,
								sort_order: item.sort_order ?? index,
								tax_group_id: item.tax_group_id ?? null,
								taxable: item.taxable !== undefined ? item.taxable : true,
								inventory_item_id: item.inventory_item_id ?? null,
							},
						});

						await logActivity({
							event_type: "quote_line_item.created",
							action: "created",
							entity_type: "quote_line_item",
							entity_id: newItem.id,
							organization_id: organizationId,
							actor_type: context?.techId
								? "technician"
								: context?.dispatcherId
									? "dispatcher"
									: "system",
							actor_id: context?.techId || context?.dispatcherId,
							changes: {
								name: { old: null, new: item.name },
								quote_id: { old: null, new: quoteId },
								total: { old: null, new: item.total },
							},
							ip_address: context?.ipAddress,
							user_agent: context?.userAgent,
						});
					}
				}

				// Recompute quote tax totals after line item changes
				await recomputeQuoteTotals(quoteId, organizationId, tx as unknown as Prisma.TransactionClient);
			}

			// Enforce valid status transitions
			if (parsed.status && parsed.status !== existing.status) {
				assertValidQuoteTransition(existing.status, parsed.status);
			}

			// Track status changes for auto-timestamps
			const isFirstIssued =
				parsed.status === "Issued" && existing.status !== "Issued";
			const isDraftDirectSend =
				parsed.status === "Sent" && existing.status === "Draft";
			const isFirstSent =
				parsed.status === "Sent" && existing.status !== "Sent";
			const isFirstViewed =
				parsed.status === "Viewed" && existing.status !== "Viewed";
			const isFirstApproved =
				parsed.status === "Approved" && existing.status !== "Approved";
			const isFirstRejected =
				parsed.status === "Rejected" && existing.status !== "Rejected";

			// If discount changed but line_items was not in the payload, still recompute totals.
			// Guard: skip if tax snapshot is already locked (issued quote).
			const discountChanged =
				parsed.discount_type !== undefined || parsed.discount_value !== undefined;
			if (discountChanged && parsed.line_items === undefined && existing.tax_snapshot == null) {
				// Apply discount updates to DB first so recompute reads the new values
				await tx.quote.update({
					where: { id: quoteId },
					data: {
						...(parsed.discount_type !== undefined && {
							discount_type: parsed.discount_type,
						}),
						...(parsed.discount_value !== undefined && {
							discount_value: parsed.discount_value,
						}),
					},
				});
				await recomputeQuoteTotals(quoteId, organizationId, tx as unknown as Prisma.TransactionClient);
			}

			const issuedAt = (isFirstIssued || isDraftDirectSend) ? new Date() : undefined;

			const quote = await tx.quote.update({
				where: { id: quoteId },
				data: {
					...(parsed.title !== undefined && { title: parsed.title }),
					...(parsed.description !== undefined && {
						description: parsed.description,
					}),
					...(parsed.address !== undefined && {
						address: parsed.address,
					}),
					...(parsed.coords !== undefined && {
						coords: parsed.coords || undefined,
					}),
					...(parsed.priority !== undefined && {
						priority: parsed.priority,
					}),
					// Note: subtotal/tax_amount/total are managed by recomputeQuoteTotals;
					// only write them if the caller explicitly sends them AND no recompute happened
					...(!discountChanged && parsed.subtotal !== undefined && {
						subtotal: parsed.subtotal,
					}),
					...(!discountChanged && parsed.tax_amount !== undefined && {
						tax_amount: parsed.tax_amount,
					}),
					...(!discountChanged && parsed.discount_type !== undefined && {
						discount_type: parsed.discount_type,
					}),
					...(!discountChanged && parsed.discount_value !== undefined && {
						discount_value: parsed.discount_value,
					}),
					...(!discountChanged && parsed.discount_amount !== undefined && {
						discount_amount: parsed.discount_amount,
					}),
					...(!discountChanged && parsed.total !== undefined && { total: parsed.total }),
					...(parsed.valid_until !== undefined && {
						valid_until: parsed.valid_until
							? new Date(parsed.valid_until)
							: null,
					}),
					...(parsed.expires_at !== undefined && {
						expires_at: parsed.expires_at
							? new Date(parsed.expires_at)
							: null,
					}),
					...(parsed.status !== undefined && {
						status: parsed.status,
					}),
					...(parsed.rejection_reason !== undefined && {
						rejection_reason: parsed.rejection_reason,
					}),
					// Auto-timestamps
					...(issuedAt !== undefined && { issued_at: issuedAt }),
					...(isFirstSent && { sent_at: new Date() }),
					...(isFirstViewed && { viewed_at: new Date() }),
					...(isFirstApproved && { approved_at: new Date() }),
					...(isFirstRejected && { rejected_at: new Date() }),
				},
				include: quoteDetailInclude,
			});

			// Lock tax snapshot when transitioning to Issued
			if (issuedAt !== undefined) {
				await lockQuoteTaxSnapshot(
					quoteId,
					organizationId,
					tx as unknown as Prisma.TransactionClient,
					issuedAt,
				);
			}

			// Sync request status if linked
			if (quote.request_id && parsed.status) {
				const requestStatusSync = async (newStatus: "QuoteApproved" | "QuoteRejected") => {
					await tx.request.update({
						where: { id: quote.request_id! },
						data: { status: newStatus },
					});
					await logActivity({
						event_type: newStatus === "QuoteApproved" ? "request.quote_approved" : "request.quote_rejected",
						action: "updated",
						entity_type: "request",
						entity_id: quote.request_id!,
						organization_id: organizationId,
						actor_type: context?.techId
							? "technician"
							: context?.dispatcherId
								? "dispatcher"
								: "system",
						actor_id: context?.techId || context?.dispatcherId,
						changes: {
							status: { old: quote.request?.status ?? null, new: newStatus },
						},
						ip_address: context?.ipAddress,
						user_agent: context?.userAgent,
					});
				};

				if (parsed.status === "Approved") {
					await requestStatusSync("QuoteApproved");
				} else if (parsed.status === "Rejected") {
					await requestStatusSync("QuoteRejected");
				}
			}

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "quote.updated",
					action: "updated",
					entity_type: "quote",
					entity_id: quoteId,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: { ...changes, _quote_number: { old: null, new: existing.quote_number } },
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			return quote;
		});

		if (parsed.status !== existing.status && (parsed.status === "Approved" || parsed.status === "Rejected")) {
			const approved = parsed.status === "Approved";
			notifyDispatchers({
				type: approved ? "quote_accepted" : "quote_declined",
				title: `Quote ${existing.quote_number} ${approved ? "accepted" : "declined"}`,
				body: approved
					? `${formatCurrency(Number(existing.total))} quote was accepted.`
					: (parsed.rejection_reason ?? "The client declined the quote."),
				actionUrl: `/dispatch/quotes/${quoteId}`,
			}, organizationId, context?.dispatcherId).catch(() => {});
		}

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		if (e instanceof InvalidTransitionError) {
			return { err: e.message };
		}
		log.error({ err: e }, "Update quote error");
		return { err: "Internal server error" };
	}
};

export const deleteQuote = async (id: string, organizationId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.quote.findFirst({
			where: { id },
			include: { job: true },
		});

		if (!existing) {
			return { err: "Quote not found" };
		}

		// Check if quote has been converted to job
		if (existing.job) {
			return {
				err: "Cannot delete quote that has been converted to a job",
			};
		}

		// document_dispute.quote_id cascades on delete, so deleting the quote
		// would destroy the dispute's reason, contested lines, resolution and
		// actors. The quote.deleted log row carries none of that, and spec §12
		// makes the audit trail the only mitigation for single-actor repeal.
		// A quote a resolution produced belongs to that dispute's audit trail
		// too. replacement_quote_id is ON DELETE RESTRICT; this sentence is what
		// the dispatcher reads instead of the constraint violation.
		const dispute = await sdb.document_dispute.findFirst({
			where: { OR: [{ quote_id: id }, { replacement_quote_id: id }] },
			select: { id: true, replacement_quote_id: true },
		});
		if (dispute?.replacement_quote_id === id) {
			return {
				err: "This quote was produced by a dispute resolution and is part of its audit trail. Cancel it instead.",
			};
		}
		if (dispute) {
			return {
				err: "Cannot delete a quote with dispute history. Its dispute record is part of the audit trail.",
			};
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "quote.deleted",
				action: "deleted",
				entity_type: "quote",
				entity_id: id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					quote_number: { old: existing.quote_number, new: null },
					title: { old: existing.title, new: null },
					status: { old: existing.status, new: null },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.quote_note.deleteMany({
				where: { quote_id: id },
			});

			await tx.quote_line_item.deleteMany({
				where: { quote_id: id },
			});

			await tx.quote.delete({
				where: { id },
			});
		});

		return { err: "", item: { id } };
	} catch (error) {
		log.error({ err: error }, "Delete quote error");
		return { err: "Internal server error" };
	}
};

// ============================================================================
// QUOTE LINE ITEMS
// ============================================================================

export const getQuoteItems = async (quoteId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.quote_line_item.findMany({
		where: { quote_id: quoteId },
		orderBy: { sort_order: "asc" },
	});
};

export const getQuoteItemById = async (quoteId: string, itemId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.quote_line_item.findFirst({
		where: {
			id: itemId,
			quote_id: quoteId,
		},
	});
};

export const insertQuoteItem = async (
	quoteId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createQuoteItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const quote = await sdb.quote.findFirst({
			where: { id: quoteId },
		});

		if (!quote) {
			return { err: "Quote not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			await assertInventoryItemsInOrg(tx, organizationId, [
				parsed.inventory_item_id,
			]);

			// Calculate total if not provided
			const total =
				parsed.total !== undefined
					? parsed.total
					: parsed.quantity * parsed.unit_price;

			const item = await tx.quote_line_item.create({
				data: {
					quote_id: quoteId,
					name: parsed.name,
					description: parsed.description || null,
					quantity: parsed.quantity,
					unit_price: parsed.unit_price,
					total: total,
					item_type: parsed.item_type || null,
					sort_order: parsed.sort_order,
					inventory_item_id: parsed.inventory_item_id ?? null,
					tax_group_id: parsed.tax_group_id ?? null,
					taxable: parsed.taxable !== undefined ? parsed.taxable : true,
				},
			});

			await logActivity({
				event_type: "quote_line_item.created",
				action: "created",
				entity_type: "quote_line_item",
				entity_id: item.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: null, new: parsed.name },
					quote_id: { old: null, new: quoteId },
					total: { old: null, new: total },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			// Recompute quote totals after adding a line item
			await recomputeQuoteTotals(quoteId, organizationId, tx as unknown as Prisma.TransactionClient);

			return item;
		});

		return { err: "", item: created };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Insert quote line item error");
		return { err: "Internal server error" };
	}
};

export const updateQuoteItem = async (
	quoteId: string,
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateQuoteItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.quote_line_item.findFirst({
			where: { id: itemId, quote_id: quoteId },
		});

		if (!existing) {
			return { err: "Item not found" };
		}

		const changes = buildChanges(existing, parsed, [
			"name",
			"description",
			"item_type",
			"sort_order",
			"quantity",
			"unit_price",
			"total",
		] as const);

		const updated = await sdb.$transaction(async (tx) => {
			await assertInventoryItemsInOrg(tx, organizationId, [
				parsed.inventory_item_id,
			]);

			// Recalculate total if quantity or unit_price changed
			let total = parsed.total;
			if (total === undefined) {
				const newQuantity =
					parsed.quantity !== undefined
						? parsed.quantity
						: Number(existing.quantity);
				const newUnitPrice =
					parsed.unit_price !== undefined
						? parsed.unit_price
						: Number(existing.unit_price);
				total = newQuantity * newUnitPrice;
			}

			const item = await tx.quote_line_item.update({
				where: { id: itemId },
				data: {
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.description !== undefined && {
						description: parsed.description,
					}),
					...(parsed.quantity !== undefined && {
						quantity: parsed.quantity,
					}),
					...(parsed.unit_price !== undefined && {
						unit_price: parsed.unit_price,
					}),
					total: total,
					...(parsed.item_type !== undefined && {
						item_type: parsed.item_type,
					}),
					...(parsed.sort_order !== undefined && {
						sort_order: parsed.sort_order,
					}),
					...(parsed.inventory_item_id !== undefined && {
						inventory_item_id: parsed.inventory_item_id,
					}),
					...(parsed.tax_group_id !== undefined && {
						tax_group_id: parsed.tax_group_id,
					}),
					...(parsed.taxable !== undefined && {
						taxable: parsed.taxable,
					}),
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "quote_line_item.updated",
					action: "updated",
					entity_type: "quote_line_item",
					entity_id: itemId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes,
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			// Recompute quote totals after updating a line item
			await recomputeQuoteTotals(quoteId, organizationId, tx as unknown as Prisma.TransactionClient);

			return item;
		});

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Update quote line item error");
		return { err: "Internal server error" };
	}
};

export const deleteQuoteItem = async (
	quoteId: string,
	itemId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.quote_line_item.findFirst({
			where: {
				id: itemId,
				quote_id: quoteId,
			},
		});

		if (!existing) {
			return { err: "Item not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "quote_line_item.deleted",
				action: "deleted",
				entity_type: "quote_line_item",
				entity_id: itemId,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: existing.name, new: null },
					quote_id: { old: existing.quote_id, new: null },
					...parentBreadcrumb("quote", existing.quote_id),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.quote_line_item.delete({
				where: { id: itemId },
			});

			// Recompute quote totals after removing a line item
			await recomputeQuoteTotals(quoteId, organizationId, tx as unknown as Prisma.TransactionClient);
		});

		return { err: "", message: "Item deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Delete quote line item error");
		return { err: "Internal server error" };
	}
};
