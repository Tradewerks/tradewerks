import type { Prisma } from "../../../generated/prisma/client.js";
import { getScopedDb } from "../../lib/context.js";
import { isModuleOn } from "../entitlementService.js";
import { buildRecurringPlanInvoicePayload } from "../invoiceGenerator.js";
import { createInvoiceRecord } from "../invoiceService.js";
import { logActivity } from "../logger.js";
import { log } from "../appLogger.js";
import { planBills, type PlanStatus } from "../../lib/recurringPlanState.js";
import { getSocket } from "../socketService.js";
import { recordChangedFromLog } from "../recordChanged.js";
import { redactFeedRow } from "../../controllers/logsController.js";

class AlreadyBilled extends Error {}
class ScheduleMoved extends Error {}
class PlanNotBilling extends Error {}

/** The first try plus this many: enough for a burst of same-plan completions. */
const CAS_RETRIES = 2;

/**
 * Bills a plan visit whose schedule is `on_visit_completion`. Runs post-commit
 * and never rejects; a failure is logged against the visit.
 */
export async function maybeAutoInvoiceOnCompletion(
	orgId: string,
	visitId: string,
	planId: string,
): Promise<void> {
	try {
		if (!(await isModuleOn(orgId, "recurring_plans"))) return;
		for (let attempt = 0; ; attempt++) {
			try {
				await billOnce(orgId, visitId, planId);
				return;
			} catch (err) {
				// Another visit of the plan billed between our read and our
				// write; this visit still owes its invoice, so build it again
				// on the fresh schedule.
				if (err instanceof ScheduleMoved && attempt < CAS_RETRIES)
					continue;
				throw err;
			}
		}
	} catch (err) {
		if (err instanceof AlreadyBilled || err instanceof PlanNotBilling) return;
		log.error(
			{ err, plan_id: planId },
			"on_visit_completion invoice creation failed",
		);
		await logActivity({
			event_type: "invoice.auto_creation_failed",
			action: "failed",
			entity_type: "job_visit",
			entity_id: visitId,
			organization_id: orgId,
			actor_type: "system",
			actor_id: null,
			changes: {
				error: { old: null, new: String(err) },
				recurring_plan_id: { old: null, new: planId },
			},
		}).catch(() => {});
	}
}

async function billOnce(
	orgId: string,
	visitId: string,
	planId: string,
): Promise<void> {
	const sdb = getScopedDb(orgId);
	const schedule = await sdb.invoice_schedule.findFirst({
		where: { recurring_plan_id: planId },
		include: { recurring_plan: { select: { status: true, timezone: true } } },
	});
	if (
		schedule?.frequency !== "on_visit_completion" ||
		!schedule.is_active ||
		!planBills(schedule.recurring_plan.status as PlanStatus)
	)
		return;

	// fixed_amount and plan_line_items invoices carry no invoice_visit row,
	// so a reopened and re-completed visit is only recognisable by the
	// marker its first invoice's log left behind.
	const findMarker = (
		client: Pick<Prisma.TransactionClient, "log">,
	): Promise<{ id: string } | null> =>
		client.log.findFirst({
			where: {
				organization_id: orgId,
				event_type: "invoice.created",
				changes: {
					path: ["source_visit_id", "new"],
					equals: visitId,
				},
			},
			select: { id: true },
		});
	if (await findMarker(sdb as unknown as Prisma.TransactionClient))
		return;

	const { payload, warnings, empty } = await buildRecurringPlanInvoicePayload(
		planId,
		sdb,
		{ last_invoiced_at: schedule.last_invoiced_at },
	);
	if (empty) return;
	if (warnings.length > 0) {
		payload.internal_notes = `[Auto on completion] Overlap:\n${warnings
			.map(
				(w) =>
					`Visit ${new Date(w.scheduled_start_at).toLocaleDateString("en-US", {
						timeZone: schedule.recurring_plan.timezone,
					})} already billed on: ${w.existing_invoices.map((i) => i.invoice_number).join(", ")}`,
			)
			.join("\n")}`;
	}
	const row = await sdb.$transaction(async (innerTx) => {
		const tx = innerTx as unknown as Prisma.TransactionClient;
		// The schedule read above is unlocked; a pause or cancel since then
		// holds the plan row, so its status is re-read under it (plan before
		// schedule, as every plan writer locks).
		const [locked] = await tx.$queryRaw<{ status: PlanStatus }[]>`
			SELECT status::text AS status FROM recurring_plan
			WHERE id = ${planId} FOR SHARE`;
		if (!locked || !planBills(locked.status)) throw new PlanNotBilling();
		const inv = await createInvoiceRecord(payload, orgId, null, tx);
		const cas = await tx.invoice_schedule.updateMany({
			where: {
				id: schedule.id,
				last_invoiced_at: schedule.last_invoiced_at,
				is_active: true,
			},
			data: { last_invoiced_at: new Date() },
		});
		if (cas.count === 0) {
			throw new ScheduleMoved(
				`on_visit_completion: schedule ${schedule.id} already updated by concurrent completion`,
			);
		}
		// Re-checked under the schedule row lock, and the marker commits with
		// the invoice: a second run can't slip in before the marker exists.
		if (await findMarker(tx)) throw new AlreadyBilled();
		const changes = {
			invoice_number: { old: null, new: inv.invoice_number },
			client_id: { old: null, new: inv.client_id },
			total: { old: null, new: inv.total },
			status: { old: null, new: inv.status },
			recurring_plan_id: {
				old: null,
				new: inv.recurring_plan_id ?? null,
			},
			source_visit_id: { old: null, new: visitId },
		};
		return tx.log.create({
			data: {
				event_type: "invoice.created",
				action: "created",
				entity_type: "invoice",
				entity_id: inv.id,
				organization_id: orgId,
				actor_type: "system",
				actor_id: null,
				changes: JSON.parse(JSON.stringify(changes)),
				timestamp: new Date(),
			},
		});
	});
	// The row was written in-tx, so logActivity's live hints are sent by hand.
	try {
		getSocket()
			.to(`org:${orgId}`)
			.emit("activity-event", redactFeedRow(row));
	} catch {
		// socket not initialised
	}
	try {
		recordChangedFromLog(row);
	} catch {
		// a live-refresh hint never fails a committed invoice
	}
}
