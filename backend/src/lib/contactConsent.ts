// Prisma `select` for the consent rows a contact payload needs.
export const CONSENT_SELECT = {
	select: {
		channel: true,
		status: true,
		source: true,
		source_detail: true,
		changed_at: true,
	},
} as const;

type ConsentRow = {
	channel: string;
	status: string;
	source: string;
	source_detail: string | null;
	changed_at: Date;
};

export interface ContactConsentView {
	email: "subscribed" | "unsubscribed";
	sms: "subscribed" | "unsubscribed";
	sms_changed_at: string | null;
	email_source: string | null;
	/** Suppressed (bounce etc.) and the address has since changed. */
	email_resubscribable: boolean;
	sms_source: string | null;
}

/** Email defaults to subscribed (opt-out); SMS to unsubscribed (opt-in). */
export function toConsentView(
	rows: ConsentRow[] | undefined,
	currentEmail?: string | null,
): ContactConsentView {
	const email = rows?.find((r) => r.channel === "email");
	const sms = rows?.find((r) => r.channel === "sms");
	return {
		email: email?.status === "unsubscribed" ? "unsubscribed" : "subscribed",
		sms: sms?.status === "subscribed" ? "subscribed" : "unsubscribed",
		sms_changed_at: sms ? sms.changed_at.toISOString() : null,
		email_source: email?.status === "unsubscribed" ? email.source : null,
		email_resubscribable: !!email && isEmailResubscribable(email, currentEmail),
		sms_source: sms?.status === "unsubscribed" ? sms.source : null,
	};
}

/** Replaces the raw `consents` rows on a contact with the `consent` view. */
export function withConsent<
	T extends { consents?: ConsentRow[]; email?: string | null },
>(
	contact: T,
): Omit<T, "consents"> & { consent: ContactConsentView } {
	const { consents, ...rest } = contact;
	return { ...rest, consent: toConsentView(consents, rest.email) };
}

/** Same, for a client-contact link whose `contact` carries the rows. */
export function linkWithConsent<
	L extends { contact: { consents?: ConsentRow[] } },
>(link: L) {
	return { ...link, contact: withConsent(link.contact) };
}

/** Same, for a client payload whose `contacts` are links. */
export function clientWithConsent<
	C extends { contacts: { contact: { consents?: ConsentRow[] } }[] },
>(client: C) {
	return {
		...client,
		contacts: client.contacts?.map(linkWithConsent) as ReturnType<
			typeof linkWithConsent
		>[],
	};
}

const SUPPRESSION_SOURCES = new Set(["bounce", "spam_complaint", "provider"]);
export const isSuppressionSource = (source: string | null | undefined) =>
	!!source && SUPPRESSION_SOURCES.has(source);

/** The address recorded by setConsent when a suppression was written. */
export function suppressedAddress(detail: string | null | undefined) {
	return detail?.match(/<([^<>]+)>$/)?.[1] ?? null;
}

/**
 * A suppression (bounce, spam complaint, provider) can be lifted by a dispatcher
 * once the address differs from the one suppressed. A row with no recorded
 * address has nothing to compare against, so it is liftable.
 */
export function isEmailResubscribable(
	row: { status: string; source: string; source_detail: string | null },
	currentEmail: string | null | undefined,
): boolean {
	if (row.status !== "unsubscribed" || !isSuppressionSource(row.source))
		return false;
	const dead = suppressedAddress(row.source_detail);
	if (!dead) return true;
	return currentEmail?.trim().toLowerCase() !== dead.trim().toLowerCase();
}

/** Opt-outs the customer made themselves; only the customer can undo them. */
export const CUSTOMER_EMAIL_OPT_OUT = new Set(["unsubscribe_link"]);
export const CUSTOMER_SMS_OPT_OUT = new Set(["sms_keyword", "unsubscribe_link"]);
