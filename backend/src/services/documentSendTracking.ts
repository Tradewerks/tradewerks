import { getScopedDb } from "../lib/context.js";
import { log } from "./appLogger.js";

/**
 * Records a quote/invoice email in customer_message so Postmark delivery, open
 * and bounce webhooks can find it. The document is already in the customer's
 * inbox by now, so a failure here is logged and never fails the send response.
 */
export async function recordDocumentSend(input: {
	orgId: string;
	event: "quote_sent" | "invoice_sent" | "invoice_resent";
	entityId: string;
	clientId: string | null | undefined;
	recipient: string;
	messageId: string | null;
}): Promise<void> {
	const { orgId, event, entityId, recipient, messageId } = input;
	// Email disabled: nothing was sent, so there is nothing to track.
	if (!messageId) {
		log.info({ event, entityId }, "no provider message id; tracking row skipped");
		return;
	}
	try {
		const sdb = getScopedDb(orgId);
		const contact = await sdb.contact.findFirst({
			where: {
				email: { equals: recipient, mode: "insensitive" },
				...(input.clientId
					? { client_contacts: { some: { client_id: input.clientId } } }
					: {}),
			},
			select: { id: true },
		});
		await sdb.customer_message.create({
			data: {
				organization_id: orgId,
				direction: "out",
				event,
				channel: "email",
				status: "sent",
				sent_at: new Date(),
				recipient,
				entity_type: event === "quote_sent" ? "quote" : "invoice",
				entity_id: entityId,
				client_id: input.clientId ?? null,
				contact_id: contact?.id ?? null,
				dedupe_key: `${event}:${entityId}:${messageId}`,
				provider_message_id: messageId,
			},
		});
	} catch (err) {
		log.error(
			{ err, event, entityId },
			"customer message tracking row failed",
		);
	}
}
