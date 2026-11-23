import { db } from "../../db.js";
import { getScopedDb } from "../../lib/context.js";
import { log } from "../appLogger.js";
import { canSend } from "../consentService.js";
import { isModuleOn } from "../entitlementService.js";
import { toE164 } from "../sms/phone.js";
import { registeredChannels } from "./channels/index.js";
import { smsUnavailableReason } from "../sms/smsAvailability.js";
import type { Channel } from "./channels/types.js";
import { QUIET_HOURS_EXEMPT, type CustomerEvent } from "./events.js";
import { holdForQuietHours } from "./quietHours.js";

type ScopedDb = ReturnType<typeof getScopedDb>;

interface Recipient {
	id: string;
	email: string | null;
	phone: string | null;
}

/**
 * Contacts flagged notify_visits; if none, the primary contact. Inactive and
 * vendor contacts are never eligible.
 */
async function visitRecipients(
	sdb: ScopedDb,
	clientId: string,
): Promise<Recipient[]> {
	const links = await sdb.client_contact.findMany({
		where: { client_id: clientId },
		select: {
			is_primary: true,
			notify_visits: true,
			contact: {
				select: {
					id: true,
					email: true,
					phone: true,
					is_active: true,
					type: true,
				},
			},
		},
	});
	const eligible = links.filter(
		(l) => l.contact.is_active && l.contact.type !== "vendor",
	);
	const flagged = eligible.filter((l) => l.notify_visits);
	const chosen = flagged.length
		? flagged
		: eligible.filter((l) => l.is_primary).slice(0, 1);
	return chosen.map((l) => ({
		id: l.contact.id,
		email: l.contact.email,
		phone: l.contact.phone,
	}));
}

// SMS rows carry the E.164 form so the first-text check and STOP matching can
// compare numbers; an unparseable one is kept as typed and skipped at send.
function addressFor(r: Recipient, channel: Channel): string {
	const raw = ((channel === "email" ? r.email : r.phone) ?? "").trim();
	return channel === "sms" && raw ? (toE164(raw, "US") ?? raw) : raw;
}

/** Queues one outbox row per enabled channel and eligible recipient. Never throws. */
export async function customerNotify(
	orgId: string,
	p: {
		event: CustomerEvent;
		entityType: "job_visit" | "job";
		entityId: string;
		clientId: string;
		dedupeKey: string;
		sendAt?: Date;
		quietMode?: "defer" | "advance";
		/** A row that would send at or after this is not queued (a visit's start). */
		notAfter?: Date;
	},
): Promise<{ queued: number }> {
	try {
		if (!(await isModuleOn(orgId, "customer_comms"))) return { queued: 0 };
		const sdb = getScopedDb(orgId);
		const setting = await sdb.customer_notification_setting.findFirst({
			where: { event: p.event },
			select: { email_enabled: true, sms_enabled: true },
		});
		let channels = registeredChannels().filter((c) =>
			c === "email" ? setting?.email_enabled : setting?.sms_enabled,
		);
		if (channels.includes("sms") && (await smsUnavailableReason(orgId)))
			channels = channels.filter((c) => c !== "sms");
		if (!channels.length) return { queued: 0 };

		const recipients = await visitRecipients(sdb, p.clientId);
		const sendAt = p.sendAt ?? new Date();
		let smsSendAt = sendAt;
		if (channels.includes("sms") && !QUIET_HOURS_EXEMPT.includes(p.event)) {
			const org = await db.organization.findUnique({
				where: { id: orgId },
				select: { timezone: true },
			});
			const tz = org?.timezone ?? "America/Chicago";
			smsSendAt = holdForQuietHours(sendAt, tz, p.quietMode ?? "defer");
			// An advance that lands in the past would send right now, inside
			// quiet hours; late beats a text in the middle of the night.
			const now = new Date();
			if (smsSendAt <= now && sendAt > now)
				smsSendAt = holdForQuietHours(now, tz, "defer");
		}

		const rows = [];
		for (const r of recipients) {
			for (const channel of channels) {
				const recipient = addressFor(r, channel);
				if (!recipient) continue;
				const sendAfter = channel === "sms" ? smsSendAt : sendAt;
				if (p.notAfter && sendAfter >= p.notAfter) continue;
				// Checked again at send time; this keeps an opted-out contact's
				// rows out of the log entirely.
				if (!(await canSend(sdb, r.id, channel))) continue;
				rows.push({
					organization_id: orgId,
					event: p.event,
					channel,
					client_id: p.clientId,
					contact_id: r.id,
					recipient,
					entity_type: p.entityType,
					entity_id: p.entityId,
					dedupe_key: p.dedupeKey,
					send_after: sendAfter,
				});
			}
		}
		if (!rows.length) return { queued: 0 };
		const { count } = await sdb.customer_message.createMany({
			data: rows,
			skipDuplicates: true,
		});
		return { queued: count };
	} catch (err) {
		log.error(
			{ err, orgId, event: p.event, entityId: p.entityId },
			"customerNotify failed; nothing queued",
		);
		return { queued: 0 };
	}
}

/** Skips still-queued rows for an entity. Never throws. */
export async function cancelQueued(
	orgId: string,
	p: {
		entityType: string;
		entityId: string;
		events: CustomerEvent[];
		reason: string;
	},
): Promise<number> {
	try {
		const { count } = await getScopedDb(orgId).customer_message.updateMany({
			where: {
				entity_type: p.entityType,
				entity_id: p.entityId,
				event: { in: p.events },
				status: "queued",
			},
			data: { status: "skipped", skip_reason: p.reason },
		});
		return count;
	} catch (err) {
		log.error(
			{ err, orgId, entityId: p.entityId },
			"cancelQueued failed; the sweeper's validity check still applies",
		);
		return 0;
	}
}
