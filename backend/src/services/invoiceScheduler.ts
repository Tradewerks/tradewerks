import { isModuleOn } from "./entitlementService.js";
import { db } from "../db.js";
import { getScopedDb } from "../lib/context.js";
import { buildRecurringPlanInvoicePayload } from "./invoiceGenerator.js";
import { createInvoiceRecord } from "./invoiceService.js";
import { advanceNextInvoiceAt, calculateNextInvoiceAt, type ScheduleFrequency } from "../lib/invoiceSchedule.js";
import { logActivity } from "./logger.js";
import { log } from "./appLogger.js";

export async function runScheduledInvoiceGeneration(): Promise<void> {
	const now = new Date();

	// Unscoped db — cross-org system process
	const dueSchedules = await db.invoice_schedule.findMany({
		where: {
			is_active: true,
			next_invoice_at: { lte: now },
			frequency: { not: "on_visit_completion" },
		},
		include: {
			recurring_plan: {
				select: { id: true, organization_id: true, client_id: true },
			},
		},
	});

	if (dueSchedules.length === 0) return;

	log.info({ count: dueSchedules.length }, "Running scheduled invoice generation");

	// Sequential — NOT Promise.all — prevents invoice number race condition
	for (const schedule of dueSchedules) {
		if (!schedule.recurring_plan?.organization_id) continue;

		const orgId = schedule.recurring_plan.organization_id;
		if (!(await isModuleOn(orgId, "recurring_plans"))) continue;
		const sdb = getScopedDb(orgId);

		try {
			const { payload, warnings } = await buildRecurringPlanInvoicePayload(
				schedule.recurring_plan_id,
				sdb,
			);

			if (warnings.length > 0) {
				const warningText = warnings
					.map(
						(w) =>
							`Visit ${new Date(w.scheduled_start_at).toLocaleDateString()} already billed on: ${w.existing_invoices.map((i) => i.invoice_number).join(", ")}`,
					)
					.join("\n");
				payload.internal_notes = `[Auto-generated] Overlap warnings:\n${warningText}${payload.internal_notes ? `\n\n${payload.internal_notes}` : ""}`;
			}

			// Invoice create + schedule advance in one transaction
			const created = await db.$transaction(async (tx) => {
				const inv = await createInvoiceRecord(payload, orgId, null, tx);

				// Advance from the scheduled anchor so a late run (e.g. after
			// downtime) chains forward correctly without skipping periods.
			const nextInvoiceAt = schedule.next_invoice_at
				? advanceNextInvoiceAt(
					schedule.frequency as ScheduleFrequency,
					schedule.day_of_month ?? null,
					schedule.day_of_week ?? null,
					schedule.generate_days_before ?? 0,
					schedule.next_invoice_at,
				)
				: calculateNextInvoiceAt(
					schedule.frequency as ScheduleFrequency,
					schedule.day_of_month ?? null,
					schedule.day_of_week ?? null,
					schedule.generate_days_before ?? 0,
				);

				const updateResult = await tx.invoice_schedule.updateMany({
					where: { id: schedule.id, last_invoiced_at: schedule.last_invoiced_at },
					data: { last_invoiced_at: now, next_invoice_at: nextInvoiceAt },
				});
				if (updateResult.count === 0) {
					throw new Error(`Schedule ${schedule.id} was concurrently modified — skipping`);
				}

				return inv;
			});

			log.info(
				{ plan_id: schedule.recurring_plan_id, org_id: orgId, invoice_id: created.id },
				"Scheduled invoice generated",
			);

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
			log.error(
				{ err, schedule_id: schedule.id, org_id: orgId },
				"Failed to generate scheduled invoice — continuing",
			);
		}
	}
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
