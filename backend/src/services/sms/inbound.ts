import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { getScopedDb } from "../../lib/context.js";
import { log } from "../appLogger.js";
import {
	findContactsByPhone,
	setSmsConsentByPhone,
} from "../consentService.js";
import { reportMessageOutcome } from "../customerComms/failureReport.js";
import { toE164 } from "./phone.js";

export type SmsKeyword = "stop" | "start" | "help";

// Twilio's default opt-out, opt-in and help words (CTIA list incl. REVOKE/OPTOUT).
const KEYWORDS: Record<string, SmsKeyword> = {
	STOP: "stop",
	STOPALL: "stop",
	UNSUBSCRIBE: "stop",
	CANCEL: "stop",
	END: "stop",
	QUIT: "stop",
	REVOKE: "stop",
	OPTOUT: "stop",
	START: "start",
	YES: "start",
	UNSTOP: "start",
	HELP: "help",
	INFO: "help",
};

/** Only a message that is exactly a keyword counts: "Stop by at 3?" is a reply. */
export function classifyKeyword(body: string): SmsKeyword | null {
	return KEYWORDS[body.trim().toUpperCase()] ?? null;
}

export type TwilioParams = Record<string, string | string[] | undefined>;

const str = (v: TwilioParams[string]) => (typeof v === "string" ? v : "");

/** For logs: keeps the last four digits only. */
export function maskPhone(n: string): string {
	return n.length > 4 ? `${"*".repeat(n.length - 4)}${n.slice(-4)}` : "****";
}

/**
 * The URL Twilio signs is the one it was given, which registration builds from
 * BACKEND_PUBLIC_URL. Behind a proxy req.protocol/host can differ, so the same
 * base is used to rebuild it. Null when the base is not configured.
 */
export function twilioWebhookUrl(pathAndQuery: string): string | null {
	const base = process.env.BACKEND_PUBLIC_URL?.replace(/\/+$/, "");
	return base ? `${base}${pathAndQuery}` : null;
}

/**
 * With Advanced Opt-Out on, Twilio reports which keyword it acted on. When it
 * has blocked the number, consent here has to say the same.
 */
function twilioOptOutType(v: TwilioParams[string]): SmsKeyword | null {
	const t = str(v).toLowerCase();
	return t === "stop" || t === "start" || t === "help" ? t : null;
}

type ScopedDb = ReturnType<typeof getScopedDb>;

/** Queued texts to this number, or to the contacts who own it, never go out. */
async function skipQueuedSms(
	sdb: ScopedDb,
	e164: string,
	contactIds: string[],
): Promise<number> {
	const queued = await sdb.customer_message.findMany({
		where: { direction: "out", channel: "sms", status: "queued" },
		select: { id: true, contact_id: true, recipient: true },
	});
	// Rows store the contact's phone as typed, so compare normalized.
	const ids = queued
		.filter(
			(m) =>
				(m.contact_id && contactIds.includes(m.contact_id)) ||
				toE164(m.recipient, "US") === e164,
		)
		.map((m) => m.id);
	if (!ids.length) return 0;
	const { count } = await sdb.customer_message.updateMany({
		where: { id: { in: ids }, status: "queued" },
		data: { status: "skipped", skip_reason: "unsubscribed" },
	});
	return count;
}

const preview = (body: string, numMedia: number) => {
	const text = body.trim();
	if (!text) return numMedia > 0 ? "Sent an attachment" : "(empty message)";
	return text.length > 140 ? `${text.slice(0, 139)}…` : text;
};

function formatPhone(e164: string): string {
	const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
	return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/**
 * A text from a customer to the org's number. STOP/START change consent for
 * every contact with that number. Everything but HELP is shown to the
 * office. Every message is kept as an inbound row, once per MessageSid.
 * Twilio answers the keywords itself, so nothing is sent back from here.
 */
export async function handleInboundSms(
	orgId: string,
	params: TwilioParams,
): Promise<void> {
	const sid = str(params.MessageSid) || str(params.SmsSid);
	const from = str(params.From);
	if (!sid || !from) {
		log.warn({ orgId, sid }, "Inbound SMS without MessageSid or From");
		return;
	}
	const e164 = toE164(from, "US") ?? from;
	const body = str(params.Body);
	const keyword =
		twilioOptOutType(params.OptOutType) ?? classifyKeyword(body);
	const sdb = getScopedDb(orgId);

	// Consent is applied before the dedupe insert on purpose: a replayed
	// STOP/START is idempotent, while the reverse order would let a failure
	// between the insert and the consent write turn every retry into a
	// "duplicate" and lose the opt-out.
	let contactIds: string[];
	if (keyword === "stop" || keyword === "start") {
		const status = keyword === "stop" ? "unsubscribed" : "subscribed";
		contactIds = await setSmsConsentByPhone(
			orgId,
			e164,
			status,
			"sms_keyword",
			`Texted ${keyword.toUpperCase()}`,
		);
		if (keyword === "stop") await skipQueuedSms(sdb, e164, contactIds);
	} else {
		contactIds = await findContactsByPhone(orgId, e164);
	}

	const links = contactIds.length
		? await sdb.client_contact.findMany({
				where: { contact_id: { in: contactIds } },
				select: {
					client_id: true,
					contact_id: true,
					is_primary: true,
					client: { select: { name: true } },
				},
			})
		: [];
	const link =
		links.find((l) => l.is_primary) ?? (links.length ? links[0] : null);

	const now = new Date();
	const segments = Number.parseInt(str(params.NumSegments), 10);
	const { count } = await sdb.customer_message.createMany({
		data: [
			{
				organization_id: orgId,
				direction: "in",
				event: "inbound_sms",
				channel: "sms",
				client_id: link?.client_id ?? null,
				contact_id: link?.contact_id ?? contactIds[0] ?? null,
				recipient: e164,
				// An unknown number has no client to hang the message on.
				entity_type: link ? "client" : "phone",
				entity_id: link?.client_id ?? e164,
				dedupe_key: `inbound:${sid}`,
				status: "delivered",
				provider_message_id: sid,
				body,
				segments: Number.isFinite(segments) ? segments : null,
				sent_at: now,
				delivered_at: now,
			},
		],
		skipDuplicates: true,
	});

	log.info(
		{
			orgId,
			sid,
			from: maskPhone(e164),
			keyword,
			contacts: contactIds.length,
			duplicate: count === 0,
		},
		"Inbound SMS",
	);
	if (count === 0 || keyword === "help") return;

	const who = link?.client.name ?? formatPhone(e164);
	// The word they actually sent ("CANCEL" may have meant the visit).
	const word = classifyKeyword(body)
		? body.trim().toUpperCase()
		: keyword?.toUpperCase();
	const copy =
		keyword === "stop"
			? {
					title: `${who} texted ${word}`,
					body: "Texts to this number are now stopped. If they meant the visit, call them.",
				}
			: keyword === "start"
				? {
						title: `${who} texted ${word}`,
						body: "Texts to this number are back on.",
					}
				: {
						title: `Text from ${who}`,
						body: preview(body, Number(str(params.NumMedia)) || 0),
					};
	try {
		await notifyDispatchers(
			{
				type: "customer_sms_reply",
				...copy,
				actionUrl: link
					? `/dispatch/clients/${link.client_id}`
					: undefined,
			},
			orgId,
		);
	} catch (err) {
		log.error({ err, orgId, sid }, "Inbound SMS notification failed");
	}
}

// "sending" is a row whose report beat the outbox's "sent" write; the outbox
// then leaves the status alone (its write is guarded on "sending").
const AWAITING_OUTCOME = ["sending", "sent", "unknown"];

const OUTCOME_ROW = {
	id: true,
	organization_id: true,
	event: true,
	channel: true,
	recipient: true,
	entity_type: true,
	entity_id: true,
} as const;

/**
 * Twilio's delivery report for one of our texts; other statuses are ignored.
 * `rowId` is the `m` query parameter the outbox put in the callback URL (signed
 * with it), used when the sid is not stored on the row yet.
 */
export async function handleStatusCallback(
	orgId: string,
	params: TwilioParams,
	rowId?: string,
): Promise<void> {
	const sid = str(params.MessageSid) || str(params.SmsSid);
	const status = str(params.MessageStatus) || str(params.SmsStatus);
	if (!sid) return;
	const sdb = getScopedDb(orgId);
	const row =
		(await sdb.customer_message.findFirst({
			where: { provider_message_id: sid, direction: "out" },
			select: OUTCOME_ROW,
		})) ??
		(rowId
			? await sdb.customer_message.findFirst({
					where: {
						id: rowId,
						direction: "out",
						channel: "sms",
						provider_message_id: null,
					},
					select: OUTCOME_ROW,
				})
			: null);
	if (!row) return;

	// A row is sent to the provider at most once, so the sid in a report for
	// this row's callback URL is this row's.
	if (status === "delivered") {
		await sdb.customer_message.updateMany({
			where: { id: row.id, status: { in: AWAITING_OUTCOME } },
			data: {
				status: "delivered",
				delivered_at: new Date(),
				provider_message_id: sid,
			},
		});
		return;
	}
	if (status !== "undelivered" && status !== "failed") return;

	const code = str(params.ErrorCode);
	const error = `twilio ${code || status}`;
	const { count } = await sdb.customer_message.updateMany({
		where: { id: row.id, status: { in: AWAITING_OUTCOME } },
		data: { status: "failed", error, provider_message_id: sid },
	});
	log.info(
		{
			orgId,
			sid,
			status,
			errorCode: code || null,
			to: maskPhone(row.recipient),
		},
		"SMS delivery failed",
	);
	if (count === 0) return; // repeated callback: already reported
	await reportMessageOutcome(row, "failed", {
		error,
		failedBody: `The ${row.event.replace(/_/g, " ")} text to ${row.recipient} was not delivered${code ? ` (Twilio error ${code})` : ""}.`,
	});
}
