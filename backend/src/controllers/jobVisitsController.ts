import { ZodError } from "zod";
import { Prisma } from "../../generated/prisma/client.js";
import type { tech_visit_status, technician_status, visit_status } from "../../generated/prisma/client.js";
import { db } from "../db.js";
import { getScopedDb, type UserContext } from "../lib/context.js";
import { recordDrive } from "../lib/visitDrive.js";
import {
	applyInventoryTaxable,
	applyInventoryTaxableToNewLines,
	lineTaxFieldsForCreate,
	lineTaxFieldsForUpdate,
} from "../lib/inventoryTaxable.js";
import { findForeignTaxGroupIds } from "../lib/taxHelpers.js";
import {
	createJobVisitSchema,
	updateJobVisitSchema,
} from "../lib/validate/jobVisits.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { log } from "../services/appLogger.js";
import { deleteStoredFiles } from "../lib/deleteStoredFiles.js";
import { onVisitScheduled, onVisitRescheduled } from "../services/followupTriggers.js";
import {
	notifyVisitRescheduled,
	notifyVisitScheduled,
	retimeVisitReminders,
} from "../services/customerComms/visitEvents.js";
import { createNotification } from "./notificationsController.js";
import { emitToOrg } from "../services/socketService.js";
import { recomputeVisitTotals } from "../lib/recomputeDocumentTotals.js";
import {
	findForeignInventoryItemIds,
	dispositionFields,
	plannedLineItemFields,
	foreignDispositionVehicleIds,
	unknownInventoryItemsMessage,
} from "../lib/inventory.js";
import { applyOdometerIncrement, fetchRouteDistanceMiles } from "../lib/vehicleMileage.js";
import { formatLocalDate, formatLocalTime } from "../lib/formatLocal.js";
import {
	HTTP_TRANSITION_ACTIONS,
	NEEDS_TECH,
	VISIT_TRANSITIONS,
	actionForStatusChange,
	actorOf,
	type VisitAction,
} from "../services/visitLifecycle/transitions.js";
import {
	LifecycleRefusal,
	applyStatusChange,
	runPostCommit,
	syncJobFromVisits,
	type PostCommitEffects,
} from "../services/visitLifecycle/index.js";

export class VisitConflictError extends Error {
	constructor(readonly currentUpdatedAt: Date | null) {
		super("This visit was changed by someone else.");
		this.name = "VisitConflictError";
	}
}

export const buildSecondaryEventPayload = (
	visit: {
		id: string;
		name: string | null;
		scheduled_start_at: Date;
		status: string;
		job_id: string;
		job: { id?: string; client: { name: string } };
		visit_techs: Array<{ tech_id: string; tech: { name: string } }>;
	},
	techAction: string,
	context?: UserContext,
) => {
	let actor: { type: "technician" | "dispatcher"; name: string | null; id: string } | null = null;
	if (context?.techId) {
		const techEntry = visit.visit_techs.find((vt) => vt.tech_id === context.techId);
		actor = { type: "technician", name: techEntry?.tech.name ?? null, id: context.techId };
	}
	return {
		visitStatusChanged: false,
		visitStatus: techAction,
		previousVisitStatus: visit.status,
		actor,
		visit: {
			id: visit.id,
			name: visit.name,
			scheduledAt: visit.scheduled_start_at.toISOString(),
			job: { id: visit.job_id, client: { name: visit.job.client.name } },
		},
		changedAt: new Date().toISOString(),
	};
};


export const buildVisitStatusPayload = (
	visit: {
		id: string;
		name: string | null;
		scheduled_start_at: Date;
		status: string;
		job_id: string;
		job: { id?: string; client: { name: string } };
		visit_techs: Array<{ tech_id: string; tech: { name: string } }>;
	},
	previousStatus: string,
	visitStatusChanged: boolean,
	context?: UserContext,
) => {
	let actor: { type: "technician" | "dispatcher"; name: string | null; id: string } | null = null;
	if (context?.techId) {
		const techEntry = visit.visit_techs.find((vt) => vt.tech_id === context.techId);
		actor = { type: "technician", name: techEntry?.tech.name ?? null, id: context.techId };
	} else if (context?.dispatcherId) {
		actor = { type: "dispatcher", name: null, id: context.dispatcherId };
	}
	return {
		visitStatusChanged,
		visitStatus: visit.status,
		previousVisitStatus: previousStatus,
		actor,
		visit: {
			id: visit.id,
			name: visit.name,
			scheduledAt: visit.scheduled_start_at.toISOString(),
			job: { id: visit.job_id, client: { name: visit.job.client.name } },
		},
		changedAt: new Date().toISOString(),
	};
};

/**
 * The technician's own current work, as thin as a picker needs. Deliberately not
 * `getAllJobVisits`, which returns every visit in the org with client, project,
 * techs, line items, time entries and notes attached: megabytes over a truck's
 * connection, and it handed a technician every client in the company. Cancelled
 * visits are dropped - nobody buys parts for work that was called off.
 */
export const getMyJobsForPurchase = async (organization_id: string, technicianId: string) => {
	const sdb = getScopedDb(organization_id);
	const visits = await sdb.job_visit.findMany({
		where: {
			status: { not: "Cancelled" },
			visit_techs: { some: { tech_id: technicianId } },
		},
		select: {
			id: true,
			name: true,
			job_id: true,
			scheduled_start_at: true,
			job: { select: { id: true, name: true, job_number: true } },
		},
		orderBy: { scheduled_start_at: "desc" },
	});

	// One row per job, keeping its most recent visit: a purchase attaches to the
	// job, and the visit is only there to say which one carries the charge.
	const byJob = new Map<string, (typeof visits)[number]>();
	for (const v of visits) if (!byJob.has(v.job_id)) byJob.set(v.job_id, v);

	return [...byJob.values()].map((v) => ({
		job_id: v.job_id,
		job_name: v.job?.name ?? null,
		job_number: v.job?.job_number ?? null,
		visit_id: v.id,
		visit_name: v.name,
		scheduled_start_at: v.scheduled_start_at,
	}));
};

// techId limits results to visits that tech is assigned to.
const assignedTo = (techId?: string) => (techId ? { visit_techs: { some: { tech_id: techId } } } : {});

export const getAllJobVisits = async (organization_id: string, filters?: { clientId?: string; limit?: number; sort?: "asc" | "desc"; techId?: string }) => {
	const sdb = getScopedDb(organization_id);
	return await sdb.job_visit.findMany({
		where: {
			...(filters?.clientId && { job: { client_id: filters.clientId } }),
			...assignedTo(filters?.techId),
		},
		include: {
			job: {
				include: {
					client: true,
					project: {
						select: { id: true, project_number: true, status: true, name: true },
					}
				},
			},
			visit_techs: {
				include: {
					tech: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			time_entries: {
				orderBy: { clocked_in_at: "asc" },
				include: {
					tech: { select: { id: true, name: true } },
				},
			},
			notes: true,
		},
		orderBy: { scheduled_start_at: filters?.sort ?? "asc" },
		...(filters?.limit && { take: filters.limit }),
	});
};

export const getJobVisitById = async (id: string, organization_id: string) => {
	const sdb = getScopedDb(organization_id);
	return await sdb.job_visit.findFirst({
		where: { id: id },
		include: {
			job: {
				include: {
					client: {
						include: {
							contacts: {
								where: { is_primary: true },
								include: {
									contact: {
										select: {
											id: true,
											name: true,
											email: true,
											phone: true,
											type: true,
										},
									},
								},
								take: 1,
							},
						},
					},
					quote: true,
					project: {
						select: { id: true, project_number: true, status: true, name: true },
					}
				},
			},
			visit_techs: {
				include: {
					tech: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
				include: {
					tax_group: {
						select: {
							id: true,
							name: true,
							rates: {
								include: {
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
			time_entries: {
				orderBy: { clocked_in_at: "asc" },
				include: {
					tech: { select: { id: true, name: true } },
				},
			},
			notes: true,
			invoice_visits: {
				select: {
					billed_amount: true,
					invoice: {
						select: {
							id: true,
							invoice_number: true,
							status: true,
							issue_date: true,
						},
					},
				},
			},
		},
	});
};

export const getJobVisitsByJobId = async (jobId: string, organization_id: string) => {
	const sdb = getScopedDb(organization_id);
	return await sdb.job_visit.findMany({
		where: { job_id: jobId },
		include: {
			visit_techs: {
				include: {
					tech: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
				include: {
					tax_group: {
						select: {
							id: true,
							name: true,
							rates: {
								include: {
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
			_count: {
				select: {
					invoice_visits: {
						where: {
							invoice: { status: { notIn: ["Draft", "Void"] } },
						},
					},
				},
			},
		},
		orderBy: {
			scheduled_start_at: "asc",
		},
	});
};

export const getJobVisitsByTechId = async (techId: string, organization_id: string) => {
	const sdb = getScopedDb(organization_id);
	return await sdb.job_visit.findMany({
		where: {
			visit_techs: {
				some: {
					tech_id: techId,
				},
			},
		},
		include: {
			job: {
				include: {
					client: true,
					project: {
						select: { id: true, project_number: true, status: true, name: true },
					}
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			time_entries: {
				orderBy: { clocked_in_at: "asc" },
				include: {
					tech: { select: { id: true, name: true } },
				},
			},
			visit_techs: {
				include: {
					tech: true,
				},
			},
			notes: true,
		},
		orderBy: {
			scheduled_start_at: "asc",
		},
	});
};

export const getJobVisitsByDateRange = async (
	startDate: Date,
	endDate: Date,
	organization_id: string,
	techId?: string,
) => {
	const sdb = getScopedDb(organization_id);
	return await sdb.job_visit.findMany({
		where: {
			...assignedTo(techId),
			OR: [
				{
					scheduled_start_at: {
						gte: startDate,
						lte: endDate,
					},
				},
				{
					scheduled_end_at: {
						gte: startDate,
						lte: endDate,
					},
				},
			],
		},
		include: {
			job: {
				include: {
					client: true,
				},
			},
			visit_techs: {
				include: {
					tech: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			notes: true,
		},
		orderBy: {
			scheduled_start_at: "asc",
		},
	});
};

export const insertJobVisit = async (req: Request, organization_id: string, context?: UserContext) => {
	try {
		const parsed = createJobVisitSchema.parse(req.body);
		const sdb = getScopedDb(organization_id);
		const job = await sdb.job.findFirst({
			where: { id: parsed.job_id },
		});

		if (!job) {
			return { err: "Invalid job id" };
		}

		if (parsed.tech_ids && parsed.tech_ids.length > 0) {
			const existingTechs = await sdb.technician.findMany({
				where: { id: { in: parsed.tech_ids }, deactivated_at: null },
				select: { id: true },
			});
			const existingIds = new Set(existingTechs.map((t) => t.id));
			const missing = parsed.tech_ids.filter(
				(id) => !existingIds.has(id),
			);
			if (missing.length > 0) {
				return {
					err: `Technicians not found or deactivated: ${missing.join(", ")}`,
				};
			}
		}

		if (parsed.line_items && parsed.line_items.length > 0) {
			const foreignGroups = await findForeignTaxGroupIds(
				sdb,
				organization_id,
				parsed.line_items.map((li) => li.tax_group_id),
			);
			if (foreignGroups.length > 0) {
				return { err: `Tax group not found: ${foreignGroups.join(", ")}` };
			}
			const foreignItems = await findForeignInventoryItemIds(
				sdb,
				organization_id,
				parsed.line_items.map((li) => li.inventory_item_id),
			);
			if (foreignItems.length > 0) {
				return { err: unknownInventoryItemsMessage(foreignItems) };
			}
			const foreignVehicles = await foreignDispositionVehicleIds(
				sdb,
				organization_id,
				parsed.line_items.map((li) => li.disposition_vehicle_id),
			);
			if (foreignVehicles.length > 0) {
				return { err: `Validation failed: unknown vehicle ${foreignVehicles.join(", ")}` };
			}
		}

		const result = await sdb.$transaction(async (tx) => {
			const visit = await tx.job_visit.create({
				data: {
					job_id: parsed.job_id,
					name: parsed.name,
					description: parsed.description ?? null,

					arrival_constraint: parsed.arrival_constraint,
					finish_constraint: parsed.finish_constraint,
					scheduled_start_at: parsed.scheduled_start_at,
					scheduled_end_at: parsed.scheduled_end_at,
					arrival_time: parsed.arrival_time ?? null,
					arrival_window_start: parsed.arrival_window_start ?? null,
					arrival_window_end: parsed.arrival_window_end ?? null,
					finish_time: parsed.finish_time ?? null,
				},
			});

			if (parsed.tech_ids && parsed.tech_ids.length > 0) {
				await tx.job_visit_technician.createMany({
					data: parsed.tech_ids.map((tech_id) => ({
						visit_id: visit.id,
						tech_id,
					})),
					skipDuplicates: true,
				});
			}

			// ── Create line items ─────────────────────────────────────────────
			if (parsed.line_items && parsed.line_items.length > 0) {
				const lineItems = await applyInventoryTaxable(
					tx,
					organization_id,
					parsed.line_items,
				);
				await tx.job_visit_line_item.createMany({
					data: lineItems.map((li, index) => ({
						visit_id: visit.id,
						name: li.name,
						description: li.description ?? null,
						quantity: li.quantity,
						unit_price: li.unit_price,
						total: li.total ?? parseFloat((li.quantity * li.unit_price).toFixed(2)),
						item_type: li.item_type ?? null,
						sort_order: li.sort_order ?? index,
						source: "manual" as const,
						...lineTaxFieldsForCreate(li),
						...plannedLineItemFields(li.inventory_item_id, li.quantity, li),
					})),
				});
				await recomputeVisitTotals(visit.id, organization_id, tx as unknown as Prisma.TransactionClient);
			}

			// Visit row first, then the job lock inside the sync: the same order
			// as every status change. A new open visit reopens a Completed or
			// Cancelled job, and clears its stamps.
			const jobChange = await syncJobFromVisits(tx as unknown as Prisma.TransactionClient, organization_id, parsed.job_id, {
				context,
			});

			await logActivity({
				event_type: "job_visit.created",
				action: "created",
				entity_type: "job_visit",
				entity_id: visit.id,
				organization_id: organization_id,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: null, new: visit.name },
					description: { old: null, new: visit.description },
					arrival_constraint: {
						old: null,
						new: visit.arrival_constraint,
					},
					finish_constraint: {
						old: null,
						new: visit.finish_constraint,
					},
					scheduled_start_at: {
						old: null,
						new: visit.scheduled_start_at,
					},
					scheduled_end_at: {
						old: null,
						new: visit.scheduled_end_at,
					},
					status: { old: null, new: visit.status },
					...parentBreadcrumb("job", parsed.job_id),
					_job_number: { old: null, new: job.job_number },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			const item = await tx.job_visit.findFirst({
				where: { id: visit.id },
				include: {
					job: {
						include: {
							client: true,
						},
					},
					visit_techs: {
						include: { tech: true },
					},
					line_items: {
						orderBy: { sort_order: "asc" },
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
			return { item, jobChange };
		});

		const created = result?.item;
		if (created) {
			emitToOrg(organization_id, "job_visit:created", { visitId: created.id, organizationId: organization_id });
			if (result?.jobChange) emitToOrg(organization_id, "job:updated", { jobId: created.job_id, organizationId: organization_id });
			// Best-effort: schedule client reminders from any active visit_scheduled sequences.
			onVisitScheduled(created.id, organization_id);
			void notifyVisitScheduled(created.id, organization_id);
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
		log.error({ err: e }, "Error inserting job visit");
		throw e;
	}
};

export const updateJobVisit = async (req: Request, organizationId: string, context?: UserContext) => {
	try {
		const id = req.params.id as string;
		const parsed = updateJobVisitSchema.parse(req.body);
		const sdb = getScopedDb(organizationId);
		const existingVisit = await sdb.job_visit.findFirst({
			where: { id, job: { organization_id: organizationId } },
			include: {
				job: true,
				line_items: {
					select: {
						id: true,
						fulfillment_status: true,
						inventory_item_id: true,
					},
				},
				visit_techs: true,
			},
		});

		if (!existingVisit) {
			return { err: "Job visit not found" };
		}

		// G22: verify all supplied tax_group_ids belong to this org before mutating
		if (parsed.line_items && parsed.line_items.length > 0) {
			const foreignGroups = await findForeignTaxGroupIds(
				sdb,
				organizationId,
				parsed.line_items.map((li) => li.tax_group_id),
			);
			if (foreignGroups.length > 0) {
				return { err: `Tax group not found: ${foreignGroups.join(", ")}` };
			}

			// Returned, not thrown: the catch below collapses every non-Zod Error.
			const foreignItems = await findForeignInventoryItemIds(
				sdb,
				organizationId,
				parsed.line_items.map((li) => li.inventory_item_id),
			);
			if (foreignItems.length > 0) {
				return { err: unknownInventoryItemsMessage(foreignItems) };
			}
			const foreignVehicles = await foreignDispositionVehicleIds(
				sdb,
				organizationId,
				parsed.line_items.map((li) => li.disposition_vehicle_id),
			);
			if (foreignVehicles.length > 0) {
				return { err: `Validation failed: unknown vehicle ${foreignVehicles.join(", ")}` };
			}
		}

		const changes = buildChanges(existingVisit, parsed, [
			"name",
			"description",
			"arrival_constraint",
			"finish_constraint",
			"scheduled_start_at",
			"scheduled_end_at",
			"arrival_time",
			"arrival_window_start",
			"arrival_window_end",
			"finish_time",
			"actual_start_at",
			"actual_end_at",
		] as const);

		// A stale form also carries a stale status; judge it as a conflict, not
		// as a transition from the fresh status. The in-tx CAS stays the authority.
		if (
			parsed.expected_updated_at !== undefined &&
			existingVisit.updated_at.getTime() !== new Date(parsed.expected_updated_at).getTime()
		) {
			return {
				err: new VisitConflictError(existingVisit.updated_at).message,
				code: "CONFLICT" as const,
				current_updated_at: existingVisit.updated_at.toISOString(),
			};
		}

		// The edit form always sends status; only a real change is a transition.
		const statusTo =
			parsed.status !== undefined && parsed.status !== existingVisit.status
				? parsed.status
				: undefined;
		const statusAction = statusTo
			? actionForStatusChange(existingVisit.status, statusTo, actorOf(context))
			: null;
		if (statusTo && !statusAction) {
			return {
				err: `Can't move a visit from ${existingVisit.status} to ${statusTo}.`,
				code: "WRONG_STATE" as const,
			};
		}
		// A PUT can't do the drive's destination switch or drive record, so it
		// mustn't send the customer the on-the-way notice either.
		if (statusAction === "drive") {
			return {
				err: "Use the drive action to start driving to a visit.",
				code: "WRONG_STATE" as const,
			};
		}

		let effects: PostCommitEffects | null = null;
		const updated = await sdb.$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;
			// ── Scalar field update ───────────────────────────────────────
			// Runs first so a stale token throws before any line item is
			// touched; the throw rolls the whole transaction back regardless.
			const scalarData = {
				...(parsed.name !== undefined && { name: parsed.name }),
				...(parsed.description !== undefined && {
					description: parsed.description,
				}),
				...(parsed.arrival_constraint !== undefined && {
					arrival_constraint: parsed.arrival_constraint,
				}),
				...(parsed.finish_constraint !== undefined && {
					finish_constraint: parsed.finish_constraint,
				}),
				...(parsed.scheduled_start_at !== undefined && {
					scheduled_start_at: parsed.scheduled_start_at,
				}),
				...(parsed.scheduled_end_at !== undefined && {
					scheduled_end_at: parsed.scheduled_end_at,
				}),
				...(parsed.arrival_time !== undefined && {
					arrival_time: parsed.arrival_time,
				}),
				...(parsed.arrival_window_start !== undefined && {
					arrival_window_start: parsed.arrival_window_start,
				}),
				...(parsed.arrival_window_end !== undefined && {
					arrival_window_end: parsed.arrival_window_end,
				}),
				...(parsed.finish_time !== undefined && {
					finish_time: parsed.finish_time,
				}),
				...(parsed.actual_start_at !== undefined && {
					actual_start_at: parsed.actual_start_at,
				}),
				...(parsed.actual_end_at !== undefined && {
					actual_end_at: parsed.actual_end_at,
				}),
			};
			if (parsed.expected_updated_at !== undefined) {
				const { count } = await tx.job_visit.updateMany({
					where: { id, updated_at: new Date(parsed.expected_updated_at) },
					// Explicit stamp: a line-items-only save must still move the token.
					data: { ...scalarData, updated_at: new Date() },
				});
				if (count === 0) {
					const current = await tx.job_visit.findFirst({
						where: { id },
						select: { updated_at: true },
					});
					throw new VisitConflictError(current?.updated_at ?? null);
				}
			} else {
				// Visit lock before any line or time-entry row, as every lifecycle writer does.
				await txc.$queryRaw`SELECT id FROM job_visit WHERE id = ${id} FOR NO KEY UPDATE`;
				await tx.job_visit.update({ where: { id }, data: scalarData });
			}

			// ── Line item replacement ─────────────────────────────────────
			// Full replace: incoming array is the source of truth.
			// Items with a matching id → update in place.
			// Items without an id → create new.
			// Existing items absent from the incoming array → delete.
			// If line_items is undefined (not sent), skip entirely — no change.
			if (parsed.line_items !== undefined) {
				const existingById = new Map(
					existingVisit.line_items.map((i) => [i.id, i]),
				);
				// Lines a technician already consumed: a stock_movement points at the row,
				// and the dispatch form doesn't render them, so without this guard the
				// delete pass below would wipe every one.
				const isConsumed = (lineId: string) =>
					existingById.get(lineId)?.fulfillment_status === "used";
				const incomingIds = new Set(
					parsed.line_items.filter((i) => i.id).map((i) => i.id!),
				);
				// New lines take the inventory default; existing lines keep theirs.
				const withInventoryTaxable = await applyInventoryTaxableToNewLines(
					tx,
					organizationId,
					parsed.line_items,
					existingById,
				);

				// Delete removed items
				for (const item of existingVisit.line_items) {
					if (!incomingIds.has(item.id) && !isConsumed(item.id)) {
						await tx.job_visit_line_item.delete({
							where: { id: item.id },
						});
					}
				}

				// Create or update
				for (const item of parsed.line_items) {
					if (item.id && isConsumed(item.id)) continue;
					const existingLine = item.id ? existingById.get(item.id) : undefined;
					if (existingLine) {
						// Update existing
						await tx.job_visit_line_item.update({
							where: { id: existingLine.id },
							data: {
								name: item.name,
								description: item.description ?? null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								total:
									item.total ??
									Number(item.quantity) *
										Number(item.unit_price),
								item_type: item.item_type ?? null,
								sort_order: item.sort_order ?? 0,
								// Omitted keeps the group and a manual toggle (technician parts editor).
								...lineTaxFieldsForUpdate(item),
								// Only when the catalog link actually moved, so a retitle or requantify
								// can't flip a tech's `voided` back to `planned`.
								...(item.inventory_item_id !== undefined &&
								item.inventory_item_id !==
									existingLine.inventory_item_id
									? plannedLineItemFields(
											item.inventory_item_id,
											item.quantity,
											item,
										)
									: // Link unchanged: qty_planned still follows the
										// quantity. Only while `planned` — `voided` keeps
										// its planned figure as the variance.
										existingLine.fulfillment_status ===
											"planned"
										? { qty_planned: item.quantity }
										: {}),
								// Applied on its own so switching a part to vendor-direct can't resurrect
								// a tech's `voided` as `planned`.
								...(item.disposition !== undefined
									? dispositionFields(item)
									: {}),
							},
						});
					} else {
						// Create new
						await tx.job_visit_line_item.create({
							data: {
								visit_id: id,
								name: item.name,
								description: item.description ?? null,
								quantity: item.quantity,
								unit_price: item.unit_price,
								total:
									item.total ??
									Number(item.quantity) *
										Number(item.unit_price),
								source: "manual",
								item_type: item.item_type ?? null,
								sort_order: item.sort_order ?? 0,
								...lineTaxFieldsForCreate(withInventoryTaxable(item)),
								...plannedLineItemFields(
									item.inventory_item_id,
									item.quantity,
									item,
								),
							},
						});
					}
				}
			}

			// ── Recompute visit totals ────────────────────────────────────
			if (parsed.line_items !== undefined) {
				await recomputeVisitTotals(id, organizationId, txc);
			}

			// After the line writes, so a completion bills and rolls up the edited lines.
			if (statusAction) {
				effects = await applyStatusChange(txc, {
					orgId: organizationId,
					visitId: id,
					action: statusAction,
					context,
				});
			}

			// ── Activity log ──────────────────────────────────────────────
			if (Object.keys(changes).length > 0) {
				await logActivity({
					event_type: "job_visit.updated",
					action: "updated",
					entity_type: "job_visit",
					entity_id: id,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: {
						...changes,
						...parentBreadcrumb("job", existingVisit.job_id),
						_job_number: { old: null, new: existingVisit.job.job_number },
					},
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			// Re-fetch with line_items so the response shape is complete
			return tx.job_visit.findFirst({
				where: { id },
				include: {
					job: { include: { client: true, quote: true } },
					visit_techs: { include: { tech: true } },
					line_items: {
						orderBy: { sort_order: "asc" },
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
		});

		const transition = effects as PostCommitEffects | null;
		if (transition) await runPostCommit(transition, context);

		// ── "This & all future" — shift future visits by the same delta ─────
		if (parsed.reschedule_scope === "future" && existingVisit.job.recurring_plan_id) {
			const oldStart = existingVisit.scheduled_start_at;
			const newStart = parsed.scheduled_start_at;
			if (oldStart && newStart) {
				const deltaMs = newStart.getTime() - oldStart.getTime();
				const futureVisits = await sdb.job_visit.findMany({
					where: {
						job: { recurring_plan_id: existingVisit.job.recurring_plan_id },
						scheduled_start_at: { gt: oldStart },
						id: { not: id },
						status: { notIn: ["Completed", "Cancelled"] },
					},
					select: { id: true, scheduled_start_at: true, scheduled_end_at: true },
				});
				if (futureVisits.length > 0) {
					await sdb.$transaction(
						futureVisits.map((v) =>
							sdb.job_visit.update({
								where: { id: v.id },
								data: {
									scheduled_start_at: new Date(v.scheduled_start_at.getTime() + deltaMs),
									...(v.scheduled_end_at && {
										scheduled_end_at: new Date(v.scheduled_end_at.getTime() + deltaMs),
									}),
									...(parsed.arrival_constraint !== undefined && { arrival_constraint: parsed.arrival_constraint }),
									...(parsed.arrival_time !== undefined && { arrival_time: parsed.arrival_time }),
									...(parsed.arrival_window_start !== undefined && { arrival_window_start: parsed.arrival_window_start }),
									...(parsed.arrival_window_end !== undefined && { arrival_window_end: parsed.arrival_window_end }),
									...(parsed.finish_constraint !== undefined && { finish_constraint: parsed.finish_constraint }),
									...(parsed.finish_time !== undefined && { finish_time: parsed.finish_time }),
								},
							}),
						),
					);
					emitToOrg(organizationId, "job_visit:updated", { visitId: null, organizationId });
					// One notice for the edited visit is enough; the rest only
					// need their reminders moved off the old times.
					for (const v of futureVisits) void retimeVisitReminders(v.id, organizationId);
				}
			}
		}

		// Notify assigned technicians if scheduled time changed
		if (
			updated &&
			parsed.scheduled_start_at !== undefined &&
			existingVisit.scheduled_start_at.getTime() !== parsed.scheduled_start_at.getTime()
		) {
			const clientName = updated.job.client.name;
			// The server's own zone is not the org's; format in the org's.
			const orgRow = await db.organization.findUniqueOrThrow({
				where: { id: organizationId },
				select: { timezone: true },
			});
			const tz = orgRow.timezone;
			const newTime = `${formatLocalDate(parsed.scheduled_start_at, tz)} at ${formatLocalTime(parsed.scheduled_start_at, tz)}`;
			const techIds = updated.visit_techs.map((vt: { tech_id: string }) => vt.tech_id);
			for (const techId of techIds) {
				await createNotification({
					technicianId: techId,
					type:         "visit_changed",
					title:        `Schedule changed: ${clientName}`,
					body:         `Your visit at ${clientName} has been rescheduled to ${newTime}.`,
					actionUrl:    `/technician/visits/${id}`,
				}, organizationId);
			}
		}

		if (updated && (Object.keys(changes).length > 0 || transition)) {
			emitToOrg(organizationId, "job_visit:updated", { visitId: updated.id, organizationId });
		}
		// Best-effort: keep visit reminders in sync with reschedules. The
		// cancel and restore notices come from runPostCommit.
		if (transition?.action !== "cancel") {
			const moved =
				parsed.scheduled_start_at !== undefined &&
				existingVisit.scheduled_start_at.getTime() !== parsed.scheduled_start_at.getTime();
			if (moved && parsed.scheduled_start_at)
				onVisitRescheduled(id, organizationId, parsed.scheduled_start_at);
			if (moved && transition?.action !== "restore") void notifyVisitRescheduled(id, organizationId);
		}
		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof VisitConflictError) {
			return {
				err: e.message,
				code: "CONFLICT" as const,
				current_updated_at: e.currentUpdatedAt?.toISOString() ?? null,
			};
		}
		if (e instanceof LifecycleRefusal) {
			if (e.code === "CONFLICT") {
				const current = await getScopedDb(organizationId).job_visit.findFirst({
					where: { id: req.params.id as string },
					select: { updated_at: true },
				});
				return {
					err: e.message,
					code: "CONFLICT" as const,
					current_updated_at: current?.updated_at.toISOString() ?? null,
				};
			}
			return { err: e.message, code: e.code };
		}
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Failed to update job visit");
		throw e;
	}
};

type ScopedDb = ReturnType<typeof getScopedDb>;

// A tech already on the visit stays assignable after deactivation; only new
// assignments must be active.
const loadAssignableTechs = async (sdb: ScopedDb, ids: string[], keep: Set<string>) => {
	if (ids.length === 0) return { techs: [], missing: [] as string[] };
	const techs = (
		await sdb.technician.findMany({
			where: { id: { in: ids } },
			select: { id: true, name: true, deactivated_at: true },
		})
	).filter((t) => t.deactivated_at === null || keep.has(t.id));
	const found = new Set(techs.map((t) => t.id));
	return { techs, missing: ids.filter((id) => !found.has(id)) };
};

const loadVisitWithTechs = (sdb: ScopedDb, visitId: string) =>
	sdb.job_visit.findFirst({
		where: { id: visitId },
		include: {
			job: { include: { client: true } },
			visit_techs: { include: { tech: true } },
			notes: true,
		},
	});

class AssignmentRefusal extends Error {
	constructor(message: string, readonly code?: "WRONG_STATE") {
		super(message);
	}
}

const needsTechMessage = (status: string) =>
	`Can't remove every technician while the visit is ${status}. Assign someone else first.`;
const clockedInMessage = (name: string) =>
	`${name} is clocked in on this visit. Clock them out first.`;

// The only assignment write. Rows not named in add/remove are never touched,
// so concurrent edits by two dispatchers both land and each tech keeps its
// tech_status.
export const patchVisitTechnicians = async (
	visitId: string,
	{ add = [], remove = [] }: { add?: string[]; remove?: string[] },
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const visit = await sdb.job_visit.findFirst({
			where: { id: visitId, job: { organization_id: organizationId } },
			include: {
				job: { select: { job_number: true } },
				visit_techs: {
					include: { tech: true },
				},
			},
		});

		if (!visit) {
			return { err: "Job visit not found", code: "NOT_FOUND" as const };
		}

		// This read is unlocked: it only validates and feeds the fast-path
		// refusals. What actually changes is decided against the locked re-read.
		const current = new Set(visit.visit_techs.map((vt) => vt.tech_id));
		const addIds = [...new Set(add)];
		const removeIds = [...new Set(remove)];
		const toAdd = addIds.filter((id) => !current.has(id));
		const toRemove = removeIds.filter((id) => current.has(id));

		const { missing } = await loadAssignableTechs(sdb, addIds, current);
		if (missing.length > 0) {
			return {
				err: `Technicians not found or deactivated: ${missing.join(", ")}`,
			};
		}

		// Fast path only; the same checks are repeated under lock below.
		if (current.size - toRemove.length + toAdd.length === 0 && NEEDS_TECH.includes(visit.status)) {
			return { err: needsTechMessage(visit.status) };
		}
		if (toRemove.length > 0) {
			const clockedIn = await sdb.visit_tech_time_entry.findFirst({
				where: { visit_id: visitId, tech_id: { in: toRemove }, clocked_out_at: null },
				select: { tech: { select: { name: true } } },
			});
			if (clockedIn) {
				return { err: clockedInMessage(clockedIn.tech.name), code: "WRONG_STATE" as const };
			}
		}

		const added = await sdb.$transaction(async (tx) => {
			const txc = tx as unknown as Prisma.TransactionClient;
			// Visit first, then its assignment rows: the order clockInVisit and the
			// lifecycle transitions take them, so none of them can deadlock. The
			// visit lock serialises every assignment writer and clock-in on it.
			const [locked] = await txc.$queryRaw<{ status: string }[]>`SELECT status FROM job_visit WHERE id = ${visitId} FOR NO KEY UPDATE`;
			await txc.$queryRaw`SELECT tech_id FROM job_visit_technician WHERE visit_id = ${visitId} ORDER BY tech_id FOR UPDATE`;

			const before = await tx.job_visit_technician.findMany({
				where: { visit_id: visitId },
				select: { tech_id: true, tech: { select: { name: true } } },
			});
			const now = new Set(before.map((r) => r.tech_id));
			const adding = addIds.filter((id) => !now.has(id));
			const removing = removeIds.filter((id) => now.has(id));
			if (adding.length === 0 && removing.length === 0) return null;

			const status = locked?.status ?? visit.status;
			if (now.size - removing.length + adding.length === 0 && NEEDS_TECH.includes(status as visit_status)) {
				throw new AssignmentRefusal(needsTechMessage(status));
			}
			if (removing.length > 0) {
				const clockedIn = await tx.visit_tech_time_entry.findFirst({
					where: { visit_id: visitId, tech_id: { in: removing }, clocked_out_at: null },
					select: { tech: { select: { name: true } } },
				});
				if (clockedIn) {
					throw new AssignmentRefusal(clockedInMessage(clockedIn.tech.name), "WRONG_STATE");
				}
				await tx.job_visit_technician.deleteMany({
					where: { visit_id: visitId, tech_id: { in: removing } },
				});
			}
			if (adding.length > 0) {
				await tx.job_visit_technician.createMany({
					data: adding.map((tech_id) => ({ visit_id: visitId, tech_id })),
					skipDuplicates: true,
				});
			}
			const oldTechNames = before.map((r) => r.tech.name);

			// Read back rather than derive, so a concurrent edit's techs show in "new".
			const after = await tx.job_visit_technician.findMany({
				where: { visit_id: visitId },
				select: { tech: { select: { name: true } } },
			});
			const newTechNames = after.map((r) => r.tech.name);

			await logActivity({
				event_type: "job_visit.technicians_assigned",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visitId,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					technicians: {
						old: oldTechNames,
						new: newTechNames,
					},
					...parentBreadcrumb("job", visit.job_id),
					_job_number: { old: null, new: visit.job.job_number },
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
			return adding;
		});

		const updated = await loadVisitWithTechs(sdb, visitId);

		// Notify newly assigned technicians
		if (updated && added) {
			const clientName = updated.job.client.name;
			const scheduledAt = updated.scheduled_start_at.toLocaleString("en-US", {
				weekday: "short", month: "short", day: "numeric",
				hour: "numeric", minute: "2-digit",
			});
			for (const techId of added) {
				await createNotification({
					technicianId: techId,
					type:         "visit_assigned",
					title:        `New visit assigned: ${clientName}`,
					body:         `You have been assigned to a visit at ${clientName} on ${scheduledAt}.`,
					actionUrl:    `/technician/visits/${visitId}`,
				}, organizationId);
			}
			emitToOrg(organizationId, "job_visit:updated", { visitId: updated.id, organizationId });
		}

		return { err: "", item: updated };
	} catch (e) {
		if (e instanceof AssignmentRefusal) {
			return e.code ? { err: e.message, code: e.code } : { err: e.message };
		}
		log.error({ err: e }, "Failed to assign technicians");
		return { err: "Failed to assign technicians" };
	}
};

// Full-list callers (legacy PUT, assistant tool): turned into a diff so they
// keep existing rows' tech_status too.
export const assignTechniciansToVisit = async (
	visitId: string,
	techIds: string[],
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const currentRows = await sdb.job_visit_technician.findMany({
			where: { visit_id: visitId },
			select: { tech_id: true },
		});
		const current = new Set(currentRows.map((r) => r.tech_id));
		const wanted = new Set(techIds);
		return patchVisitTechnicians(
			visitId,
			{
				add: [...wanted].filter((id) => !current.has(id)),
				remove: [...current].filter((id) => !wanted.has(id)),
			},
			organizationId,
			context,
		);
	} catch (e) {
		log.error({ err: e }, "Failed to assign technicians");
		return { err: "Failed to assign technicians" };
	}
};

export const acceptJobVisit = async (
	visitId: string,
	techId: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const visit = await sdb.job_visit.findFirst({
			where: { id: visitId, job: { organization_id: organizationId } },
		});

		if (!visit) {
			return { err: "Job visit not found" };
		}
		if (visit.status === "Completed" || visit.status === "Cancelled") {
			return {
				err: `A ${visit.status.toLowerCase()} visit can't be accepted.`,
				code: "WRONG_STATE" as const,
			};
		}

		const tech = await sdb.technician.findFirst({
			where: { id: techId },
			select: { id: true },
		});

		if (!tech) {
			return { err: "Technician not found" };
		}

		const alreadyAssigned = await sdb.job_visit_technician.findFirst({
			where: { visit_id: visitId, tech_id: techId },
		});
		if (alreadyAssigned) {
			const visit = await sdb.job_visit.findFirst({
				where: { id: visitId },
				include: {
					job: { include: { client: true } },
					visit_techs: { include: { tech: true } },
					notes: true,
				},
			});
			return { err: "", item: visit ?? undefined };
		}

		const claimed = await sdb.$transaction(async (tx) => {
			// Technicians may only claim unassigned visits; the row lock stops two claiming at once.
			if (context?.techId) {
				await tx.$queryRaw`SELECT id FROM job_visit WHERE id = ${visitId} FOR UPDATE`;
				if ((await tx.job_visit_technician.count({ where: { visit_id: visitId } })) > 0) return false;
			}

			await tx.job_visit_technician.create({
				data: { visit_id: visitId, tech_id: techId },
			});

			await logActivity({
				event_type: "job_visit.technicians_assigned",
				action: "updated",
				entity_type: "job_visit",
				entity_id: visitId,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					technicians: {
						old: [],
						new: [techId],
					},
					...parentBreadcrumb("job", visit.job_id),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
			return true;
		});
		if (!claimed) {
			return { err: "This visit already has a technician. Ask a dispatcher to add you to it." };
		}

		const updated = await sdb.job_visit.findFirst({
			where: { id: visitId },
			include: {
				job: {
					include: {
						client: true,
					},
				},
				visit_techs: {
					include: { tech: true },
				},
				notes: true,
			},
		});

		return { err: "", item: updated };
	} catch (e) {
		log.error({ err: e }, "Failed to accept job visit");
		throw e;
	}
};

// ── Visit lifecycle ───────────────────────────────────────────────

export const LIFECYCLE_TRANSITIONS = Object.fromEntries(
	HTTP_TRANSITION_ACTIONS.map((action) => [action, VISIT_TRANSITIONS[action]]),
) as Partial<typeof VISIT_TRANSITIONS>;

const LIFECYCLE_ORDER: Record<string, number> = {
	Scheduled: 0,
	Delayed: 0,
	Driving: 1,
	OnSite: 2,
	InProgress: 3,
	Paused: 4,
	Completed: 5,
};

export type LifecycleAction = VisitAction;

const VISIT_DETAIL_INCLUDE = {
	job: { include: { client: true, quote: true } },
	visit_techs: { include: { tech: true } },
	line_items: { orderBy: { sort_order: "asc" } },
	notes: true,
} satisfies Prisma.job_visitInclude;

export const applyVisitTransition = async (
	id: string,
	action: VisitAction,
	organizationId: string,
	context?: UserContext,
	pauseReason?: string,
	techCoords?: { lat: number; lon: number } | null,
) => {
	try {
		const edge = VISIT_TRANSITIONS[action];
		const sdb = getScopedDb(organizationId);
		const existingVisit = await sdb.job_visit.findFirst({
			where: { id, job: { organization_id: organizationId } },
			include: { job: true, visit_techs: true },
		});

		if (!existingVisit) return { err: "Job visit not found", code: "NOT_FOUND" as const };
		// Before the already-past shortcut below, so an outside tech learns nothing.
		if (context?.techId && !existingVisit.visit_techs.some((v) => v.tech_id === context.techId)) {
			return { err: "You aren't assigned to this visit.", code: "FORBIDDEN" as const };
		}

		// Guard: drive and arrive require the technician to not be clocked in
		if ((action === "drive" || action === "arrive") && context?.techId) {
			const openEntry = await sdb.visit_tech_time_entry.findFirst({
				where: { tech_id: context.techId, clocked_out_at: null },
			});
			if (openEntry) {
				return { err: "CLOCKED_IN" };
			}
		}

		if (!edge.from.includes(existingVisit.status)) {
			const currentOrder = LIFECYCLE_ORDER[existingVisit.status] ?? -1;
			const targetOrder = LIFECYCLE_ORDER[edge.to] ?? -1;
			// `restore` targets Scheduled (order 0) but must refuse, not no-op; an
			// actor the edge doesn't allow (a tech delaying) must get FORBIDDEN.
			const mayNoOp = action !== "restore" && edge.actors.includes(actorOf(context));
			if (mayNoOp && targetOrder >= 0 && currentOrder >= targetOrder) {
				// Secondary transition: drive or arrive for a tech whose visit is already past that state
				if ((action === "drive" || action === "arrive") && context?.techId) {
					const techVisitStatus: tech_visit_status = action === "drive" ? "EnRoute" : "OnSite";
					const techGlobalStatus: technician_status = action === "drive" ? "EnRoute" : "OnSite";
					const assignment = await sdb.job_visit_technician.findUnique({
						where: { visit_id_tech_id: { visit_id: id, tech_id: context.techId } },
					});
					if (assignment && (assignment.tech_status === "Assigned" || (action === "arrive" && assignment.tech_status === "EnRoute"))) {
						const currentVisit = await sdb.job_visit.findFirst({
							where: { id },
							include: VISIT_DETAIL_INCLUDE,
						});
						if (currentVisit) {
							await sdb.$transaction([
								sdb.job_visit_technician.update({
									where: { visit_id_tech_id: { visit_id: id, tech_id: context.techId } },
									data: { tech_status: techVisitStatus },
								}),
								sdb.technician.update({
									where: { id: context.techId },
									data: { status: techGlobalStatus },
								}),
							]);
							emitToOrg(organizationId,
								"job_visit:status_changed",
								buildSecondaryEventPayload(currentVisit, techVisitStatus, context),
							);
							await recordDrive(sdb, context.techId, new Date(), action === "drive" ? id : undefined);
						}
						return { err: "", item: currentVisit ?? undefined };
					}
				}
				const currentVisit = await sdb.job_visit.findUnique({
					where: { id },
					include: VISIT_DETAIL_INCLUDE,
				});
				if (action === "drive" && existingVisit.status === "Driving" && currentVisit) {
					emitToOrg(organizationId,
						"job_visit:status_changed",
						buildVisitStatusPayload(currentVisit as any, existingVisit.status, false, context),
					);
				}
				return { err: "", item: currentVisit ?? undefined };
			}
		}

		const now = new Date();
		const actingTechIds = context?.techId
			? [context.techId]
			: (
				await sdb.technician.findMany({
					where: {
						id: { in: existingVisit.visit_techs.map((vt) => vt.tech_id) },
						status: { not: "Break" },
						time_entries: { none: { clocked_out_at: null } },
					},
					select: { id: true },
				})
			).map((t) => t.id);

		const effects = await db.$transaction(async (tx) => {
			const driveTx = tx as unknown as Parameters<typeof recordDrive>[0];
			const isDrive = action === "drive";
			const main = await applyStatusChange(tx, {
				orgId: organizationId,
				visitId: id,
				action,
				context,
				now,
				actingTechIds,
				pauseReason,
				deferJobSync: isDrive,
			});
			const all = [main];
			if (isDrive) {
				// Destination switch. Every visit lock (this one, then the others
				// in id order) is taken before any job lock, and jobs go in id
				// order: two visits of one job never get locked job-first.
				const others = await tx.job_visit.findMany({
					where: {
						status: "Driving",
						id: { not: id },
						job: { organization_id: organizationId },
						visit_techs: { some: { tech_id: { in: actingTechIds } } },
					},
					select: { id: true },
					orderBy: { id: "asc" },
				});
				for (const other of others) {
					try {
						all.push(
							await applyStatusChange(tx, {
								orgId: organizationId,
								visitId: other.id,
								action: "recall",
								now,
								actingTechIds,
								deferJobSync: true,
							}),
						);
					} catch (e) {
						// It moved before we got its lock; it's no longer ours to recall.
						if (!(e instanceof LifecycleRefusal)) throw e;
					}
				}
				for (const techId of actingTechIds) await recordDrive(driveTx, techId, now, id);
				const jobIds = [...new Set(all.map((e) => e.jobId))].sort();
				for (const jobId of jobIds) {
					const change = await syncJobFromVisits(tx, organizationId, jobId, { now, context });
					const owner = all.find((e) => e.jobId === jobId);
					if (owner) owner.jobChange = change;
				}
			}
			if (action === "arrive") {
				for (const techId of actingTechIds) await recordDrive(driveTx, techId, now);
			}
			if (action === "delay") {
				await tx.visit_tech_drive.updateMany({ where: { visit_id: id, ended_at: null }, data: { ended_at: now } });
			}
			return all;
		});

		for (const e of effects) await runPostCommit(e, context);

		const updated = await sdb.job_visit.findFirst({
			where: { id },
			include: VISIT_DETAIL_INCLUDE,
		});

		if (action === "drive" && updated) {
			const jobCoords = existingVisit.job.coords as { lat?: number; lon?: number; lng?: number } | null;
			const jobLon = jobCoords?.lon ?? jobCoords?.lng;
			const miles = await fetchRouteDistanceMiles(
				techCoords ?? null,
				jobCoords?.lat && jobLon ? { lat: jobCoords.lat, lon: jobLon } : null,
			);
			if (miles !== null) {
				await sdb.job_visit.update({ where: { id }, data: { estimated_drive_miles: miles } });
				updated.estimated_drive_miles = miles;

				if (context?.techId !== undefined)
					await applyOdometerIncrement(sdb, context.techId, miles);
			}
		}
		return { err: "", item: updated ?? undefined };
	} catch (e) {
		if (e instanceof LifecycleRefusal) return { err: e.message, code: e.code };
		log.error({ err: e }, `Failed to apply visit transition: ${action}`);
		return { err: "Failed to update visit status" };
	}
};


// ─────────────────────────────────────────────────────────────────────────────
export const cancelJobVisit = async (
	id: string,
	cancellationReason: string,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const sdb = getScopedDb(organizationId);
		const effects = await sdb.$transaction((tx) =>
			applyStatusChange(tx as unknown as Prisma.TransactionClient, {
				orgId: organizationId,
				visitId: id,
				action: "cancel",
				context,
				cancellationReason,
			}),
		);
		await runPostCommit(effects, context);

		const updated = await sdb.job_visit.findFirst({
			where: { id },
			include: VISIT_DETAIL_INCLUDE,
		});
		return { err: "", item: updated ?? undefined };
	} catch (e) {
		if (e instanceof LifecycleRefusal) return { err: e.message, code: e.code };
		log.error({ err: e }, "Failed to cancel job visit");
		return { err: "Failed to cancel visit" };
	}
};

export const deleteJobVisit = async (id: string, organizationId: string, context?: UserContext) => {
	try {
		const sdb = getScopedDb(organizationId);
		const visit = await sdb.job_visit.findFirst({
			where: { id, job: { organization_id: organizationId } },
			include: { job: { select: { status: true } } },
		});

		if (!visit) {
			return { err: "Job visit not found" };
		}

		// The cascade drops these rows; read the files to clean up first.
		const photos = await sdb.job_note_photo.findMany({
			where: { note: { visit_id: id } },
			select: { photo_url: true },
		});

		await sdb.$transaction(async (tx) => {
			await tx.job_visit_technician.deleteMany({
				where: { visit_id: id },
			});

			await logActivity({
				event_type: "job_visit.deleted",
				action: "deleted",
				entity_type: "job_visit",
				entity_id: id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: visit.name, new: null },
					description: { old: visit.description, new: null },
					scheduled_start_at: {
						old: visit.scheduled_start_at,
						new: null,
					},
					scheduled_end_at: {
						old: visit.scheduled_end_at,
						new: null,
					},
					status: { old: visit.status, new: null },
					...parentBreadcrumb("job", visit.job_id),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			await tx.job_visit.delete({
				where: { id },
			});

			// Update job status if no visits remain
			const remainingVisits = await tx.job_visit.findMany({
				where: { job_id: visit.job_id },
			});

			if (remainingVisits.length === 0 && visit.job.status !== "Unscheduled") {
				await tx.job.update({
					where: { id: visit.job_id },
					data: { status: "Unscheduled", status_changed_at: new Date() },
				});
			}
		});

		deleteStoredFiles(photos.map((p) => p.photo_url), { visitId: id });
		emitToOrg(organizationId, "job_visit:deleted", { visitId: id, organizationId });
		return { err: "", message: "Job visit deleted successfully" };
	} catch (e) {
		log.error({ err: e }, "Failed to delete job visit");
		if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003") {
			return { err: "This visit is on an invoice or has stock used against it, so it can't be deleted. Cancel the visit instead." };
		}
		throw e;
	}
};

export const getRecentStatusEvents = async (organizationId: string, techId?: string) => {
	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

	const logs = await db.log.findMany({
		where: {
			event_type: "job_visit.updated",
			organization_id: organizationId,
			timestamp: { gte: cutoff },
		},
		orderBy: { timestamp: "desc" },
		take: 30,
	});

	if (logs.length === 0) return [];

	const visitIds = [...new Set(logs.map((l) => l.entity_id))];
	const visits = await db.job_visit.findMany({
		where: { id: { in: visitIds }, ...assignedTo(techId) },
		include: { job: { include: { client: { select: { name: true } } } } },
	});
	const visitMap = new Map(visits.map((v) => [v.id, v]));

	return logs
		.map((entry) => {
			const changes = entry.changes as Record<string, { old: string; new: string }>;
			const visit = visitMap.get(entry.entity_id);
			if (!visit || !changes.status) return null;
			return {
				visitStatusChanged: true,
				visitStatus: changes.status.new,
				previousVisitStatus: changes.status.old,
				actor:
					entry.actor_id && entry.actor_type !== "system"
						? { type: entry.actor_type as "technician" | "dispatcher", name: entry.actor_name, id: entry.actor_id }
						: null,
				changedAt: entry.timestamp.toISOString(),
				visit: {
					id: visit.id,
					name: visit.name,
					scheduledAt: visit.scheduled_start_at.toISOString(),
					job: { id: visit.job_id, client: { name: visit.job.client.name } },
				},
			};
		})
		.filter((e) => e !== null)
		.slice(0, 9);
};
