import { getOrgBrand } from "../../emailBranding.js";
import { sendRenderedTracked } from "../../emailService.js";
import { SendRejected, type ChannelAdapter } from "./types.js";

// Postmark API error codes for the recipient's own state (300 invalid address,
// 406 inactive after a bounce or complaint): retrying cannot help.
const RECIPIENT_CODES = new Set([300, 406]);

/**
 * Restates a Postmark failure. A response with a status means Postmark answered
 * and did not take the message. No status (socket hangup, timeout) or a 500 means
 * it may have been accepted, so the error is rethrown as-is (outcome unknown).
 */
function classify(err: unknown): unknown {
	const e = err as { statusCode?: unknown; code?: unknown; message?: string };
	const status = typeof e?.statusCode === "number" ? e.statusCode : 0;
	if (status === 0 || (status >= 500 && status !== 503)) return err;
	const code = typeof e.code === "number" ? e.code : null;
	const retryable = !(code !== null && RECIPIENT_CODES.has(code));
	return new SendRejected(e.message ?? `Postmark ${status}`, retryable);
}

export const emailChannel: ChannelAdapter = {
	channel: "email",
	async send(msg) {
		let brand: Awaited<ReturnType<typeof getOrgBrand>>;
		try {
			brand = await getOrgBrand(msg.orgId);
		} catch (err) {
			// Nothing has reached the provider yet.
			throw new SendRejected(
				err instanceof Error ? err.message : String(err),
				true,
			);
		}

		try {
			const { messageId } = await sendRenderedTracked(
				msg.to,
				msg.subject ?? "",
				msg.html ?? "",
				msg.text,
				{
					metadata: {
						customer_message_id: msg.messageRowId,
						organization_id: msg.orgId,
					},
					fromName: brand.name,
					replyTo: brand.reply_to,
					...(msg.headers?.length ? { headers: msg.headers } : {}),
				},
			);
			return { providerMessageId: messageId };
		} catch (err) {
			throw classify(err);
		}
	},
};
