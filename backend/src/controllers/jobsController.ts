import { ZodError } from "zod";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { fillCoords } from "../lib/geocode.js";
import { db } from "../db.js";
import { Prisma } from "../../generated/prisma/client.js";
import { emitToOrg } from "../services/socketService.js";
import {
	createJobSchema,
	updateJobSchema,
	createJobLineItemSchema,
	updateJobLineItemSchema,
} from "../lib/validate/jobs.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { LineItemToCreate, ChangeSet } from "../types/common.js";
import { assertInventoryItemsInOrg } from "../lib/inventory.js";
import {
	applyInventoryTaxable,
	applyInventoryTaxableToNewLines,
	lineTaxFieldsForCreate,
	lineTaxFieldsForUpdate,
} from "../lib/inventoryTaxable.js";
import { log } from "../services/appLogger.js";
import { generateJobNumber } from "../db.js";
import { DocumentRuleError } from "../lib/statusTransitions.js";
import {
	SOLD_BY_QUOTE_JOBS,
	soldJobReason,
	type DocumentShape,
} from "../services/disputeAdapters.js";
import { hasOpenDispute } from "../services/disputeService.js";
import { holdsKeptRate, recomputeJobTotals } from "../lib/recomputeDocumentTotals.js";
import { recomputeOpenVisits } from "../lib/recomputeOpenVisits.js";
import {
	AddressTaxChoiceError,
	addressMoves,
	addressTaxChoiceRefusal,
	applyAddressTaxChoiceToFamily,
	choiceActor,
	keptFamily,
} from "../lib/addressTaxChoice.js";
import { assertTaxGroupsInOrg } from "../lib/taxHelpers.js";
import {
	dropClientTaxTotals,
	getEffectiveTaxMode,
	type TaxMode,
} from "../services/tax/taxMode.js";

/**
 * Manual mode keeps today's client-computed job totals; auto mode, and a manual-mode job that
 * holds a kept address rate, are server-owned.
 */
async function recomputeJobIfServerTaxed(
	jobId: string,
	organizationId: string,
	tx: unknown,
	taxMode?: TaxMode,
	serverTaxed?: boolean,
): Promise<void> {
	const ptx = tx as Prisma.TransactionClient;
	const taxed =
		serverTaxed ??
		((taxMode ?? (await getEffectiveTaxMode(organizationId))) === "auto" ||
			(await holdsKeptRate("job", jobId, ptx)));
	if (!taxed) return;
	await recomputeJobTotals(jobId, organizationId, ptx);
}

// ============================================================================
// JOB CRUD
// ============================================================================

export const getAllJobs = async (organizationId: string) => {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
	const sdb = getScopedDb(organizationId);
	return await sdb.job.findMany({
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
			quote: {
				select: {
					id: true,
					quote_number: true,
					status: true,
					total: true,
				},
			},
			visits: {
				include: {
					visit_techs: {
						include: {
							tech: true,
						},
					},
					line_items: {
						orderBy: { sort_order: "asc" },
					},
				},
			},
			recurring_plan: {
				include: {
					rules: {
						include: {
							by_weekday: true,
						},
					},
					occurrences: {
						where: {
							occurrence_start_at: {
								gte: startOfToday,
							},
							status: "planned",
						},
						orderBy: { occurrence_start_at: "asc" },
					},
				},
			},
			line_items: {
							include: {
								tax_group: {
									select: {
										id: true,
										name: true,
										rates: {
											select: {
												tax_rate: {
													select: { id: true, name: true, rate: true },
												},
											},
											orderBy: { sort_order: "asc" as const },
										},
									},
								},
							},
						},
		},
		orderBy: { created_at: "desc" },
	});
};

export const getJobById = async (id: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.job.findFirst({
		where: { id },
		include: {
			client: {
				select: {
					id: true,
					name: true,
					address: true,
					coords: true,
					is_active: true,
					is_tax_exempt: true,
					tax_group_id: true,
					contacts: {
						where: {
							is_primary: true,
						},
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
			request: {
				select: {
					id: true,
					title: true,
					status: true,
					created_at: true,
				},
			},
			quote: {
				select: {
					id: true,
					quote_number: true,
					title: true,
					status: true,
					total: true,
					created_at: true,
					// A job with no snapshot of its own inherits the quote's kept rate.
					tax_snapshot: true,
				},
			},
			visits: {
				include: {
					visit_techs: {
						include: {
							tech: true,
						},
					},
					notes: true,
				},
			},
			line_items: {
							include: {
								tax_group: {
									select: {
										id: true,
										name: true,
										rates: {
											select: {
												tax_rate: {
													select: { id: true, name: true, rate: true },
												},
											},
											orderBy: { sort_order: "asc" as const },
										},
									},
								},
							},
						},
			recurring_plan: {
				select: {
					id: true,
					name: true,
					status: true,
					starts_at: true,
				},
			},
			notes: {
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
					visit: {
						select: {
							id: true,
							scheduled_start_at: true,
							scheduled_end_at: true,
							status: true,
						},
					},
				},
				orderBy: { created_at: "desc" },
			},
		},
	});
};

export const getJobsByClientId = async (clientId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.job.findMany({
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
			quote: {
				select: {
					id: true,
					quote_number: true,
					total: true,
				},
			},
			visits: {
				include: {
					visit_techs: {
						include: {
							tech: true,
						},
					},
				},
			},
		},
		orderBy: { created_at: "desc" },
	});
};

/** Mirrors QUOTE_TERMINAL in frontend/src/components/lifecycle/quoteActions.ts. */
const QUOTE_NOT_CONVERTIBLE: readonly string[] = ["Rejected", "Revised", "Expired", "Cancelled"];

/**
 * Why this quote can't become a job, or null. Conversion writes the quote to
 * Approved with no transition guard, so this is the whole server-side gate;
 * the page gates the same states, but a stale tab or a direct API call does not
 * go through the page.
 *
 * Under an open dispute the write is a deadlock rather than a status change:
 * resolveDispute needs the quote still Disputed, updateQuote refuses to move it
 * while the dispute is open, and the one-open-dispute index then blocks any new
 * dispute. Sold work converted again bills the client twice.
 *
 * Not assertValidQuoteTransition: that table has no Draft → Approved edge, yet
 * a Draft quote converts today, so the page's terminal list is mirrored instead.
 */
function quoteConversionRefusal(quote: DocumentShape, hasOpenDispute: boolean): string | null {
	if (hasOpenDispute || quote.status === "Disputed") {
		return "This quote is under dispute — resolve the dispute before converting it to a job.";
	}
	if (quote.job) return "A job was already created from this quote.";
	const sold = soldJobReason(quote);
	if (sold) return sold;
	if (QUOTE_NOT_CONVERTIBLE.includes(quote.status)) {
		const status = quote.status.toLowerCase();
		const article = /^[aeiou]/.test(status) ? "An" : "A";
		return `${article} ${status} quote can't be converted to a job.`;
	}
	return null;
}

export const insertJob = async (req: Request, context?: UserContext) => {
	try {
		const organizationId = req.user!.organization_id as string;
		const taxMode = await getEffectiveTaxMode(organizationId);
		const sdb = getScopedDb(organizationId);
		const raw = createJobSchema.parse(req.body);
		// A quote-converted job inherits its quote's kept rate, so it is server-taxed from the start.
		const kept =
			taxMode !== "auto" &&
			!!raw.quote_id &&
			(await holdsKeptRate("quote", raw.quote_id, sdb as unknown as Prisma.TransactionClient));
		const parsed = kept ? dropClientTaxTotals(raw, "auto") : raw;
		const geoErr = await fillCoords(parsed, true);
		if (geoErr) return { err: geoErr };
		let created: Awaited<ReturnType<typeof db.job.findFirst>> | undefined;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				created = await sdb.$transaction(async (tx) => {
			const client = await tx.client.findUnique({
				where: { id: parsed.client_id },
			});

			if (!client) {
				throw new Error("Client not found");
			}

			if (parsed.tech_ids && parsed.tech_ids.length > 0) {
				const existingTechs = await tx.technician.findMany({
					where: { id: { in: parsed.tech_ids }, deactivated_at: null },
					select: { id: true },
				});
				const existingIds = new Set(existingTechs.map((t) => t.id));
				const missing = parsed.tech_ids.filter(
					(id) => !existingIds.has(id),
				);
				if (missing.length > 0) {
					throw new Error(
						`Technicians not found or deactivated: ${missing.join(", ")}`,
					);
				}
			}

			// Initialize job data with parsed values
			let name = parsed.name;
			let description = parsed.description;
			let address = parsed.address;
			let coords: { lat: number; lon: number } | undefined =
				parsed.coords;
			let priority = parsed.priority;
			let estimatedTotal = parsed.estimated_total;
			let subtotal = parsed.subtotal;
			let taxRate = parsed.tax_rate;
			let taxAmount = parsed.tax_amount;
			let discountType = parsed.discount_type;
			let discountValue = parsed.discount_value;
			let discountAmount = parsed.discount_amount;
			let lineItemsToCreate: LineItemToCreate[] = [];

			// If linked to quote, inherit fields and prepare line items
			if (parsed.quote_id) {
				const quote = await tx.quote.findUnique({
					where: { id: parsed.quote_id },
					include: {
						line_items: {
							orderBy: { sort_order: "asc" },
						},
						job: { select: { id: true } },
						request: { include: { jobs: SOLD_BY_QUOTE_JOBS } },
					},
				});

				if (!quote) {
					throw new Error("Quote not found");
				}

				const refusal = quoteConversionRefusal(
					quote as unknown as DocumentShape,
					await hasOpenDispute(
						tx as unknown as Prisma.TransactionClient,
						"quote",
						quote.id,
					),
				);
				if (refusal) throw new DocumentRuleError(refusal);

				if (!name) name = quote.title;
				if (!description) description = quote.description;
				if (!address) address = quote.address;
				if (!coords && quote.coords) {
					coords = quote.coords as { lat: number; lon: number };
				}
				if (!priority) priority = quote.priority;
				if (!estimatedTotal) estimatedTotal = Number(quote.total);

				// Copy financial fields from quote if not provided
				if (subtotal === undefined)
					subtotal = quote.subtotal
						? Number(quote.subtotal)
						: undefined;
				if (taxRate === undefined)
					taxRate = quote.tax_rate
						? Number(quote.tax_rate)
						: undefined;
				if (taxAmount === undefined)
					taxAmount = quote.tax_amount
						? Number(quote.tax_amount)
						: undefined;
				if (discountType === undefined)
					discountType =
						(quote.discount_type as "percent" | "amount" | null) ||
						undefined;
				if (discountValue === undefined && quote.discount_value)
					discountValue = Number(quote.discount_value);
				if (discountAmount === undefined)
					discountAmount = quote.discount_amount
						? Number(quote.discount_amount)
						: undefined;

				// The catalog link rides along, or it dies at conversion.
				lineItemsToCreate = quote.line_items.map((item) => ({
					name: item.name,
					description: item.description,
					quantity: Number(item.quantity),
					unit_price: Number(item.unit_price),
					total: Number(item.total),
					source: "quote" as const,
					item_type: item.item_type,
					inventory_item_id: item.inventory_item_id,
					tax_group_id: item.tax_group_id,
					taxable: item.taxable,
				}));

				await tx.quote.update({
					where: { id: parsed.quote_id },
					data: { status: "Approved" },
				});

				await logActivity({
					event_type: "quote.converted",
					action: "converted",
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
						status: { old: quote.status, new: "Approved" },
					},
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});

				if (quote.request_id) {
					await tx.request.update({
						where: { id: quote.request_id },
						data: { status: "ConvertedToJob" },
					});

					await logActivity({
						event_type: "request.converted",
						action: "converted",
						entity_type: "request",
						entity_id: quote.request_id,
						organization_id: organizationId,
						actor_type: context?.techId
							? "technician"
							: context?.dispatcherId
								? "dispatcher"
								: "system",
						actor_id: context?.techId || context?.dispatcherId,
						changes: {
							status: { old: quote.request?.status ?? null, new: "ConvertedToJob" },
						},
						ip_address: context?.ipAddress,
						user_agent: context?.userAgent,
					});
				}
			}
			// If linked to request directly (no quote), inherit from request
			else if (parsed.request_id) {
				const request = await tx.request.findUnique({
					where: { id: parsed.request_id },
				});

				if (!request) {
					throw new Error("Request not found");
				}

				if (!name) name = request.title;
				if (!description) description = request.description;
				if (!address && request.address) address = request.address;
				if (!coords && request.coords) {
					coords = request.coords as { lat: number; lon: number };
				}
				if (!priority) priority = request.priority;
				if (request.estimated_value) {
					estimatedTotal = Number(request.estimated_value);
				}

				await tx.request.update({
					where: { id: parsed.request_id },
					data: { status: "ConvertedToJob" },
				});

				await logActivity({
					event_type: "request.converted",
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
						status: { old: request.status, new: "ConvertedToJob" },
					},
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			// If line_items provided directly in request, use those
			if (parsed.line_items && parsed.line_items.length > 0) {
				await assertInventoryItemsInOrg(
					tx,
					organizationId,
					parsed.line_items.map((i) => i.inventory_item_id),
				);
				await assertTaxGroupsInOrg(
					tx as unknown as Prisma.TransactionClient,
					organizationId,
					parsed.line_items.map((i) => i.tax_group_id),
				);
				const bodyLines = await applyInventoryTaxable(
					tx,
					organizationId,
					parsed.line_items,
				);
				lineItemsToCreate = bodyLines.map((item) => ({
					name: item.name,
					description: item.description || null,
					quantity: item.quantity,
					unit_price: item.unit_price,
					total: item.total ?? item.quantity * item.unit_price,
					source: "manual" as const,
					item_type: item.item_type || null,
					inventory_item_id: item.inventory_item_id ?? null,
					...lineTaxFieldsForCreate(item),
				}));
			}

			if (!address) {
				throw new Error("Address is required for job");
			}
			if (!coords) {
				throw new Error("Coordinates are required for job");
			}
			if (!name) {
				throw new Error("Job name is required");
			}
			if (!description) {
				throw new Error("Job description is required");
			}

			const jobNumber = await generateJobNumber(tx, organizationId);

			const job = await tx.job.create({
				data: {
					organization_id: organizationId,
					job_number: jobNumber,
					name: name,
					description: description,
					priority: priority,
					client_id: parsed.client_id,
					address: address,
					coords: coords,
					status: parsed.status || "Unscheduled",
					request_id: parsed.request_id || null,
					quote_id: parsed.quote_id || null,
					recurring_plan_id: parsed.recurring_plan_id || null,
					...(subtotal !== undefined && { subtotal }),
					...(taxRate !== undefined && { tax_rate: taxRate }),
					...(taxAmount !== undefined && { tax_amount: taxAmount }),
					...(discountType !== undefined && {
						discount_type: discountType,
					}),
					...(discountValue !== undefined && {
						discount_value: discountValue,
					}),
					...(discountAmount !== undefined && {
						discount_amount: discountAmount,
					}),
					...(estimatedTotal !== undefined && {
						estimated_total: estimatedTotal,
					}),
				},
			});

			//Create line items (from quote OR from request body)
			if (lineItemsToCreate.length > 0) {
				await tx.job_line_item.createMany({
					data: lineItemsToCreate.map((item) => ({
						job_id: job.id,
						name: item.name,
						description: item.description,
						quantity: item.quantity,
						unit_price: item.unit_price,
						total: item.total ?? item.quantity * item.unit_price,
						source: item.source ?? "manual",
						item_type: item.item_type,
						inventory_item_id: item.inventory_item_id ?? null,
						...lineTaxFieldsForCreate(item),
					})),
				});
			}

			await tx.client.update({
				where: { id: parsed.client_id },
				data: { last_activity: new Date() },
			});

			await logActivity({
				event_type: "job.created",
				action: "created",
				entity_type: "job",
				entity_id: job.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					job_number: { old: null, new: job.job_number },
					name: { old: null, new: job.name },
					priority: { old: null, new: job.priority },
					status: { old: null, new: job.status },
					client_id: { old: null, new: job.client_id },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			if (lineItemsToCreate.length > 0) {
				await recomputeJobIfServerTaxed(
					job.id,
					organizationId,
					tx,
					taxMode,
					taxMode === "auto" || kept,
				);
			}

			return tx.job.findUnique({
				where: { id: job.id },
				include: {
					client: {
						select: {
							id: true,
							name: true,
							address: true,
							coords: true,
							is_active: true,
							contacts: {
								where: {
									is_primary: true,
								},
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
					request: {
						select: {
							id: true,
							title: true,
							status: true,
							created_at: true,
						},
					},
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
					visits: {
						include: {
							visit_techs: {
								include: { tech: true },
							},
							notes: true,
						},
					},
					line_items: {
							include: {
								tax_group: {
									select: {
										id: true,
										name: true,
										rates: {
											select: {
												tax_rate: {
													select: { id: true, name: true, rate: true },
												},
											},
											orderBy: { sort_order: "asc" as const },
										},
									},
								},
							},
						},
					recurring_plan: {
						select: {
							id: true,
							name: true,
							status: true,
							starts_at: true,
						},
					},
					notes: {
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
							visit: {
								select: {
									id: true,
									scheduled_start_at: true,
									scheduled_end_at: true,
									status: true,
								},
							},
						},
						orderBy: { created_at: "desc" },
					},
				},
				});
				});
				break;
			} catch (e) {
				if (
					attempt < 4 &&
					e instanceof Prisma.PrismaClientKnownRequestError &&
					e.code === "P2002" &&
					(e.meta?.target as string[] | undefined)?.includes("job_number")
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
		log.error({ err: e }, "Insert job error");
		return { err: "Internal server error" };
	}
};

export const updateJob = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const id = req.params.id as string;
		const taxMode = await getEffectiveTaxMode(organizationId);
		const sdb = getScopedDb(organizationId);
		const serverTaxed =
			taxMode === "auto" ||
			(await holdsKeptRate("job", id, sdb as unknown as Prisma.TransactionClient));
		// Review Focus 2: when server-taxed, the server's figures win even on a job with no lines.
		const parsed = dropClientTaxTotals(
			updateJobSchema.parse(req.body),
			serverTaxed ? "auto" : taxMode,
		);
		const geoErr = await fillCoords(parsed, true);
		if (geoErr) return { err: geoErr };

		const existing = await sdb.job.findFirst({
			where: { id },
			include: { line_items: true },
		});

		if (!existing) {
			return { err: "Job not found" };
		}

		const addressFamily =
			taxMode !== "auto" && addressMoves(req.body, parsed, existing)
				? await keptFamily(sdb as unknown as Prisma.TransactionClient, organizationId, {
						kind: "job",
						id,
					})
				: null;
		if (addressFamily && !parsed.address_tax_choice) {
			return { ...addressTaxChoiceRefusal(addressFamily), item: undefined };
		}

		const addressChanged =
			(parsed.address !== undefined && parsed.address !== existing.address) ||
			parsed.coords !== undefined;
		const discountChanged =
			parsed.discount_type !== undefined || parsed.discount_value !== undefined;

		// Exclude line_items from buildChanges (tracked separately for better detail)
		const { line_items: _lineItems, ...parsedWithoutLineItems } = parsed;

		// Track all job-level field changes
		const changes = buildChanges(existing, parsedWithoutLineItems, [
			"name",
			"description",
			"priority",
			"address",
			"status",
			"cancellation_reason",
			"subtotal",
			"tax_rate",
			"tax_amount",
			"discount_value",
			"discount_amount",
			"estimated_total",
			"actual_total",
			"discount_type",
			"coords",
		] as const);

		const statusChanged = parsed.status !== undefined && parsed.status !== existing.status;

		const updated = await sdb.$transaction(async (tx) => {
			// Recompute reads its inputs from the row, so they land first.
			if ((serverTaxed || addressFamily) && (addressChanged || discountChanged)) {
				await tx.job.update({
					where: { id },
					data: {
						...(parsed.address !== undefined && { address: parsed.address }),
						...(parsed.coords !== undefined && { coords: parsed.coords }),
						...(parsed.discount_type !== undefined && {
							discount_type: parsed.discount_type,
						}),
						...(parsed.discount_value !== undefined && {
							discount_value: parsed.discount_value,
						}),
					},
				});
			}

			// BULK LINE ITEMS UPDATE
			if (parsed.line_items !== undefined) {
				const incomingItems = parsed.line_items || [];
				await assertInventoryItemsInOrg(
					tx,
					organizationId,
					incomingItems.map((i) => i.inventory_item_id),
				);
				await assertTaxGroupsInOrg(
					tx as unknown as Prisma.TransactionClient,
					organizationId,
					incomingItems.map((i) => i.tax_group_id),
				);

				// Track existing and incoming item IDs
				const existingItemIds = new Set(
					existing.line_items.map((item) => item.id),
				);
				const incomingItemIds = new Set(
					incomingItems
						.filter((item) => item.id)
						.map((item) => item.id!),
				);
				// New lines take the inventory default; existing lines keep theirs.
				const withInventoryTaxable = await applyInventoryTaxableToNewLines(
					tx,
					organizationId,
					incomingItems,
					existingItemIds,
				);

				// DELETE: Items not in incoming list
				const itemsToDelete = existing.line_items.filter(
					(item) => !incomingItemIds.has(item.id),
				);

				for (const item of itemsToDelete) {
					await tx.job_line_item.delete({
						where: { id: item.id },
					});

					await logActivity({
						event_type: "job_line_item.deleted",
						action: "deleted",
						entity_type: "job_line_item",
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
							job_id: { old: item.job_id, new: null },
							...parentBreadcrumb("job", item.job_id),
						},
						ip_address: context?.ipAddress,
						user_agent: context?.userAgent,
					});
				}

				// CREATE OR UPDATE: Process incoming items
				for (const item of incomingItems) {
					if (item.id && existingItemIds.has(item.id)) {
						// UPDATE existing item
						const existingItem = existing.line_items.find(
							(i) => i.id === item.id,
						);

						if (existingItem) {
							// Track changes for this specific item
							const itemChanges: ChangeSet = {};

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
							// On a "same text, now points at the catalog" edit this is the whole
							// change — without it the write below never fires.
							const nextInventoryItemId =
								item.inventory_item_id ?? null;
							if (
								item.inventory_item_id !== undefined &&
								nextInventoryItemId !==
									existingItem.inventory_item_id
							) {
								itemChanges.inventory_item_id = {
									old: existingItem.inventory_item_id,
									new: nextInventoryItemId,
								};
							}
							if (item.taxable !== undefined && item.taxable !== existingItem.taxable) {
								itemChanges.taxable = {
									old: existingItem.taxable,
									new: item.taxable,
								};
							}
							if (
								item.tax_group_id !== undefined &&
								item.tax_group_id !== existingItem.tax_group_id
							) {
								itemChanges.tax_group_id = {
									old: existingItem.tax_group_id,
									new: item.tax_group_id,
								};
							}

							// Only update if there are actual changes
							if (Object.keys(itemChanges).length > 0) {
								await tx.job_line_item.update({
									where: { id: item.id },
									data: {
										name: item.name,
										description: item.description || null,
										quantity: item.quantity,
										unit_price: item.unit_price,
										total: item.total ?? item.quantity * item.unit_price,
										item_type: item.item_type || null,
										...(item.inventory_item_id !== undefined && {
											inventory_item_id: nextInventoryItemId,
										}),
										...lineTaxFieldsForUpdate(item),
									},
								});

								await logActivity({
									event_type: "job_line_item.updated",
									action: "updated",
									entity_type: "job_line_item",
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
						const newItem = await tx.job_line_item.create({
							data: {
								job_id: id,
								name: item.name,
								description: item.description || null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								total: item.total ?? item.quantity * item.unit_price,
								source: "manual",
								item_type: item.item_type || null,
								inventory_item_id: item.inventory_item_id ?? null,
								...lineTaxFieldsForCreate(withInventoryTaxable(item)),
							},
						});

						await logActivity({
							event_type: "job_line_item.created",
							action: "created",
							entity_type: "job_line_item",
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
								job_id: { old: null, new: id },
								quantity: { old: null, new: item.quantity },
								unit_price: { old: null, new: item.unit_price },
								total: { old: null, new: item.total },
							},
							ip_address: context?.ipAddress,
							user_agent: context?.userAgent,
						});
					}
				}
			}
			if (
				parsed.line_items !== undefined ||
				addressChanged ||
				discountChanged
			) {
				await recomputeJobIfServerTaxed(id, organizationId, tx, taxMode, serverTaxed);
			}
			if (addressFamily && parsed.address_tax_choice) {
				await applyAddressTaxChoiceToFamily(
					tx as unknown as Prisma.TransactionClient,
					organizationId,
					{ kind: "job", id },
					parsed.address_tax_choice,
					choiceActor(context),
				);
			}
			const job = await tx.job.update({
				where: { id },
				data: {
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.description !== undefined && {
						description: parsed.description,
					}),
					...(parsed.priority !== undefined && {
						priority: parsed.priority,
					}),
					...(parsed.address !== undefined && {
						address: parsed.address,
					}),
					...(parsed.coords !== undefined && {
						coords: parsed.coords,
					}),
					...(parsed.status !== undefined && {
						status: parsed.status,
					}),
					...(statusChanged && { status_changed_at: new Date() }),

					...(parsed.subtotal !== undefined && {
						subtotal: parsed.subtotal,
					}),
					...(parsed.tax_rate !== undefined && {
						tax_rate: parsed.tax_rate,
					}),
					...(parsed.tax_amount !== undefined && {
						tax_amount: parsed.tax_amount,
					}),
					...(parsed.discount_type !== undefined && {
						discount_type: parsed.discount_type,
					}),
					...(parsed.discount_value !== undefined && {
						discount_value: parsed.discount_value,
					}),
					...(parsed.discount_amount !== undefined && {
						discount_amount: parsed.discount_amount,
					}),
					...(parsed.estimated_total !== undefined && {
						estimated_total: parsed.estimated_total,
					}),
					...(parsed.actual_total !== undefined && {
						actual_total: parsed.actual_total,
					}),

					...(parsed.cancellation_reason !== undefined && {
						cancellation_reason: parsed.cancellation_reason,
					}),

					...(parsed.status === "Completed" &&
						!existing.completed_at && { completed_at: new Date() }),
					...(parsed.status === "Cancelled" &&
						!existing.cancelled_at && { cancelled_at: new Date() }),
				},
				include: {
					client: true,
					request: true,
					quote: true,
					visits: {
						include: {
							visit_techs: {
								include: { tech: true },
							},
						},
					},
					line_items: {
							include: {
								tax_group: {
									select: {
										id: true,
										name: true,
										rates: {
											select: {
												tax_rate: {
													select: { id: true, name: true, rate: true },
												},
											},
											orderBy: { sort_order: "asc" as const },
										},
									},
								},
							},
						},
					notes: true,
				},
			});

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "job.updated",
					action: "updated",
					entity_type: "job",
					entity_id: id,
					organization_id: organizationId,
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

			return job;
		});

		// Visits resolve from the job's address; the job's own commit comes first.
		if (taxMode === "auto" && addressChanged) {
			try {
				await recomputeOpenVisits(sdb, id, organizationId, "job edit");
			} catch (err) {
				log.error({ err, orgId: organizationId, jobId: id }, "Visit recompute after job edit failed");
			}
		}

		if (updated) {
			emitToOrg(organizationId, "job:updated", { jobId: id, organizationId });
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
		if (e instanceof AddressTaxChoiceError) return { err: e.message };
		log.error({ err: e }, "Update job error");
		return { err: "Internal server error" };
	}
};

export const deleteJob = async (id: string, organizationId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.job.findFirst({
			where: { id },
		});

		if (!existing) {
			return { err: "Job not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "job.deleted",
				action: "deleted",
				entity_type: "job",
				entity_id: id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					job_number: { old: existing.job_number, new: null },
					name: { old: existing.name, new: null },
					status: { old: existing.status, new: null },
					...(existing.project_id ? parentBreadcrumb("project", existing.project_id) : {}),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.job.delete({
				where: { id },
			});
		});

		return { err: "", item: { id } };
	} catch (e) {
		log.error({ err: e }, "Delete job error");
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
			return { err: "This job is on an invoice, so it can't be deleted. Cancel the job instead, or remove it from the invoice first." };
		}
		return { err: "Internal server error" };
	}
};

// ============================================================================
// JOB LINE ITEMS
// ============================================================================

export const getJobLineItems = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.job_line_item.findMany({
		where: { job_id: jobId },
		orderBy: { created_at: "asc" },
	});
};

export const getJobLineItemById = async (jobId: string, itemId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.job_line_item.findFirst({
		where: {
			id: itemId,
			job_id: jobId,
		},
	});
};

export const insertJobLineItem = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createJobLineItemSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const job = await sdb.job.findFirst({
			where: { id: jobId },
		});

		if (!job) {
			return { err: "Job not found" };
		}

		const created = await sdb.$transaction(async (tx) => {
			await assertInventoryItemsInOrg(tx, organizationId, [
				parsed.inventory_item_id,
			]);
			await assertTaxGroupsInOrg(tx as unknown as Prisma.TransactionClient, organizationId, [
				parsed.tax_group_id,
			]);

			// Calculate total if not provided
			const total =
				parsed.total !== undefined
					? parsed.total
					: parsed.quantity * parsed.unit_price;
			const [filled] = await applyInventoryTaxable(tx, organizationId, [parsed]);

			const item = await tx.job_line_item.create({
				data: {
					job_id: jobId,
					name: parsed.name,
					description: parsed.description || null,
					quantity: parsed.quantity,
					unit_price: parsed.unit_price,
					total: total,
					source: parsed.source || "manual",
					item_type: parsed.item_type || null,
					inventory_item_id: parsed.inventory_item_id ?? null,
					...lineTaxFieldsForUpdate(filled),
				},
			});
			await recomputeJobIfServerTaxed(jobId, organizationId, tx);

			await logActivity({
				event_type: "job_line_item.created",
				action: "created",
				entity_type: "job_line_item",
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
					job_id: { old: null, new: jobId },
					total: { old: null, new: total },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

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
		log.error({ err: e }, "Insert job line item error");
		return { err: "Internal server error" };
	}
};

export const updateJobLineItem = async (
	jobId: string,
	itemId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateJobLineItemSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.job_line_item.findFirst({
			where: {
				id: itemId,
				job_id: jobId,
			},
		});

		if (!existing) {
			return { err: "Item not found" };
		}

		const changes = buildChanges(existing, parsed, [
			"name",
			"description",
			"source",
			"item_type",
		] as const);

		// Manually track numeric fields (Decimal type)
		if (
			parsed.quantity !== undefined &&
			Number(existing.quantity) !== parsed.quantity
		) {
			changes.quantity = { old: existing.quantity, new: parsed.quantity };
		}
		if (
			parsed.unit_price !== undefined &&
			Number(existing.unit_price) !== parsed.unit_price
		) {
			changes.unit_price = {
				old: existing.unit_price,
				new: parsed.unit_price,
			};
		}
		if (
			parsed.total !== undefined &&
			Number(existing.total) !== parsed.total
		) {
			changes.total = { old: existing.total, new: parsed.total };
		}

		const updated = await sdb.$transaction(async (tx) => {
			await assertInventoryItemsInOrg(tx, organizationId, [
				parsed.inventory_item_id,
			]);
			await assertTaxGroupsInOrg(tx as unknown as Prisma.TransactionClient, organizationId, [
				parsed.tax_group_id,
			]);

			// Recalculate total if quantity or unit_price changed
			const total =
				parsed.total ??
				(parsed.quantity ?? Number(existing.quantity)) *
					(parsed.unit_price ?? Number(existing.unit_price));

			const item = await tx.job_line_item.update({
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
					...(parsed.source !== undefined && {
						source: parsed.source,
					}),
					...(parsed.item_type !== undefined && {
						item_type: parsed.item_type,
					}),
					...(parsed.inventory_item_id !== undefined && {
						inventory_item_id: parsed.inventory_item_id,
					}),
					...lineTaxFieldsForUpdate(parsed),
				},
			});
			await recomputeJobIfServerTaxed(jobId, organizationId, tx);

			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "job_line_item.updated",
					action: "updated",
					entity_type: "job_line_item",
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
		log.error({ err: e }, "Update job line item error");
		return { err: "Internal server error" };
	}
};

export const deleteJobLineItem = async (
	jobId: string,
	itemId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.job_line_item.findFirst({
			where: {
				id: itemId,
				job_id: jobId,
			},
		});

		if (!existing) {
			return { err: "Item not found" };
		}

		await sdb.$transaction(async (tx) => {
			await logActivity({
				event_type: "job_line_item.deleted",
				action: "deleted",
				entity_type: "job_line_item",
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
					job_id: { old: existing.job_id, new: null },
					...parentBreadcrumb("job", existing.job_id),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.job_line_item.delete({
				where: { id: itemId },
			});
			await recomputeJobIfServerTaxed(jobId, organizationId, tx);
		});

		return { err: "", message: "Item deleted successfully" };
	} catch (error) {
		log.error({ err: error }, "Delete job line item error");
		return { err: "Internal server error" };
	}
};
