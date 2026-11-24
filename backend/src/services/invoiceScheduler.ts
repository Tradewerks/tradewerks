import { isModuleOn } from "./entitlementService.js";
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { buildRecurringPlanInvoicePayload } from "./invoiceGenerator.js";
import { createInvoiceRecord } from "./invoiceService.js";
import {
	advanceNextInvoiceAt,
	billingDateOf,
	calculateNextInvoiceAt,
	scheduleAnchor,
} from "../lib/invoiceSchedule.js";
import { toLocalDate } from "../lib/recurrence/zonedTime.js";
import { planBills, type PlanStatus } from "../lib/recurringPlanState.js";
import { notifyDispatchers } from "../controllers/notificationsController.js";
import { logActivity } from "./logger.js";
import { log } from "./appLogger.js";

class ScheduleMoved extends Error {}
class PlanNotBilling extends Error {}

const FAILURE_MESSAGE_MAX = 500;

export async function runScheduledInvoiceGeneration(): Promise<void> {
	const now = new Date();

	// Unscoped db — cross-org system process. Only Active plans bill; a paused
	// or expired plan's schedule is left due, and resume/renew move a past
	// next_invoice_at to today forward, so nothing is back-billed.
	const dueSchedules = await db.invoice_schedule.findMany({
		where: {
			is_active: true,
			next_invoice_at: { lte: now },
			frequency: { not: "on_visit_completion" },
			recurring_plan: { status: "Active" },
		},
		include: {
			recurring_plan: {
				select: {
					id: true,
					organization_id: true,
					client_id: true,
					name: true,
					status: true,
					timezone: true,
					starts_at: true,
					ends_at: true,
				},
			},
		},
	});

	if (dueSchedules.length === 0) return;

	log.info({ count: dueSchedules.length }, "Running scheduled invoice generation");

	// Sequential — NOT Promise.all — prevents invoice number race condition
	for (const schedule of dueSchedules) {
		const plan = schedule.recurring_plan;
		const orgId = plan?.organization_id;
		if (!plan || !orgId) continue;
		if (!(await isModuleOn(orgId, "recurring_plans"))) continue;
		const claim = {
			id: schedule.id,
			is_active: true,
			last_invoiced_at: schedule.last_invoiced_at,
			next_invoice_at: schedule.next_invoice_at,
		};
		const clearFailure = { last_failure_at: null, last_failure_message: null };

		try {
			const sdb = getScopedDb(orgId);

			// The billing date, not the earlier generation date, decides whether
			// the period falls inside the plan.
			if (
				plan.ends_at &&
				schedule.next_invoice_at &&
				billingDateOf(
					schedule.next_invoice_at,
					schedule.generate_days_before,
					plan.timezone,
				) > toLocalDate(plan.ends_at, plan.timezone)
			) {
				await db.invoice_schedule.updateMany({
					where: claim,
					data: { is_active: false },
				});
				log.info(
					{ plan_id: plan.id, org_id: orgId, schedule_id: schedule.id },
					"Invoice schedule is past the plan's end date — deactivated",
				);
				continue;
			}

			// Advance from the scheduled anchor so a late run (e.g. after
			// downtime) chains forward correctly without skipping periods.
			const anchor = scheduleAnchor(schedule, plan.timezone);
			const nextInvoiceAt = schedule.next_invoice_at
				? advanceNextInvoiceAt(anchor, schedule.next_invoice_at)
				: calculateNextInvoiceAt(anchor, { from: now, notBefore: plan.starts_at });

			const { payload, warnings, empty } = await buildRecurringPlanInvoicePayload(
				schedule.recurring_plan_id,
				sdb,
			);

			if (empty) {
				// last_invoiced_at stays: visit_actuals scopes the next period by it.
				const moved = await db.invoice_schedule.updateMany({
					where: claim,
					data: { next_invoice_at: nextInvoiceAt, ...clearFailure },
				});
				if (moved.count === 0) {
					throw new ScheduleMoved(`Schedule ${schedule.id} was concurrently modified — skipping`);
				}
				log.info(
					{ plan_id: plan.id, org_id: orgId, skipped_visits: warnings.length },
					"Nothing to bill this period — no invoice created",
				);
				continue;
			}

			if (warnings.length > 0) {
				const warningText = warnings
					.map(
						(w) =>
							`Visit ${new Date(w.scheduled_start_at).toLocaleDateString("en-US", { timeZone: plan.timezone })} left off, already on: ${w.existing_invoices.map((i) => i.invoice_number).join(", ")}`,
					)
					.join("\n");
				payload.internal_notes = `[Auto-generated] Overlap warnings:\n${warningText}${payload.internal_notes ? `\n\n${payload.internal_notes}` : ""}`;
			}

			// Invoice create + schedule advance in one transaction
			const created = await db.$transaction(async (tx) => {
				// The due list is a snapshot: a pause or cancel since then holds
				// the plan row, so its status is re-read under it, plan before
				// schedule as every plan writer locks.
				const [locked] = await tx.$queryRaw<{ status: PlanStatus }[]>`
					SELECT status::text AS status FROM recurring_plan
					WHERE id = ${plan.id} FOR SHARE`;
				if (!locked || !planBills(locked.status)) {
					throw new PlanNotBilling(`Plan ${plan.id} is no longer billing — skipping`);
				}

				const updateResult = await tx.invoice_schedule.updateMany({
					where: claim,
					data: {
						last_invoiced_at: now,
						next_invoice_at: nextInvoiceAt,
						...clearFailure,
					},
				});
				if (updateResult.count === 0) {
					throw new ScheduleMoved(`Schedule ${schedule.id} was concurrently modified — skipping`);
				}

				return createInvoiceRecord(payload, orgId, null, tx);
			});

			log.info(
				{ plan_id: schedule.recurring_plan_id, org_id: orgId, invoice_id: created.id },
				"Scheduled invoice generated",
			);

			notifyDispatchers(
				{
					type: "recurring_invoice_created",
					title: "Recurring invoice drafted",
					body: `${plan.name}: ${created.invoice_number} is ready to review`,
					actionUrl: `/dispatch/invoices/${created.id}`,
				},
				orgId,
			).catch((err) => {
				log.warn({ err, invoice_id: created.id }, "Recurring invoice notification failed");
			});

			// logActivity is non-critical — its failure must not mask the invoice creation
			logActivity({
				event_type: "invoice.created",
				action: "created",
				entity_type: "invoice",
				entity_id: created.id,
				organization_id: orgId,
				actor_type: "system",
				actor_id: null,
				changes: {
					invoice_number: { old: null, new: created.invoice_number },
					client_id: { old: null, new: created.client_id },
					total: { old: null, new: created.total },
					status: { old: null, new: created.status },
					recurring_plan_id: { old: null, new: created.recurring_plan_id ?? null },
				},
			}).catch((logErr) => {
				log.warn({ err: logErr, invoice_id: created.id }, "Scheduled invoice created but activity log failed");
			});
		} catch (err) {
			// A concurrent writer already handled this period.
			if (err instanceof ScheduleMoved || err instanceof PlanNotBilling) {
				log.warn({ schedule_id: schedule.id, org_id: orgId }, err.message);
				continue;
			}
			log.error(
				{ err, schedule_id: schedule.id, org_id: orgId },
				"Failed to generate scheduled invoice — continuing",
			);
			await recordFailure(claim, schedule, plan, orgId, err).catch((recErr) =>
				log.error({ err: recErr, schedule_id: schedule.id }, "Could not record invoice schedule failure"),
			);
		}
	}
}

/**
 * Stores the failure; dispatchers hear about it once per period. Claimed like
 * the bill itself, so a run that lost the period to another (or to another
 * failing run) neither stamps the advanced schedule nor notifies twice.
 */
async function recordFailure(
	claim: {
		id: string;
		is_active: boolean;
		last_invoiced_at: Date | null;
		next_invoice_at: Date | null;
	},
	schedule: { next_invoice_at: Date | null; last_failure_at: Date | null },
	plan: { id: string; name: string },
	orgId: string,
	err: unknown,
): Promise<void> {
	const message = (err instanceof Error ? err.message : String(err)).slice(0, FAILURE_MESSAGE_MAX);
	const firstThisPeriod =
		!schedule.last_failure_at ||
		(schedule.next_invoice_at !== null && schedule.last_failure_at < schedule.next_invoice_at);
	const written = await db.invoice_schedule.updateMany({
		where: { ...claim, last_failure_at: schedule.last_failure_at },
		data: { last_failure_at: new Date(), last_failure_message: message },
	});
	if (written.count !== 1 || !firstThisPeriod) return;
	await notifyDispatchers(
		{
			type: "recurring_invoice_failed",
			title: "Recurring invoice failed",
			body: `${plan.name}: ${message}`,
			actionUrl: `/dispatch/recurring-plans/${plan.id}`,
		},
		orgId,
	);
}

export function startInvoiceSchedulerInterval(): void {
	// Startup run catches any windows missed during downtime
	runScheduledInvoiceGeneration().catch((err) =>
		log.error({ err }, "Invoice scheduler startup run failed"),
	);

	setInterval(() => {
		runScheduledInvoiceGeneration().catch((err) =>
			log.error({ err }, "Invoice scheduler interval run failed"),
		);
	}, 60 * 60 * 1000); // hourly
}
