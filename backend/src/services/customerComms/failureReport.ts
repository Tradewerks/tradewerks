import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { getScopedDb } from "../../lib/context.js";
import { log } from "../appLogger.js";
import { logActivity } from "../logger.js";

export interface MessageOutcome {
	id: string;
	organization_id: string;
	event: string;
	channel: string;
	recipient: string;
	entity_type: string;
	entity_id: string;
}

type ScopedDb = ReturnType<typeof getScopedDb>;

async function entityUrl(
	sdb: ScopedDb,
	type: string,
	id: string,
): Promise<string | undefined> {
	if (type === "job_visit") {
		const v = await sdb.job_visit.findFirst({
			where: { id },
			select: { job_id: true },
		});
		return v ? `/dispatch/jobs/${v.job_id}/visits/${id}` : undefined;
	}
	if (type === "job") return `/dispatch/jobs/${id}`;
	if (type === "quote") return `/dispatch/quotes/${id}`;
	if (type === "invoice") return `/dispatch/invoices/${id}`;
	if (type === "client") return `/dispatch/clients/${id}`;
	return undefined;
}

const label = (event: string) => event.replace(/_/g, " ");

/**
 * Activity-log entry for a customer message outcome, plus a dispatcher
 * notification unless it was a plain send. The two steps are guarded
 * separately so a failed log write never swallows the notification.
 */
export async function reportMessageOutcome(
	row: MessageOutcome,
	status: "sent" | "failed" | "unknown",
	opts: { error?: string; failedBody?: string } = {},
): Promise<void> {
	const orgId = row.organization_id;
	const what = `${label(row.event)} ${row.channel} to ${row.recipient}`;
	const { error } = opts;
	try {
		await logActivity({
			event_type: `customer_message.${status}`,
			action: status,
			entity_type: row.entity_type,
			entity_id: row.entity_id,
			organization_id: orgId,
			actor_type: "system",
			reason: error ? `${what}: ${error}` : what,
		});
	} catch (err) {
		log.error(
			{ err, messageId: row.id, status },
			"customer message activity log failed",
		);
	}
	if (status === "sent") return;
	try {
		await notifyDispatchers(
			{
				type: "customer_message_failed",
				title:
					status === "failed"
						? "Customer message failed"
						: "Customer message may not have arrived",
				body:
					status === "failed"
						? (opts.failedBody ?? `The ${what} could not be sent.`)
						: `The ${what} was interrupted and will not be retried.`,
				actionUrl: await entityUrl(
					getScopedDb(orgId),
					row.entity_type,
					row.entity_id,
				),
			},
			orgId,
		);
	} catch (err) {
		log.error(
			{ err, messageId: row.id, status },
			"customer message notification failed",
		);
	}
}
