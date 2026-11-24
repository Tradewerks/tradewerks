import { ZodError } from "zod";
import {
	Prisma,
	recurring_frequency,
	weekday,
} from "../../generated/prisma/client.js";
import { Request } from "express";
import { logActivity, buildChanges } from "../services/logger.js";
import { parentBreadcrumb } from "./logsController.js";
import { emitActivityHints, logActivityInTx } from "../services/visitLifecycle/activityLog.js";
import { notifyVisitAssigned } from "../services/visitAssignedNotice.js";
import { getScopedDb } from "../lib/context.js";
import {
	applyInventoryTaxable,
	applyInventoryTaxableToNewLines,
	lineTaxFieldsForCreate,
	lineTaxFieldsForUpdate,
} from "../lib/inventoryTaxable.js";
import { getClosedWindows } from "../services/moduleWindowService.js";
import {
	assertInventoryItemsInOrg,
	assertDispositionVehiclesInOrg,
	plannedLineItemFields,
	templateDispositionFields,
} from "../lib/inventory.js";
import {
	createRecurringPlanSchema,
	updateRecurringPlanSchema,
	renewRecurringPlanSchema,
	cancelRecurringPlanSchema,
	updateRecurringPlanLineItemsSchema,
	updateInvoiceScheduleSchema,
	type UpdateRecurringPlanLineItemsInput,
	generateOccurrencesSchema,
	skipOccurrenceSchema,
	rescheduleOccurrenceSchema,
	bulkSkipOccurrencesSchema,
	bulkRescheduleOccurrencesSchema,
} from "../lib/validate/recurringPlans.js";
import {
	LineItemToCreate,
	ChangeSet,
	OccurrenceGenerationResult,
	VisitGenerationResult,
} from "../types/common.js";
import { addDays } from "date-fns";
import {
	computeSlots,
	toSlotRule,
	type Slot,
	type SlotRule,
	visitTimesForRule,
} from "../lib/recurrence/occurrenceSlots.js";
import {
	addLocalDays,
	localWallTime,
	toLocalDate,
	zonedWallTimeToUtc,
	type LocalDate,
} from "../lib/recurrence/zonedTime.js";
import { reconcileLegacySlots } from "../lib/recurrence/reconcileLegacySlots.js";
import { assertTaxGroupsInOrg } from "../lib/taxHelpers.js";
import { holdsKeptRate, recomputeVisitTotals } from "../lib/recomputeDocumentTotals.js";
import {
	billingDateOf,
	calculateNextInvoiceAt,
	generateDaysBeforeForEdit,
	nextInvoiceAtForEdit,
	scheduleAnchor,
} from "../lib/invoiceSchedule.js";
import { log } from "../services/appLogger.js";
import { isClientMessage } from "../types/responses.js";
import { generateJobNumber } from "../db.js";
import {
	PlanTransitionError,
	RECURRING_PLAN_DETAIL_INCLUDE,
	planBills,
	planEffects,
	planInactiveMessage,
	transitionRecurringPlan,
	type PlanStatus,
} from "../lib/recurringPlanState.js";
import { recordChanged } from "../services/recordChanged.js";
import { onVisitScheduled } from "../services/followupTriggers.js";
import { notifyVisitScheduled } from "../services/customerComms/visitEvents.js";

export interface UserContext {
	techId?: string;
	dispatcherId?: string;
	ipAddress?: string;
	userAgent?: string;
}

type RecurringRuleWithWeekdays = Prisma.recurring_ruleGetPayload<{
	include: { by_weekday: true };
}>;

// ============================================================================
// OCCURRENCE GENERATION LOGIC
// ============================================================================

/** A plan whose stored schedule can't be placed on the calendar (bad wall time or zone). */
export class InvalidPlanScheduleError extends Error {
	constructor(planId: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			`Recurring plan ${planId} can't be scheduled (${reason}). Fix the plan's schedule to resume generation.`,
		);
		this.name = "InvalidPlanScheduleError";
	}
}

const RULE_TIME_FIELDS = [
	"arrival_time",
	"arrival_window_start",
	"arrival_window_end",
	"finish_time",
] as const;
const HHMM_PARTS = /^(\d{2}):(\d{2})$/;

function wallMinutes(hhmm: string): number {
	const m = HHMM_PARTS.exec(hhmm)!;
	return Number(m[1]) * 60 + Number(m[2]);
}

function planLocalDate(plan: { id: string; timezone: string }, at: Date): LocalDate {
	try {
		return toLocalDate(at, plan.timezone);
	} catch (e) {
		if (e instanceof RangeError) throw new InvalidPlanScheduleError(plan.id, e);
		throw e;
	}
}

function planSlots(
	plan: {
		id: string;
		starts_at: Date;
		ends_at: Date | null;
		timezone: string;
		rules: RecurringRuleWithWeekdays[];
	},
	window: { from: LocalDate; to: LocalDate },
): Slot[] {
	try {
		return computeSlots(
			toSlotRule(plan.rules[0]),
			{
				startsAt: plan.starts_at,
				endsAt: plan.ends_at,
				timezone: plan.timezone,
			},
			window,
		);
	} catch (e) {
		// Rules saved before HH:MM validation was tightened can hold "25:00";
		// surface that per plan instead of failing whatever batch called us.
		if (e instanceof RangeError) throw new InvalidPlanScheduleError(plan.id, e);
		throw e;
	}
}

export async function generateOccurrencesForPlan(
	planId: string,
	tx: Prisma.TransactionClient,
	opts: { now?: Date; daysAhead?: number } = {},
): Promise<OccurrenceGenerationResult> {
	const plan = await tx.recurring_plan.findUnique({
		where: { id: planId },
		include: { rules: { include: { by_weekday: true } } },
	});

	if (!plan) {
		throw new Error("Plan not found");
	}

	const now = opts.now ?? new Date();
	const daysAhead = opts.daysAhead ?? plan.generation_window_days;
	const windowEnd = addDays(now, daysAhead);
	const result: OccurrenceGenerationResult = {
		generated: 0,
		skipped: 0,
		start_date: now,
		end_date: plan.ends_at && plan.ends_at < windowEnd ? plan.ends_at : windowEnd,
	};

	if (!planEffects(plan.status).generates) return result;

	if (plan.rules.length === 0) {
		throw new Error("Plan has no rules defined");
	}

	const from = planLocalDate(plan, now);
	// A slot whose window has closed would be born already missed.
	const slots = planSlots(plan, { from, to: addLocalDays(from, daysAhead) }).filter(
		(slot) => slot.end > now,
	);
	if (slots.length === 0) return result;

	// A re-timed rule moves every slot off the original_start_at its rows were
	// born with, so the unique key alone would re-create each day. Every rule
	// yields at most one slot per local date, and a re-time never changes a
	// row's slot date: the date of its original_start_at is taken, in any
	// status. Where a row was moved to doesn't count, so a visit moved onto
	// another slot's day leaves that slot to be generated.
	const margin = 86_400_000;
	const existing = await tx.recurring_occurrence.findMany({
		where: {
			recurring_plan_id: planId,
			original_start_at: {
				gte: new Date(slots[0].start.getTime() - margin),
				lte: new Date(slots[slots.length - 1].start.getTime() + margin),
			},
		},
		select: { original_start_at: true },
	});
	const taken = new Set<LocalDate>(
		existing.map((o) => planLocalDate(plan, o.original_start_at)),
	);
	const open = slots.filter((slot) => !taken.has(slot.date));
	if (open.length === 0) return { ...result, skipped: slots.length };

	const rule = plan.rules[0];
	// skipDuplicates still covers a concurrent writer inserting the same slot.
	const { count } = await tx.recurring_occurrence.createMany({
		data: open.map((slot) => ({
			recurring_plan_id: planId,
			original_start_at: slot.start,
			occurrence_start_at: slot.start,
			occurrence_end_at: slot.end,
			slot_verified: true,
			status: "planned" as const,
			template_version: 1,
			arrival_constraint: rule.arrival_constraint,
			finish_constraint: rule.finish_constraint,
			arrival_time: rule.arrival_time,
			arrival_window_start: rule.arrival_window_start,
			arrival_window_end: rule.arrival_window_end,
			finish_time: rule.finish_time,
		})),
		skipDuplicates: true,
	});

	return { ...result, generated: count, skipped: slots.length - count };
}

// Dates the rule would have produced while the org had Recurring Plans switched
// off and that were never generated. Generation never looks backwards, so these
// are gone for good; the plan page lists them so the gap is visible.
export async function getSkippedDatesForJob(jobId: string, orgId: string): Promise<Date[]> {
	const sdb = getScopedDb(orgId);
	const job = await sdb.job.findFirst({
		where: { id: jobId },
		select: { recurring_plan_id: true },
	});
	if (!job?.recurring_plan_id) return [];
	const plan = await sdb.recurring_plan.findFirst({
		where: { id: job.recurring_plan_id },
		include: { rules: { include: { by_weekday: true } } },
	});
	if (!plan || plan.rules.length === 0) return [];

	const windows = await getClosedWindows(orgId, "recurring_plans");
	const planEnd = plan.ends_at ? new Date(plan.ends_at) : null;
	const candidates: Date[] = [];
	try {
		for (const w of windows) {
			const end = planEnd && planEnd < w.on ? planEnd : w.on;
			if (end <= w.off) continue;
			const window = {
				from: planLocalDate(plan, w.off),
				to: planLocalDate(plan, end),
			};
			for (const slot of planSlots(plan, window)) {
				// Slots are whole local days; keep only starts inside the window itself.
				if (slot.start >= w.off && slot.start <= end) candidates.push(slot.start);
			}
		}
	} catch (e) {
		if (!(e instanceof InvalidPlanScheduleError)) throw e;
		log.warn({ err: e, planId: plan.id }, "Skipped-dates lookup on an unschedulable plan");
		return [];
	}
	if (candidates.length === 0) return [];
	const existing = await sdb.recurring_occurrence.findMany({
		where: { recurring_plan_id: plan.id, original_start_at: { in: candidates } },
		select: { original_start_at: true },
	});
	const have = new Set(existing.map((o) => o.original_start_at.getTime()));
	return candidates
		.filter((d) => !have.has(d.getTime()))
		.sort((a, b) => a.getTime() - b.getTime());
}

// ============================================================================
// RECURRING PLAN CRUD
// ============================================================================

export const getAllRecurringPlans = async (organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
	return await sdb.recurring_plan.findMany({
		include: {
			client: {
				select: {
					id: true,
					name: true,
					address: true,
				},
			},
			job_container: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
				},
			},
			rules: {
				include: {
					by_weekday: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			occurrences: {
				where: {
					occurrence_start_at: {
						gte: startOfToday,
					},
				},
				orderBy: { occurrence_start_at: "asc" },
				take: 5,
			},
		},
		orderBy: { created_at: "desc" },
	});
};

export const getRecurringPlanByJobId = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.recurring_plan.findFirst({
		where: {
			job_container: {
				id: jobId,
			},
		},
		include: {
			client: true,
			job_container: true,
			rules: {
				include: {
					by_weekday: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			occurrences: {
				orderBy: { occurrence_start_at: "asc" },
			},
			invoice_schedule: true,
			created_by_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
	});
};

export const getRecurringPlanById = async (planId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	return await sdb.recurring_plan.findUnique({
		where: { id: planId },
		include: {
			client: {
				include: {
					contacts: {
						include: {
							contact: true,
						},
					},
				},
			},
			job_container: {
				select: {
					id: true,
					job_number: true,
					name: true,
					status: true,
					address: true,
					description: true,
					tax_rate: true,
				},
			},
			rules: {
				include: {
					by_weekday: true,
				},
			},
			line_items: {
				orderBy: { sort_order: "asc" },
			},
			occurrences: {
				orderBy: { occurrence_start_at: "asc" },
			},
			invoice_schedule: true,
			created_by_dispatcher: {
				select: {
					id: true,
					name: true,
					email: true,
				},
			},
		},
	});
};

/** null/undefined clears or leaves the default; anything else must be an active tech of this org. */
async function assertDefaultTechInOrg(
	tx: { technician: { findFirst: (args: never) => Promise<unknown> } },
	organizationId: string,
	techId: string | null | undefined,
): Promise<void> {
	if (!techId) return;
	const tech = await tx.technician.findFirst({
		where: {
			id: techId,
			organization_id: organizationId,
			deactivated_at: null,
			deleted_at: null,
		},
		select: { id: true },
	} as never);
	if (!tech) {
		throw new Error("Validation failed: Default technician not found or deactivated");
	}
}

/**
 * Creates the visits now due instead of waiting for the daily sweep, which
 * only reaches occurrences whose window is still open when it runs.
 */
function topUpAfterCommit(planId: string, organizationId: string): void {
	// Lazy: the scheduler imports this module.
	void import("../services/recurringPlanScheduler.js")
		.then(({ topUpPlan }) => topUpPlan(planId, organizationId))
		.catch((err: unknown) =>
			log.warn({ err, planId }, "Post-save recurring plan top-up failed"),
		);
}

export const insertRecurringPlan = async (
	req: Request,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = createRecurringPlanSchema.parse(req.body);
		const sdb = getScopedDb(organizationId);
		const created = await sdb.$transaction(async (tx) => {
			const client = await tx.client.findUnique({
				where: { id: parsed.client_id },
			});

			if (!client) {
				throw new Error("Client not found");
			}

			const org = await tx.organization.findFirst({
				where: { id: organizationId },
				select: { timezone: true },
			});
			if (!org) {
				throw new Error("Organization not found");
			}

			await assertDefaultTechInOrg(tx, organizationId, parsed.default_technician_id);

			const jobNumber = await generateJobNumber(tx, organizationId);

			// Create job container first (without recurring_plan_id)
			const job = await tx.job.create({
				data: {
					job_number: jobNumber,
					name: parsed.name,
					description: parsed.description,
					priority: parsed.priority,
					address: parsed.address,
					coords: parsed.coords,
					status: "InProgress", // Recurring job container is always in progress
					client_id: parsed.client_id,
					organization_id: client.organization_id,
				},
			});

			// Create recurring plan (without job_container reference yet)
			const plan = await tx.recurring_plan.create({
				data: {
					organization_id: client.organization_id,
					client_id: parsed.client_id,
					name: parsed.name,
					description: parsed.description,
					address: parsed.address,
					coords: parsed.coords,
					priority: parsed.priority,
					status: "Active",
					starts_at: new Date(parsed.starts_at),
					ends_at: parsed.ends_at ? new Date(parsed.ends_at) : null,
					timezone: org.timezone,
					generation_window_days: parsed.generation_window_days,
					min_advance_days: parsed.min_advance_days,
					billing_mode: parsed.billing_mode,
					invoice_timing: parsed.invoice_timing,
					auto_invoice: parsed.auto_invoice,
					default_technician_id: parsed.default_technician_id ?? null,
					created_by_dispatcher_id: context?.dispatcherId || null,
				},
			});

			// Link job to plan (bidirectional 1:1)
			await tx.job.update({
				where: { id: job.id },
				data: { recurring_plan_id: plan.id },
			});

			// Create recurring rule
			const rule = await tx.recurring_rule.create({
				data: {
					recurring_plan_id: plan.id,
					frequency: parsed.rule.frequency,
					interval: parsed.rule.interval,
					by_month_day: parsed.rule.by_month_day,
					by_month: parsed.rule.by_month,

					// Constraint-based scheduling
					arrival_constraint: parsed.rule.arrival_constraint,
					finish_constraint: parsed.rule.finish_constraint,
					arrival_time: parsed.rule.arrival_time,
					arrival_window_start: parsed.rule.arrival_window_start,
					arrival_window_end: parsed.rule.arrival_window_end,
					finish_time: parsed.rule.finish_time,
				},
			});

			// Create weekday relations if provided
			if (parsed.rule.by_weekday && parsed.rule.by_weekday.length > 0) {
				await tx.recurring_rule_weekday.createMany({
					data: parsed.rule.by_weekday.map((weekday) => ({
						recurring_rule_id: rule.id,
						weekday: weekday,
					})),
				});
			}

			// Create template line items
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
				await assertDispositionVehiclesInOrg(
					tx,
					organizationId,
					parsed.line_items.map((i) => i.disposition_vehicle_id),
				);
				const lineItems = await applyInventoryTaxable(
					tx,
					organizationId,
					parsed.line_items,
				);
				await tx.recurring_plan_line_item.createMany({
					data: lineItems.map((item, idx) => ({
						recurring_plan_id: plan.id,
						name: item.name,
						description: item.description ?? null,
						quantity: item.quantity,
						unit_price: item.unit_price,
						item_type: item.item_type ?? null,
						sort_order: item.sort_order ?? idx,
						...lineTaxFieldsForCreate(item),
						inventory_item_id: item.inventory_item_id ?? null,
						...templateDispositionFields(item.inventory_item_id, item),
					})),
				});
			}

			// Create invoice schedule if billing is configured
			if (parsed.invoice_schedule && parsed.billing_mode !== "none") {
				const sched = parsed.invoice_schedule;
				const nextInvoiceAt =
					sched.frequency !== "on_visit_completion"
						? calculateNextInvoiceAt(
								scheduleAnchor(sched, plan.timezone),
								{ from: new Date(), notBefore: plan.starts_at },
							)
						: null;
				await tx.invoice_schedule.create({
					data: {
						recurring_plan_id: plan.id,
						billing_basis: sched.billing_basis,
						fixed_amount: sched.fixed_amount ?? null,
						frequency: sched.frequency,
						day_of_month: sched.day_of_month ?? null,
						day_of_week: sched.day_of_week as weekday | null ?? null,
						generate_days_before: sched.generate_days_before ?? 0,
						payment_terms_days: sched.payment_terms_days ?? 30,
						auto_send: sched.auto_send ?? false,
						memo_template: sched.memo_template ?? null,
						next_invoice_at: nextInvoiceAt,
						is_active: true,
					},
				});
			}

			// Generate initial occurrences
			await generateOccurrencesForPlan(
				plan.id,
				tx as unknown as Prisma.TransactionClient,
			);

			// Update client activity
			await tx.client.update({
				where: { id: parsed.client_id },
				data: { last_activity: new Date() },
			});

			const logRow = await logActivityInTx(tx as unknown as Prisma.TransactionClient, {
				event_type: "recurring_plan.created",
				action: "created",
				entity_type: "recurring_plan",
				entity_id: plan.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					name: { old: null, new: plan.name },
					client_id: { old: null, new: plan.client_id },
					status: { old: null, new: plan.status },
					job_id: { old: null, new: job.id },
					line_items_count: {
						old: null,
						new: parsed.line_items?.length ?? 0,
					},
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			// Return full plan with all relations
			const item = await tx.recurring_plan.findUnique({
				where: { id: plan.id },
				include: {
					client: true,
					job_container: true,
					rules: {
						include: {
							by_weekday: true,
						},
					},
					line_items: {
						orderBy: { sort_order: "asc" },
					},
					occurrences: {
						orderBy: { occurrence_start_at: "asc" },
						take: 10,
					},
					invoice_schedule: true,
				},
			});
			return { item, logRow };
		});

		emitActivityHints(created.logRow);
		if (created.item && planEffects(created.item.status).createsVisits) {
			topUpAfterCommit(created.item.id, organizationId);
		}
		return { err: "", item: created.item ?? undefined };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		if (isClientMessage(e)) {
			return { err: e.message };
		}
		log.error({ err: e }, "Insert recurring plan error");
		throw e;
	}
};

/**
 * Rewrites the plan-sourced lines of generated visits that are still
 * Scheduled in the future and on no live invoice. Eligibility is decided
 * under the visit lock because a start or an invoice may have committed
 * since the plan was read; hand-added lines are never touched.
 */
async function propagateTemplateToScheduledVisits(
	tx: Prisma.TransactionClient,
	organizationId: string,
	planId: string,
): Promise<{ count: number; skipped: number; visits: { id: string; jobId: string }[] }> {
	const occurrences = await tx.recurring_occurrence.findMany({
		where: { recurring_plan_id: planId, job_visit_id: { not: null } },
		select: { job_visit_id: true },
	});
	const candidateIds = occurrences.map((o) => o.job_visit_id as string);
	if (candidateIds.length === 0) return { count: 0, skipped: 0, visits: [] };

	const locked = await tx.$queryRaw<{ id: string; job_id: string; blocked: boolean }[]>`
		SELECT v.id, v.job_id,
			-- Consumed, voided or purchase-linked plan lines: the visit keeps its price.
			EXISTS (
				SELECT 1 FROM job_visit_line_item li
				WHERE li.visit_id = v.id AND li.source = 'recurring_plan'
					AND (li.fulfillment_status::text IN ('used', 'voided')
						OR EXISTS (SELECT 1 FROM purchase_line pl WHERE pl.visit_line_item_id = li.id)
						OR EXISTS (SELECT 1 FROM field_purchase_line fl WHERE fl.visit_line_item_id = li.id)
						OR EXISTS (SELECT 1 FROM stock_movement sm WHERE sm.visit_line_item_id = li.id))
			) AS blocked
		FROM job_visit v JOIN job j ON j.id = v.job_id
		WHERE v.id = ANY(${candidateIds}::text[])
			AND j.organization_id = ${organizationId}
			AND v.status = 'Scheduled'
			AND v.scheduled_start_at > now()
			AND NOT EXISTS (
				SELECT 1 FROM invoice_visit iv JOIN invoice i ON i.id = iv.invoice_id
				WHERE iv.visit_id = v.id AND i.status::text <> 'Void')
		ORDER BY v.id
		FOR NO KEY UPDATE OF v`;
	const open = locked.filter((r) => !r.blocked);
	const skipped = locked.length - open.length;
	const visitIds = open.map((r) => r.id);
	if (visitIds.length === 0) return { count: 0, skipped, visits: [] };

	const template = await tx.recurring_plan_line_item.findMany({
		where: { recurring_plan_id: planId },
		orderBy: { sort_order: "asc" },
	});
	const planLines = await tx.job_visit_line_item.findMany({
		where: { visit_id: { in: visitIds }, source: "recurring_plan" },
		select: { id: true, visit_id: true },
	});

	for (const visitId of visitIds) {
		// Visits holding a consumed, voided or purchase-linked plan line were skipped by the lock query.
		const stale = planLines.filter((l) => l.visit_id === visitId).map((l) => l.id);
		if (stale.length > 0) {
			await tx.job_visit_line_item.deleteMany({ where: { id: { in: stale } } });
		}
		await tx.job_visit_line_item.createMany({
			data: template.map((item, idx) => ({
				visit_id: visitId,
				name: item.name,
				description: item.description,
				quantity: Number(item.quantity),
				unit_price: Number(item.unit_price),
				total: Number(item.quantity) * Number(item.unit_price),
				source: "recurring_plan",
				item_type: item.item_type,
				taxable: item.taxable,
				tax_group_id: item.tax_group_id,
				sort_order: idx,
				...plannedLineItemFields(item.inventory_item_id, Number(item.quantity), item),
			})),
		});
		await recomputeVisitTotals(visitId, organizationId, tx);
	}
	return {
		count: visitIds.length,
		skipped,
		visits: open.map((r) => ({ id: r.id, jobId: r.job_id })),
	};
}

/** Replaces a plan's template lines: missing ids deleted, known ids updated, the rest created. */
async function syncPlanLineItems(
	tx: Prisma.TransactionClient,
	organizationId: string,
	planId: string,
	existingLines: { id: string }[],
	incoming: UpdateRecurringPlanLineItemsInput["line_items"],
): Promise<void> {
	await assertInventoryItemsInOrg(
		tx,
		organizationId,
		incoming.map((i) => i.inventory_item_id),
	);
	await assertTaxGroupsInOrg(
		tx,
		organizationId,
		incoming.map((i) => i.tax_group_id),
	);
	await assertDispositionVehiclesInOrg(
		tx,
		organizationId,
		incoming.map((i) => i.disposition_vehicle_id),
	);
	const existingItemIds = new Set(
		existingLines.map((item) => item.id),
	);
	const incomingItemIds = new Set(
		incoming
			.filter((item) => item.id)
			.map((item) => item.id!),
	);
	// New lines take the inventory default; existing lines keep theirs.
	const withInventoryTaxable = await applyInventoryTaxableToNewLines(
		tx,
		organizationId,
		incoming,
		existingItemIds,
	);

	// DELETE: Items not in incoming list
	const itemsToDelete = existingLines.filter(
		(item) => !incomingItemIds.has(item.id),
	);

	for (const item of itemsToDelete) {
		await tx.recurring_plan_line_item.delete({
			where: { id: item.id },
		});
	}

	// CREATE OR UPDATE
	for (const item of incoming) {
		if (item.id && existingItemIds.has(item.id)) {
			await tx.recurring_plan_line_item.update({
				where: { id: item.id },
				data: {
					name: item.name,
					description: item.description || null,
					quantity: item.quantity,
					unit_price: item.unit_price,
					item_type: item.item_type ?? null,
					sort_order: item.sort_order ?? 0,
					...lineTaxFieldsForUpdate(item),
					...(item.inventory_item_id !== undefined && {
						inventory_item_id: item.inventory_item_id,
						...templateDispositionFields(item.inventory_item_id, item),
					}),
				},
			});
		} else {
			await tx.recurring_plan_line_item.create({
				data: {
					recurring_plan_id: planId,
					name: item.name,
					description: item.description || null,
					quantity: item.quantity,
					unit_price: item.unit_price,
					item_type: item.item_type ?? null,
					sort_order: item.sort_order ?? 0,
					...lineTaxFieldsForCreate(withInventoryTaxable(item)),
					inventory_item_id: item.inventory_item_id ?? null,
					...templateDispositionFields(item.inventory_item_id, item),
				},
			});
		}
	}
}

export const updateRecurringPlan = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateRecurringPlanSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const existing = await sdb.recurring_plan.findFirst({
			where: {
				job_container: {
					id: jobId,
				},
			},
			include: {
				rules: {
					include: {
						by_weekday: true,
					},
				},
				line_items: true,
			},
		});

		if (!existing) {
			return { err: "Recurring plan not found" };
		}

		const changes = buildChanges(existing, parsed, [
			"name",
			"description",
			"address",
			"priority",
			"starts_at",
			"ends_at",
			"generation_window_days",
			"min_advance_days",
			"billing_mode",
			"invoice_timing",
			"auto_invoice",
			"coords",
			"default_technician_id",
		] as const);

		const newEndsAt =
			parsed.ends_at === undefined
				? undefined
				: parsed.ends_at
					? new Date(parsed.ends_at)
					: null;
		const endsMoved =
			newEndsAt !== undefined &&
			(newEndsAt?.getTime() ?? null) !== (existing.ends_at?.getTime() ?? null);
		const scheduleMoved =
			!!(parsed.rule && existing.rules.length > 0) ||
			endsMoved ||
			(parsed.generation_window_days !== undefined &&
				parsed.generation_window_days !== existing.generation_window_days) ||
			(parsed.min_advance_days !== undefined &&
				parsed.min_advance_days !== existing.min_advance_days);

		let logRow: Awaited<ReturnType<typeof logActivityInTx>> | null = null;
		let updatedVisits = 0;
		let skippedVisits = 0;
		let repricedVisits: { id: string; jobId: string }[] = [];
		const updated = await sdb.$transaction(async (tx) => {
			if (parsed.rule && existing.rules.length > 0) {
				// Plan row first, as every plan writer takes it. Legacy rows are
				// matched to the slots of the rule that made them, so before it
				// is rewritten.
				await tx.$queryRaw`
					SELECT id FROM recurring_plan WHERE id = ${existing.id} FOR NO KEY UPDATE`;
				await reconcileLegacySlots(
					existing.id,
					tx as unknown as Prisma.TransactionClient,
				);
			}
			// A tech deactivated since being set stays; only a change is checked.
			if (
				parsed.default_technician_id !== undefined &&
				parsed.default_technician_id !== existing.default_technician_id
			) {
				await assertDefaultTechInOrg(tx, organizationId, parsed.default_technician_id);
			}
			const plan = await tx.recurring_plan.update({
				where: { id: existing.id },
				data: {
					...(parsed.default_technician_id !== undefined && {
						default_technician_id: parsed.default_technician_id,
					}),
					...(parsed.name !== undefined && { name: parsed.name }),
					...(parsed.description !== undefined && {
						description: parsed.description,
					}),
					...(parsed.address !== undefined && {
						address: parsed.address,
					}),
					...(parsed.coords !== undefined && {
						coords: parsed.coords,
					}),
					...(parsed.priority !== undefined && {
						priority: parsed.priority,
					}),
					...(parsed.starts_at !== undefined && {
						starts_at: new Date(parsed.starts_at),
					}),
					...(newEndsAt !== undefined && { ends_at: newEndsAt }),
					// The ending-soon notice belongs to the old date.
					...(endsMoved && { expiry_notified_at: null }),
					...(parsed.generation_window_days !== undefined && {
						generation_window_days: parsed.generation_window_days,
					}),
					...(parsed.min_advance_days !== undefined && {
						min_advance_days: parsed.min_advance_days,
					}),
					...(parsed.billing_mode !== undefined && {
						billing_mode: parsed.billing_mode,
					}),
					...(parsed.invoice_timing !== undefined && {
						invoice_timing: parsed.invoice_timing,
					}),
					...(parsed.auto_invoice !== undefined && {
						auto_invoice: parsed.auto_invoice,
					}),
				},
			});

			// Update recurring rule if provided
			if (parsed.rule && existing.rules.length > 0) {
				const existingRule = existing.rules[0];

				await tx.recurring_rule.update({
					where: { id: existingRule.id },
					data: {
						frequency: parsed.rule.frequency,
						interval: parsed.rule.interval,
						by_month_day: parsed.rule.by_month_day ?? null,
						by_month: parsed.rule.by_month ?? null,

						arrival_constraint: parsed.rule.arrival_constraint,
						finish_constraint: parsed.rule.finish_constraint,
						arrival_time: parsed.rule.arrival_time ?? null,
						arrival_window_start:
							parsed.rule.arrival_window_start ?? null,
						arrival_window_end:
							parsed.rule.arrival_window_end ?? null,
						finish_time: parsed.rule.finish_time ?? null,
					},
				});

				// Update weekdays - delete all and recreate
				await tx.recurring_rule_weekday.deleteMany({
					where: { recurring_rule_id: existingRule.id },
				});

				if (
					parsed.rule.by_weekday &&
					parsed.rule.by_weekday.length > 0
				) {
					await tx.recurring_rule_weekday.createMany({
						data: parsed.rule.by_weekday.map((weekday) => ({
							recurring_rule_id: existingRule.id,
							weekday: weekday,
						})),
					});
				}

				// Delete all future planned occurrences after schedule changed
				await tx.recurring_occurrence.deleteMany({
					where: {
						recurring_plan_id: existing.id,
						status: "planned",
						occurrence_start_at: {
							gte: new Date(),
						},
					},
				});

				// A paused plan refills on resume.
				if (planEffects(plan.status).generates) {
					await generateOccurrencesForPlan(
						existing.id,
						tx as unknown as Prisma.TransactionClient,
					);
				}
			}

			// Update line items if provided
			if (parsed.line_items) {
				await syncPlanLineItems(
					tx as unknown as Prisma.TransactionClient,
					organizationId,
					existing.id,
					await tx.recurring_plan_line_item.findMany({
						where: { recurring_plan_id: existing.id },
						select: { id: true },
					}),
					parsed.line_items,
				);
				if (parsed.apply_to_scheduled_visits) {
					const r = await propagateTemplateToScheduledVisits(
						tx as unknown as Prisma.TransactionClient,
						organizationId,
						existing.id,
					);
					updatedVisits = r.count;
					skippedVisits = r.skipped;
					repricedVisits = r.visits;
				}
			}

			// Update job container if relevant fields changed
			if (
				parsed.name !== undefined ||
				parsed.description !== undefined ||
				parsed.address !== undefined ||
				parsed.coords !== undefined ||
				parsed.priority !== undefined
			) {
				await tx.job.update({
					where: { id: jobId },
					data: {
						...(parsed.name !== undefined && { name: parsed.name }),
						...(parsed.description !== undefined && {
							description: parsed.description,
						}),
						...(parsed.address !== undefined && {
							address: parsed.address,
						}),
						...(parsed.coords !== undefined && {
							coords: parsed.coords,
						}),
						...(parsed.priority !== undefined && {
							priority: parsed.priority,
						}),
					},
				});
			}

			// The edit form sends billing_mode "none" without a schedule.
			if ((parsed.billing_mode ?? existing.billing_mode) === "none") {
				await tx.invoice_schedule.updateMany({
					where: { recurring_plan_id: existing.id },
					data: { is_active: false },
				});
			} else if (parsed.invoice_schedule) {
				const sched = parsed.invoice_schedule;
				const existingSchedule = await tx.invoice_schedule.findFirst({
					where: { recurring_plan_id: existing.id },
				});
				const nextInvoiceAt = nextInvoiceAtForEdit(sched, existingSchedule, plan, {
					now: new Date(),
					startsMoved: plan.starts_at.getTime() !== existing.starts_at.getTime(),
				});
				const generateDaysBefore = generateDaysBeforeForEdit(sched, existingSchedule);
				await tx.invoice_schedule.upsert({
					where: { recurring_plan_id: existing.id },
					create: {
						recurring_plan_id: existing.id,
						billing_basis: sched.billing_basis,
						fixed_amount: sched.fixed_amount ?? null,
						frequency: sched.frequency,
						day_of_month: sched.day_of_month ?? null,
						day_of_week: sched.day_of_week as weekday | null ?? null,
						generate_days_before: generateDaysBefore,
						payment_terms_days: sched.payment_terms_days ?? 30,
						auto_send: sched.auto_send ?? false,
						memo_template: sched.memo_template ?? null,
						next_invoice_at: nextInvoiceAt,
						is_active: true,
					},
					update: {
						billing_basis: sched.billing_basis,
						fixed_amount: sched.fixed_amount ?? null,
						frequency: sched.frequency,
						day_of_month: sched.day_of_month ?? null,
						day_of_week: sched.day_of_week as weekday | null ?? null,
						generate_days_before: generateDaysBefore,
						payment_terms_days: sched.payment_terms_days ?? 30,
						auto_send: sched.auto_send ?? false,
						memo_template: sched.memo_template ?? null,
						next_invoice_at: nextInvoiceAt,
						is_active: true,
					},
				});
			} else if (
				(parsed.ends_at !== undefined || existing.billing_mode === "none") &&
				planBills(plan.status as PlanStatus)
			) {
				// The invoice scheduler switches a schedule off once its billing
				// date passes ends_at, and billing_mode "none" switches it off;
				// a later end date or billing again switches it back on.
				const sched = await tx.invoice_schedule.findFirst({
					where: { recurring_plan_id: existing.id },
				});
				if (
					sched &&
					!sched.is_active &&
					sched.frequency === "on_visit_completion" &&
					existing.billing_mode === "none"
				) {
					await tx.invoice_schedule.update({
						where: { id: sched.id },
						data: { is_active: true },
					});
				} else if (
					sched &&
					!sched.is_active &&
					sched.frequency !== "on_visit_completion"
				) {
					const next = nextInvoiceAtForEdit(sched, sched, plan, {
						now: new Date(),
					});
					const endsOn =
						plan.ends_at && toLocalDate(plan.ends_at, plan.timezone);
					if (
						next &&
						(!endsOn ||
							billingDateOf(
								next,
								sched.generate_days_before,
								plan.timezone,
							) <= endsOn)
					) {
						await tx.invoice_schedule.update({
							where: { id: sched.id },
							data: { is_active: true, next_invoice_at: next },
						});
					}
				}
			}

			if (
				Object.keys(changes).length > 0 ||
				parsed.rule ||
				parsed.line_items
			) {
				logRow = await logActivityInTx(tx as unknown as Prisma.TransactionClient, {
					event_type: "recurring_plan.updated",
					action: "updated",
					entity_type: "recurring_plan",
					entity_id: existing.id,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: {
						...changes,
						...(parsed.rule && {
							rule_updated: { old: null, new: true },
						}),
						...(parsed.line_items && {
							line_items_count: {
								old: existing.line_items.length,
								new: parsed.line_items.length,
							},
						}),
						...(updatedVisits > 0 && {
							visits_repriced: { old: null, new: updatedVisits },
						}),
					},
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			// Return full plan with all relations
			return tx.recurring_plan.findUnique({
				where: { id: existing.id },
				include: RECURRING_PLAN_DETAIL_INCLUDE,
			});
		});

		if (logRow) emitActivityHints(logRow);
		for (const v of repricedVisits) recordChanged(organizationId, "visit", v.id, v.jobId);
		if (scheduleMoved && updated && planEffects(updated.status).createsVisits) {
			topUpAfterCommit(existing.id, organizationId);
		}
		return {
			err: "",
			item:
				updated && parsed.line_items
					? { ...updated, updated_visits: updatedVisits, skipped_visits: skippedVisits }
					: updated,
		};
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		// Without this the org guards surface as an opaque internal error.
		if (e instanceof Error && e.message.startsWith("Validation failed:")) {
			return { err: e.message };
		}
		log.error({ err: e }, "Update recurring plan error");
		throw e;
	}
};

export const updateRecurringPlanLineItems = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateRecurringPlanLineItemsSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const plan = await sdb.recurring_plan.findFirst({
			where: {
				job_container: {
					id: jobId,
				},
			},
			include: {
				line_items: true,
			},
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		const updated = await sdb.$transaction(async (tx) => {
			// Plan row first, so a visit generating concurrently (FOR SHARE) reads
			// the committed template rather than the one being replaced.
			await (tx as unknown as Prisma.TransactionClient).$queryRaw`
				SELECT id FROM recurring_plan WHERE id = ${plan.id} FOR NO KEY UPDATE`;
			await syncPlanLineItems(
				tx as unknown as Prisma.TransactionClient,
				organizationId,
				plan.id,
				await tx.recurring_plan_line_item.findMany({
					where: { recurring_plan_id: plan.id },
					select: { id: true },
				}),
				parsed.line_items,
			);
			const propagated = parsed.apply_to_scheduled_visits
				? await propagateTemplateToScheduledVisits(
						tx as unknown as Prisma.TransactionClient,
						organizationId,
						plan.id,
					)
				: { count: 0, skipped: 0, visits: [] };
			const repricedVisits = propagated.visits;
			const repriced = propagated.count;

			const logRow = await logActivityInTx(tx as unknown as Prisma.TransactionClient, {
				event_type: "recurring_plan.template_updated",
				action: "updated",
				entity_type: "recurring_plan",
				entity_id: plan.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					line_items_count: {
						old: plan.line_items.length,
						new: parsed.line_items.length,
					},
					...(repriced > 0 && {
						visits_repriced: { old: null, new: repriced },
					}),
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});

			const item = await tx.recurring_plan.findUnique({
				where: { id: plan.id },
				include: {
					line_items: {
						orderBy: { sort_order: "asc" },
					},
				},
			});
			return { item, logRow, repriced, skipped: propagated.skipped, repricedVisits };
		});

		emitActivityHints(updated.logRow);
		for (const v of updated.repricedVisits) {
			recordChanged(organizationId, "visit", v.id, v.jobId);
		}
		return {
			err: "",
			item: updated.item && {
				...updated.item,
				updated_visits: updated.repriced,
				skipped_visits: updated.skipped,
			},
		};
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		// Without this the org guards surface as an opaque internal error.
		if (e instanceof Error && e.message.startsWith("Validation failed:")) {
			return { err: e.message };
		}
		log.error({ err: e }, "Update recurring plan line items error");
		throw e;
	}
};

// ============================================================================
// INVOICE SCHEDULE
// ============================================================================

export const upsertInvoiceSchedule = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = updateInvoiceScheduleSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const plan = await sdb.recurring_plan.findFirst({
			where: { job_container: { id: jobId } },
		});

		if (!plan) return { err: "Recurring plan not found" };

		const existingSchedule = await sdb.invoice_schedule.findFirst({
			where: { recurring_plan_id: plan.id },
		});
		const nextInvoiceAt = nextInvoiceAtForEdit(parsed, existingSchedule, plan, {
			now: new Date(),
		});
		const generateDaysBefore = generateDaysBeforeForEdit(parsed, existingSchedule);

		const schedule = await sdb.invoice_schedule.upsert({
			where: { recurring_plan_id: plan.id },
			create: {
				recurring_plan_id: plan.id,
				billing_basis: parsed.billing_basis,
				fixed_amount: parsed.fixed_amount ?? null,
				frequency: parsed.frequency,
				day_of_month: parsed.day_of_month ?? null,
				day_of_week: parsed.day_of_week as weekday | null ?? null,
				generate_days_before: generateDaysBefore,
				payment_terms_days: parsed.payment_terms_days ?? 30,
				auto_send: parsed.auto_send ?? false,
				memo_template: parsed.memo_template ?? null,
				next_invoice_at: nextInvoiceAt,
				is_active: plan.billing_mode !== "none",
			},
			update: {
				billing_basis: parsed.billing_basis,
				fixed_amount: parsed.fixed_amount ?? null,
				frequency: parsed.frequency,
				day_of_month: parsed.day_of_month ?? null,
				day_of_week: parsed.day_of_week as weekday | null ?? null,
				generate_days_before: generateDaysBefore,
				payment_terms_days: parsed.payment_terms_days ?? 30,
				auto_send: parsed.auto_send ?? false,
				memo_template: parsed.memo_template ?? null,
				next_invoice_at: nextInvoiceAt,
				is_active: plan.billing_mode !== "none",
			},
		});

		return { err: "", item: schedule };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues.map((err) => err.message).join(", ")}`,
			};
		}
		log.error({ err: e }, "Upsert invoice schedule error");
		throw e;
	}
};

export const deleteInvoiceSchedule = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const plan = await sdb.recurring_plan.findFirst({
		where: { job_container: { id: jobId } },
	});

	if (!plan) return { err: "Recurring plan not found" };

	await sdb.invoice_schedule.deleteMany({
		where: { recurring_plan_id: plan.id },
	});

	return { err: "" };
};

// ============================================================================
// PLAN LIFECYCLE ACTIONS
// ============================================================================

export const pauseRecurringPlan = (
	jobId: string,
	organizationId: string,
	context?: UserContext,
) => transitionRecurringPlan(jobId, "Paused", organizationId, context);

export const resumeRecurringPlan = (
	jobId: string,
	organizationId: string,
	context?: UserContext,
) => transitionRecurringPlan(jobId, "Active", organizationId, context);

export const renewRecurringPlan = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	const parsed = renewRecurringPlanSchema.safeParse(data);
	if (!parsed.success) {
		return {
			err: `Validation failed: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
		};
	}
	const endsAt = parsed.data.ends_at === null ? null : new Date(parsed.data.ends_at);
	return transitionRecurringPlan(jobId, "Active", organizationId, context, { endsAt });
};

export const cancelRecurringPlan = async (
	jobId: string,
	organizationId: string,
	context?: UserContext,
	data: unknown = {},
) => {
	const parsed = cancelRecurringPlanSchema.safeParse(data ?? {});
	if (!parsed.success) {
		return {
			err: `Validation failed: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
		};
	}
	return transitionRecurringPlan(jobId, "Cancelled", organizationId, context, {
		reason: parsed.data.reason,
	});
};

export const completeRecurringPlan = (
	jobId: string,
	organizationId: string,
	context?: UserContext,
) => transitionRecurringPlan(jobId, "Completed", organizationId, context);

// ============================================================================
// OCCURRENCE MANAGEMENT
// ============================================================================

export const getOccurrencesByJobId = async (jobId: string, organizationId: string) => {
	const sdb = getScopedDb(organizationId);
	const plan = await sdb.recurring_plan.findFirst({
		where: {
			job_container: {
				id: jobId,
			},
		},
	});

	if (!plan) {
		return [];
	}

	return await sdb.recurring_occurrence.findMany({
		where: { recurring_plan_id: plan.id },
		include: {
			job_visit: {
				include: {
					visit_techs: {
						include: {
							tech: true,
						},
					},
				},
			},
		},
		orderBy: { occurrence_start_at: "asc" },
	});
};

export const generateOccurrences = async (
	jobId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = generateOccurrencesSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const plan = await sdb.recurring_plan.findFirst({
			where: {
				job_container: {
					id: jobId,
				},
			},
		});

		if (!plan) {
			return { err: "Recurring plan not found" };
		}

		if (!planEffects(plan.status).generates) {
			return { err: planInactiveMessage(plan.status) };
		}

		const result = await sdb.$transaction(async (stx) => {
			const tx = stx as unknown as Prisma.TransactionClient;
			// Plan row first, as top-up takes it; unrepaired legacy rows would
			// leave their true slots looking empty.
			await tx.$queryRaw`
				SELECT id FROM recurring_plan WHERE id = ${plan.id} FOR NO KEY UPDATE`;
			await reconcileLegacySlots(plan.id, tx);
			return await generateOccurrencesForPlan(plan.id, tx, {
				daysAhead: parsed.days_ahead,
			});
		});

		await logActivity({
			event_type: "recurring_occurrence.generated",
			action: "created",
			entity_type: "recurring_plan",
			entity_id: plan.id,
			organization_id: plan.organization_id,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				generated_count: { old: null, new: result.generated },
				days_ahead: {
					old: null,
					new: parsed.days_ahead ?? plan.generation_window_days,
				},
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: result };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		if (isClientMessage(e)) {
			return { err: e.message };
		}
		log.error({ err: e }, "Generate occurrences error");
		throw e;
	}
};

export const skipOccurrence = async (
	occurrenceId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = skipOccurrenceSchema.parse(data);
		const sdb = getScopedDb(organizationId);
		const occurrence = await sdb.recurring_occurrence.findUnique({
			where: { id: occurrenceId },
		});

		if (!occurrence) {
			return { err: "Occurrence not found" };
		}

		if (occurrence.status !== "planned") {
			return { err: "Can only skip planned occurrences" };
		}

		const updated = await sdb.recurring_occurrence.update({
			where: { id: occurrenceId },
			data: {
				status: "skipped",
				skip_reason: parsed.skip_reason,
				skipped_at: new Date(),
			},
		});

		await logActivity({
			event_type: "recurring_occurrence.skipped",
			action: "updated",
			entity_type: "recurring_occurrence",
			entity_id: occurrenceId,
			organization_id: organizationId,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				status: { old: "planned", new: "skipped" },
				skip_reason: { old: null, new: parsed.skip_reason },
				...parentBreadcrumb("recurring_plan", occurrence.recurring_plan_id),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
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
		log.error({ err: e }, "Skip occurrence error");
		throw e;
	}
};

/** A reschedule refused once the plan is locked; carries the user-facing reason. */
class RescheduleRefusal extends Error {}

export const rescheduleOccurrence = async (
	occurrenceId: string,
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = rescheduleOccurrenceSchema.parse(data);

		const sdb = getScopedDb(organizationId);
		const found = await sdb.recurring_occurrence.findUnique({
			where: { id: occurrenceId },
			select: { recurring_plan_id: true },
		});

		if (!found) {
			return { err: "Occurrence not found" };
		}

		const newStartDate = new Date(parsed.new_start_at);
		type TimeField = (typeof RULE_TIME_FIELDS)[number];

		// original_start_at is the rule slot's identity (unique per plan); it is
		// deliberately never written here so generation can't re-create the slot.
		const { updated, before, newEndDate, keptVisits } = await sdb.$transaction(async (stx) => {
			const tx = stx as unknown as Prisma.TransactionClient;
			// Plan row first, as updateRecurringPlan takes it before the rule and
			// the occurrences; the rule and the row are read only under it.
			const lockedPlan = await tx.$queryRaw<{ id: string }[]>`
				SELECT id FROM recurring_plan WHERE id = ${found.recurring_plan_id} FOR NO KEY UPDATE`;
			if (lockedPlan.length === 0) throw new RescheduleRefusal("Recurring plan not found");
			const plan = await tx.recurring_plan.findUnique({
				where: { id: found.recurring_plan_id },
				include: { rules: { include: { by_weekday: true } } },
			});
			if (!plan) throw new RescheduleRefusal("Recurring plan not found");
			if (!planEffects(plan.status).createsVisits) {
				throw new RescheduleRefusal(planInactiveMessage(plan.status));
			}
			const occurrence = await tx.recurring_occurrence.findUnique({
				where: { id: occurrenceId },
			});
			if (!occurrence) throw new RescheduleRefusal("Occurrence not found");
			if (occurrence.status !== "planned") {
				throw new RescheduleRefusal("Can only reschedule planned occurrences");
			}

			const tz = plan.timezone;
			// Surfaces a bad stored timezone as InvalidPlanScheduleError, not a RangeError.
			planLocalDate(plan, occurrence.occurrence_start_at);
			// Keep the visit's length when only the start moves.
			const newEndDate = parsed.new_end_at
				? new Date(parsed.new_end_at)
				: new Date(
						newStartDate.getTime() +
							(occurrence.occurrence_end_at.getTime() - occurrence.occurrence_start_at.getTime()),
					);

			const oldWall = localWallTime(occurrence.occurrence_start_at, tz);
			const newWall = localWallTime(newStartDate, tz);
			if (parsed.scope === "future" && oldWall.date !== newWall.date) {
				throw new RescheduleRefusal(
					"To move every future visit to another day, edit the plan's schedule.",
				);
			}

			// Build optional constraint update data
			const constraintData = {
				...(parsed.arrival_constraint   !== undefined && { arrival_constraint:   parsed.arrival_constraint }),
				...(parsed.finish_constraint    !== undefined && { finish_constraint:    parsed.finish_constraint }),
				...(parsed.arrival_time         !== undefined && { arrival_time:         parsed.arrival_time }),
				...(parsed.arrival_window_start !== undefined && { arrival_window_start: parsed.arrival_window_start }),
				...(parsed.arrival_window_end   !== undefined && { arrival_window_end:   parsed.arrival_window_end }),
				...(parsed.finish_time          !== undefined && { finish_time:          parsed.finish_time }),
			};

			const effectiveArrival = parsed.arrival_constraint ?? occurrence.arrival_constraint;
			// A single visit on a fixed "at" arrival must keep arrival_time in step with
			// its start, because the visit is generated from this field.
			const targetTimeData =
				parsed.arrival_time === undefined && effectiveArrival === "at"
					? { arrival_time: newWall.hhmm }
					: {};

			// "This & all future": move the rule's start to the requested time, shifting
			// every set rule time by the same wall-clock delta, then derive each row's
			// start/end (target included) from that rule on the row's own local date.
			let shiftedTimes: Record<TimeField, string | null> | null = null;
			let futureTimes: { startHHMM: string; durationMinutes: number } | null = null;
			if (parsed.scope === "future") {
				const rule = plan.rules[0];
				if (!rule) throw new RescheduleRefusal("Plan has no rules defined");
				const base = toSlotRule(rule);
				if (
					RULE_TIME_FIELDS.some((f) => parsed[f] !== undefined) ||
					(parsed.arrival_constraint !== undefined &&
						parsed.arrival_constraint !== base.arrival_constraint) ||
					(parsed.finish_constraint !== undefined &&
						parsed.finish_constraint !== base.finish_constraint)
				) {
					throw new RescheduleRefusal(
						"To change the plan's arrival window or finish time, edit the plan's schedule.",
					);
				}
				// Measured from the rule's start, not this visit's: it may have been
				// moved on its own earlier.
				const baseStart = visitTimesForRule(base).startHHMM;
				if (base.arrival_constraint === "anytime" && newWall.hhmm !== baseStart) {
					throw new RescheduleRefusal(
						"Visits with an anytime arrival always start at 09:00. To change the time of every future visit, edit the plan's schedule.",
					);
				}
				const delta = wallMinutes(newWall.hhmm) - wallMinutes(baseStart);
				const shifted = {} as Record<TimeField, string | null>;
				for (const f of RULE_TIME_FIELDS) {
					const cur = base[f];
					if (!cur) {
						shifted[f] = null;
						continue;
					}
					const m = HHMM_PARTS.exec(cur);
					if (!m) {
						throw new InvalidPlanScheduleError(plan.id, new RangeError(`Invalid wall time: ${cur}`));
					}
					const next = Number(m[1]) * 60 + Number(m[2]) + delta;
					if (next < 0 || next > 24 * 60 - 1) {
						throw new RescheduleRefusal(
							"That move would push the plan's times past midnight — edit the plan's schedule instead.",
						);
					}
					shifted[f] = `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
				}
				const futureRule: SlotRule = { ...base, ...shifted };
				const times = visitTimesForRule(futureRule);
				// A `by` deadline clamps its derived start at 09:00, so shifting the
				// deadline doesn't always move the visit; refuse rather than diverge.
				if (
					times.startHHMM !== newWall.hhmm ||
					(shifted.arrival_window_start &&
						shifted.arrival_window_end &&
						shifted.arrival_window_start > shifted.arrival_window_end)
				) {
					throw new RescheduleRefusal(
						"This plan's arrival rule can't move to that time — edit the plan's schedule.",
					);
				}
				shiftedTimes = shifted;
				futureTimes = times;
			}

			let targetStart = newStartDate;
			let targetEnd = newEndDate;
			if (futureTimes) {
				targetStart = zonedWallTimeToUtc(newWall.date, futureTimes.startHHMM, tz);
				targetEnd = new Date(targetStart.getTime() + futureTimes.durationMinutes * 60_000);
			}
			const row = await tx.recurring_occurrence.update({
				where: { id: occurrenceId },
				data: {
					occurrence_start_at: targetStart,
					occurrence_end_at: targetEnd,
					...(shiftedTimes ?? { ...targetTimeData, ...constraintData }),
				},
			});

			let keptVisits = 0;
			if (shiftedTimes && futureTimes) {
				const futureOccurrences = await tx.recurring_occurrence.findMany({
					where: {
						recurring_plan_id: occurrence.recurring_plan_id,
						occurrence_start_at: { gt: occurrence.occurrence_start_at },
						status: "planned",
						id: { not: occurrenceId },
					},
					select: { id: true, occurrence_start_at: true },
				});
				// Re-time on each visit's own local date: a fixed UTC delta would drift
				// an hour across a DST change.
				for (const o of futureOccurrences) {
					const start = zonedWallTimeToUtc(
						toLocalDate(o.occurrence_start_at, tz),
						futureTimes.startHHMM,
						tz,
					);
					await tx.recurring_occurrence.update({
						where: { id: o.id },
						data: {
							occurrence_start_at: start,
							occurrence_end_at: new Date(start.getTime() + futureTimes.durationMinutes * 60_000),
							...shiftedTimes,
						},
					});
				}

				// New occurrences inherit the change through the rule.
				await tx.recurring_rule.updateMany({
					where: { recurring_plan_id: occurrence.recurring_plan_id },
					data: shiftedTimes,
				});

				// Visits already made keep their time; the dispatcher is told how many.
				keptVisits = await tx.recurring_occurrence.count({
					where: {
						recurring_plan_id: occurrence.recurring_plan_id,
						occurrence_start_at: { gt: occurrence.occurrence_start_at },
						status: "generated",
					},
				});
			}
			return { updated: row, before: occurrence, newEndDate, keptVisits };
		});

		await logActivity({
			event_type: "recurring_occurrence.rescheduled",
			action: "updated",
			entity_type: "recurring_occurrence",
			entity_id: occurrenceId,
			organization_id: organizationId,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				occurrence_start_at: {
					old: before.occurrence_start_at,
					new: newStartDate,
				},
				occurrence_end_at: {
					old: before.occurrence_end_at,
					new: newEndDate,
				},
				...parentBreadcrumb("recurring_plan", before.recurring_plan_id),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return {
			err: "",
			item: parsed.scope === "future" ? { ...updated, kept_visits: keptVisits } : updated,
		};
	} catch (e) {
		if (e instanceof ZodError) {
			log.error({ err: e }, "Reschedule occurrence validation error");
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}

		if (e instanceof RescheduleRefusal) return { err: e.message };
		if (e instanceof InvalidPlanScheduleError) return { err: e.message };
		log.error({ err: e }, "Reschedule occurrence error");
		if (isClientMessage(e)) {
			return { err: e.message };
		}
		throw e;
	}
};

export const bulkSkipOccurrences = async (
	data: unknown,
	organizationId: string,
	context?: UserContext,
) => {
	try {
		const parsed = bulkSkipOccurrencesSchema.parse(data);
		const sdb = getScopedDb(organizationId);

		const { result, representativePlanId } = await sdb.$transaction(async (tx) => {
			const representative = await tx.recurring_occurrence.findUnique({
				where: { id: parsed.occurrence_ids[0] },
				select: { recurring_plan_id: true },
			});

			const updated = await tx.recurring_occurrence.updateMany({
				where: {
					id: { in: parsed.occurrence_ids },
					status: "planned",
				},
				data: {
					status: "skipped",
					skip_reason: parsed.skip_reason,
					skipped_at: new Date(),
				},
			});

			return { result: updated, representativePlanId: representative?.recurring_plan_id ?? null };
		});

		await logActivity({
			event_type: "recurring_occurrence.bulk_skipped",
			action: "updated",
			entity_type: "recurring_occurrence",
			entity_id: parsed.occurrence_ids[0],
			organization_id: organizationId,
			actor_type: context?.techId
				? "technician"
				: context?.dispatcherId
					? "dispatcher"
					: "system",
			actor_id: context?.techId || context?.dispatcherId,
			changes: {
				count: { old: null, new: result.count },
				skip_reason: { old: null, new: parsed.skip_reason },
				...(representativePlanId ? parentBreadcrumb("recurring_plan", representativePlanId) : {}),
			},
			ip_address: context?.ipAddress,
			user_agent: context?.userAgent,
		});

		return { err: "", item: { skipped: result.count } };
	} catch (e) {
		if (e instanceof ZodError) {
			return {
				err: `Validation failed: ${e.issues
					.map((err) => err.message)
					.join(", ")}`,
			};
		}
		log.error({ err: e }, "Bulk skip occurrences error");
		throw e;
	}
};

// ============================================================================
// VISIT GENERATION
// ============================================================================

export const generateVisitFromOccurrence = async (
	occurrenceId: string,
	organizationId: string,
	context?: UserContext,
): Promise<{ err: string; item?: VisitGenerationResult }> => {
	try {
		const sdb = getScopedDb(organizationId);
		const occurrence = await sdb.recurring_occurrence.findUnique({
			where: { id: occurrenceId },
			include: {
				recurring_plan: {
					include: {
						client: { select: { name: true } },
						line_items: {
							orderBy: { sort_order: "asc" },
						},
						job_container: true,
						rules: {
							include: {
								by_weekday: true,
							},
						},
					},
				},
			},
		});

		if (!occurrence) {
			return { err: "Occurrence not found" };
		}

		if (occurrence.status !== "planned") {
			return { err: "Occurrence must be in planned state" };
		}

		if (occurrence.job_visit_id) {
			return { err: "Visit already generated for this occurrence" };
		}

		const plan = occurrence.recurring_plan;
		if (!planEffects(plan.status).createsVisits) {
			return { err: planInactiveMessage(plan.status) };
		}
		const rule = plan.rules[0];
		// Lazy, as in cancelJob: the lifecycle's load graph reaches the email service.
		const { syncJobFromVisits, runJobChangePostCommit } = await import(
			"../services/visitLifecycle/index.js"
		);
		const containerJobId = plan.job_container!.id;

		const { jobChange, logRow, assignedLogRow, assignedTechId, ...result } = await sdb.$transaction(async (tx) => {
			// Same order as transitionRecurringPlan: plan row, then occurrence,
			// then job. Sharing the plan lock also serialises us behind a
			// transition, so the status read here is the committed one.
			const [locked] = await (tx as unknown as Prisma.TransactionClient).$queryRaw<
				{ status: PlanStatus }[]
			>`SELECT status::text AS status FROM recurring_plan WHERE id = ${plan.id} FOR SHARE`;
			if (!locked || !planEffects(locked.status).createsVisits) {
				throw new PlanTransitionError(planInactiveMessage(locked?.status ?? "Cancelled"));
			}
			// A reschedule writes the times under the plan lock, so the read
			// before it may be stale.
			const current = await tx.recurring_occurrence.findUnique({
				where: { id: occurrenceId },
			});
			if (!current || current.status !== "planned" || current.job_visit_id) {
				throw new PlanTransitionError(
					"Occurrence must be in planned state with no visit generated yet",
				);
			}
			// Read under the share lock: a template edit holds the plan row exclusively,
			// so this is the committed template and propagation can't miss this visit.
			const templateLines = await tx.recurring_plan_line_item.findMany({
				where: { recurring_plan_id: plan.id },
				orderBy: { sort_order: "asc" },
			});

			// The visit is created here, so no other writer can reach it before
			// commit and no visit lock is needed. An inactive or foreign default
			// tech yields an unassigned visit rather than a failed generation.
			const defaultTech = plan.default_technician_id
				? await tx.technician.findFirst({
						where: {
							id: plan.default_technician_id,
							organization_id: organizationId,
							deactivated_at: null,
							deleted_at: null,
						},
						select: { id: true, name: true },
					})
				: null;

			// Calculate subtotal from template line items
			const subtotal = templateLines.reduce(
				(sum, item) =>
					sum + Number(item.quantity) * Number(item.unit_price),
				0,
			);

			const visit = await tx.job_visit.create({
				data: {
					job_id: plan.job_container!.id,
					scheduled_start_at: current.occurrence_start_at,
					scheduled_end_at: current.occurrence_end_at,

					arrival_constraint: current.arrival_constraint,
					finish_constraint: current.finish_constraint,
					arrival_time: current.arrival_time,
					arrival_window_start: current.arrival_window_start,
					arrival_window_end: current.arrival_window_end,
					finish_time: current.finish_time,

					status: "Scheduled",
					...(defaultTech && {
						visit_techs: { create: [{ tech_id: defaultTech.id }] },
					}),
					subtotal: subtotal,
					tax_rate: plan.job_container!.tax_rate || 0,

					// Copy template line items
					line_items: {
						createMany: {
							data: templateLines.map((item, idx) => ({
								name: item.name,
								description: item.description,
								quantity: Number(item.quantity),
								unit_price: Number(item.unit_price),
								total:
									Number(item.quantity) *
									Number(item.unit_price),
								source: "recurring_plan",
								item_type: item.item_type,
								taxable: item.taxable,
								tax_group_id: item.tax_group_id,
								sort_order: idx,
								// A generated visit's parts are planned parts —
								// same lifecycle a dispatcher gets when they
								// attach an item by hand, so readiness and the
								// completion deduction see them identically.
								// Intent rides along with the link: a plan
								// whose part is vendor-direct generates
								// vendor-direct visit lines, not warehouse
								// deductions.
								...plannedLineItemFields(
									item.inventory_item_id,
									Number(item.quantity),
									item,
								),
							})),
						},
					},
				},
			});

			const claimed = await tx.recurring_occurrence.updateMany({
				where: { id: occurrenceId, status: "planned", job_visit_id: null },
				data: {
					status: "generated",
					job_visit_id: visit.id,
					generated_at: new Date(),
				},
			});
			if (claimed.count === 0) {
				throw new PlanTransitionError(
					"Occurrence must be in planned state with no visit generated yet",
				);
			}

			// Plans carry no snapshot; a container job holding a kept rate taxes its visits with it.
			const ptx = tx as unknown as Prisma.TransactionClient;
			if (await holdsKeptRate("job", plan.job_container!.id, ptx)) {
				await recomputeVisitTotals(visit.id, organizationId, ptx);
			}
			// A new open visit reopens a container job that had closed out.
			const jobChange = await syncJobFromVisits(ptx, organizationId, containerJobId, {
				context,
			});

			const logRow = await logActivityInTx(ptx, {
				event_type: "job_visit.generated_from_occurrence",
				action: "created",
				entity_type: "job_visit",
				entity_id: visit.id,
				organization_id: organizationId,
				actor_type: context?.techId
					? "technician"
					: context?.dispatcherId
						? "dispatcher"
						: "system",
				actor_id: context?.techId || context?.dispatcherId,
				changes: {
					occurrence_id: { old: null, new: occurrenceId },
					scheduled_start_at: {
						old: null,
						new: visit.scheduled_start_at,
					},
				},
				ip_address: context?.ipAddress,
				user_agent: context?.userAgent,
			});
			// The assignment is part of the creation entry, as a manual one is its own.
			let assignedLogRow: Awaited<ReturnType<typeof logActivityInTx>> | null = null;
			if (defaultTech) {
				assignedLogRow = await logActivityInTx(ptx, {
					event_type: "job_visit.technicians_assigned",
					action: "updated",
					entity_type: "job_visit",
					entity_id: visit.id,
					organization_id: organizationId,
					actor_type: context?.techId
						? "technician"
						: context?.dispatcherId
							? "dispatcher"
							: "system",
					actor_id: context?.techId || context?.dispatcherId,
					changes: {
						technicians: { old: [], new: [defaultTech.name] },
						...parentBreadcrumb("job", containerJobId),
					},
					ip_address: context?.ipAddress,
					user_agent: context?.userAgent,
				});
			}

			return {
				visit_id: visit.id,
				occurrence_id: occurrenceId,
				scheduled_start_at: visit.scheduled_start_at,
				scheduled_end_at: visit.scheduled_end_at,
				template_version: current.template_version,
				jobChange,
				logRow,
				assignedLogRow,
				assignedTechId: defaultTech?.id ?? null,
			};
		});

		// Post-commit so a rolled-back generation never messages the customer.
		emitActivityHints(logRow);
		if (assignedLogRow) emitActivityHints(assignedLogRow);
		if (assignedTechId) {
			try {
				await notifyVisitAssigned(
					[assignedTechId],
					result.visit_id,
					plan.client?.name ?? "the client",
					result.scheduled_start_at,
					organizationId,
					plan.timezone,
				);
			} catch (err) {
				log.warn({ err, visitId: result.visit_id }, "default technician notice failed");
			}
		}
		void onVisitScheduled(result.visit_id, organizationId);
		void notifyVisitScheduled(result.visit_id, organizationId);
		if (jobChange) {
			await runJobChangePostCommit(
				{ orgId: organizationId, jobId: containerJobId, change: jobChange },
				context,
			);
		}

		return { err: "", item: result };
	} catch (e) {
		if (isClientMessage(e)) {
			return { err: e.message };
		}
		log.error({ err: e }, "Generate visit from occurrence error");
		throw e;
	}
};
