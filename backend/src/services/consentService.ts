import type { ScopedDb } from "../agent/types.js";
import { getScopedDb } from "../lib/context.js";
import { isSuppressionSource } from "../lib/contactConsent.js";
import { log } from "./appLogger.js";
import { logActivity } from "./logger.js";
import { toE164 } from "./sms/phone.js";

export type Channel = "email" | "sms";
export type ConsentSource =
	| "dispatcher"
	| "unsubscribe_link"
	| "sms_keyword"
	| "bounce"
	| "spam_complaint"
	| "provider";

/** Email is opt-out (sendable unless unsubscribed); SMS is opt-in. */
export async function canSend(
	sdb: ScopedDb,
	contactId: string,
	channel: Channel,
): Promise<boolean> {
	const row = await sdb.contact_consent.findFirst({
		where: { contact_id: contactId, channel },
		select: { status: true },
	});
	if (channel === "email") return row?.status !== "unsubscribed";
	return row?.status === "subscribed";
}

export async function setConsent(
	orgId: string,
	p: {
		contactId: string;
		channel: Channel;
		status: "subscribed" | "unsubscribed";
		source: ConsentSource;
		detail?: string;
		dispatcherId?: string;
	},
): Promise<void> {
	const sdb = getScopedDb(orgId);
	// The DB does not tie consent.organization_id to the contact's org, so
	// ownership is checked here.
	const contact = await sdb.contact.findFirst({
		where: { id: p.contactId },
		select: { id: true, email: true },
	});
	if (!contact) return;

	const existing = await sdb.contact_consent.findFirst({
		where: { contact_id: p.contactId, channel: p.channel },
		select: { status: true },
	});
	if (existing?.status === p.status) return;

	// A deliverability suppression records the address it was written for, so a
	// dispatcher re-subscribe can be refused until the address actually changes.
	const detail =
		p.status === "unsubscribed" &&
		isSuppressionSource(p.source) &&
		contact.email
			? `${p.detail ?? p.source} <${contact.email}>`
			: (p.detail ?? null);

	const now = new Date();
	const data = {
		status: p.status,
		source: p.source,
		source_detail: detail,
		changed_by_dispatcher_id: p.dispatcherId ?? null,
		changed_at: now,
	};
	await sdb.contact_consent.upsert({
		where: {
			contact_id_channel: { contact_id: p.contactId, channel: p.channel },
		},
		create: {
			organization_id: orgId,
			contact_id: p.contactId,
			channel: p.channel,
			...data,
		},
		update: data,
	});

	await logActivity({
		event_type: "contact.consent_changed",
		action: "updated",
		entity_type: "contact",
		entity_id: p.contactId,
		organization_id: orgId,
		actor_type: p.dispatcherId ? "dispatcher" : "system",
		actor_id: p.dispatcherId ?? null,
		reason: p.detail,
		changes: {
			[`${p.channel}_consent`]: {
				old: existing?.status ?? null,
				new: p.status,
			},
			source: { old: null, new: p.source },
		},
	});
}

/** Unsubscribes email for every contact in the org with this address. */
export async function unsubscribeByEmail(
	orgId: string,
	email: string,
	source: ConsentSource,
	detail?: string,
): Promise<number> {
	const trimmed = email.trim();
	if (!trimmed) return 0;
	const sdb = getScopedDb(orgId);
	const contacts = await sdb.contact.findMany({
		where: { email: { equals: trimmed, mode: "insensitive" } },
		select: { id: true },
	});
	let changed = 0;
	for (const c of contacts) {
		const before = await sdb.contact_consent.findFirst({
			where: { contact_id: c.id, channel: "email" },
			select: { status: true },
		});
		if (before?.status === "unsubscribed") continue;
		try {
			await setConsent(orgId, {
				contactId: c.id,
				channel: "email",
				status: "unsubscribed",
				source,
				detail,
			});
			changed++;
		} catch (err) {
			log.error(
				{ err, contactId: c.id },
				"unsubscribeByEmail failed for contact",
			);
		}
	}
	return changed;
}

/**
 * Contacts in the org whose phone normalizes to this number. contact.phone is
 * free text ("(512) 555-0100", "512.555.0100 ext 4"), so the match is made in
 * code rather than in the query.
 */
export async function findContactsByPhone(
	orgId: string,
	e164: string,
): Promise<string[]> {
	const contacts = await getScopedDb(orgId).contact.findMany({
		where: { phone: { not: null } },
		select: { id: true, phone: true },
	});
	return contacts
		.filter((c) => c.phone && toE164(c.phone, "US") === e164)
		.map((c) => c.id);
}

/** Sets SMS consent for every contact in the org with this number; returns their ids. */
export async function setSmsConsentByPhone(
	orgId: string,
	e164: string,
	status: "subscribed" | "unsubscribed",
	source: ConsentSource,
	detail?: string,
): Promise<string[]> {
	const ids = await findContactsByPhone(orgId, e164);
	// One contact failing must not leave the others still textable; the
	// first error is rethrown once every contact has been tried.
	let failure: unknown;
	for (const contactId of ids) {
		try {
			await setConsent(orgId, {
				contactId,
				channel: "sms",
				status,
				source,
				detail,
			});
		} catch (err) {
			log.error({ err, contactId }, "setSmsConsentByPhone failed for contact");
			failure ??= err;
		}
	}
	if (failure) throw failure;
	return ids;
}
