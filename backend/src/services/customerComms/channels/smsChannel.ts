import { getScopedDb } from "../../../lib/context.js";
import { log } from "../../appLogger.js";
import { setSmsConsentByPhone } from "../../consentService.js";
import { maskPhone, twilioWebhookUrl } from "../../sms/inbound.js";
import { smsProvider } from "../../sms/provider.js";
import { SendRejected, type ChannelAdapter } from "./types.js";

type ScopedDb = ReturnType<typeof getScopedDb>;

export const STOP_LINE = " Reply STOP to opt out.";

/**
 * Appends the opt-out line to the first text this org sends to the number.
 * Only a text known to have gone out counts: repeating the line after an
 * uncertain send costs a few characters, missing it is a compliance gap.
 */
export async function withStopLine(
	sdb: ScopedDb,
	e164: string,
	text: string,
): Promise<string> {
	const earlier = await sdb.customer_message.findFirst({
		where: {
			direction: "out",
			channel: "sms",
			recipient: e164,
			status: { in: ["sent", "delivered"] },
		},
		select: { id: true },
	});
	return earlier ? text : `${text}${STOP_LINE}`;
}

/**
 * What a send needs besides the body. Throws SendRejected: non-retryable when
 * the org or deployment cannot send at all, retryable when the read failed.
 * The sweeper runs it before charging the meter so such rows are never billed.
 */
export async function smsSendContext(orgId: string, rowId: string) {
	let acct;
	try {
		acct = await getScopedDb(orgId).org_sms_account.findFirst({
			where: { organization_id: orgId },
			select: {
				status: true,
				subaccount_sid: true,
				auth_token_enc: true,
				messaging_service_sid: true,
			},
		});
	} catch (err) {
		throw new SendRejected(
			err instanceof Error ? err.message : String(err),
			true,
		);
	}
	if (
		acct?.status !== "active" ||
		!acct.subaccount_sid ||
		!acct.auth_token_enc ||
		!acct.messaging_service_sid
	)
		throw new SendRejected("sms_not_active", false);
	// The row id lets a delivery report that beats our "sent" write (which
	// stores the sid) still find its row.
	const statusCallbackUrl = twilioWebhookUrl(
		`/integrations/twilio/status?m=${encodeURIComponent(rowId)}`,
	);
	if (!statusCallbackUrl)
		throw new SendRejected("BACKEND_PUBLIC_URL is not set", false);
	return {
		creds: {
			subaccount_sid: acct.subaccount_sid,
			auth_token_enc: acct.auth_token_enc,
			messaging_service_sid: acct.messaging_service_sid,
		},
		statusCallbackUrl,
	};
}

/** `msg.to` is E.164: the sweeper skips any row whose number does not parse. */
export const smsChannel: ChannelAdapter = {
	channel: "sms",
	async send(msg) {
		const to = msg.to;
		const { creds, statusCallbackUrl } = await smsSendContext(
			msg.orgId,
			msg.messageRowId,
		);
		try {
			const r = await smsProvider.send(creds, {
				to,
				body: msg.text,
				statusCallbackUrl,
			});
			return {
				providerMessageId: r.providerMessageId,
				segments: r.segments,
			};
		} catch (err) {
			if (
				err instanceof SendRejected &&
				err.message === "recipient_opted_out"
			) {
				// Twilio's block list is the truth; consent here has to agree
				// or every later event will be refused the same way.
				try {
					await setSmsConsentByPhone(
						msg.orgId,
						to,
						"unsubscribed",
						"provider",
						"Twilio reported the number as opted out",
					);
				} catch (e) {
					log.error(
						{ err: e, orgId: msg.orgId, to: maskPhone(to) },
						"Recording a provider opt-out failed",
					);
				}
			}
			throw err;
		}
	},
};
