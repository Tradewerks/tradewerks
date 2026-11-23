import type { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { getScopedDb } from "../../lib/context.js";
import { periodStart } from "../../lib/entitlements/quota.js";
import {
	smsRegistrationDraftSchema,
	smsRegistrationSchema,
} from "../../lib/validate/smsAccount.js";
import { getEntitlements } from "../entitlementService.js";
import { renderTemplate } from "../templateRenderer.js";
import { DEFAULT_NOTIFICATION_TEMPLATES } from "../customerComms/templateDefaults.js";
import { log } from "../appLogger.js";
import { SmsRegistrationError } from "./errors.js";
import {
	smsProvider,
	type OrgSmsAccountIds,
	type SmsAccountStatus,
	type SmsCampaignContent,
	type SmsRegistrationForm,
} from "./provider.js";

/** A refusal the route answers with `status` and `code`. */
export class SmsAccountError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
		this.name = "SmsAccountError";
	}
}

export interface SmsAccountView {
	status: SmsAccountStatus;
	phone_number: string | null;
	failure_reason: string | null;
	registration: Record<string, unknown> | null;
	submitted_at: Date | null;
	usage: { used: number; limit: number | null };
}

export const SMS_OPT_IN_DESCRIPTION =
	"Customers give their mobile number and agree to appointment texts when booking service by phone or in person.";

const EDITABLE: SmsAccountStatus[] = ["draft", "failed"];

const ID_KEYS = [
	"subaccount_sid",
	"auth_token_enc",
	"profile_sid",
	"brand_sid",
	"messaging_service_sid",
	"campaign_sid",
	"phone_number",
	"phone_number_sid",
] as const;

type AccountRow = { [K in (typeof ID_KEYS)[number]]: string | null };

/** Provider ids worth logging for manual reconciliation; never the token. */
export function reconcilableIds(
	data: Record<string, unknown>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const k of ID_KEYS)
		if (k !== "auth_token_enc" && typeof data[k] === "string")
			out[k] = data[k] as string;
	return out;
}

export function idsOf(row: AccountRow): OrgSmsAccountIds {
	const ids = {} as OrgSmsAccountIds;
	for (const k of ID_KEYS) ids[k] = row[k];
	return ids;
}

async function smsUsage(orgId: string) {
	const [ent, row] = await Promise.all([
		getEntitlements(orgId),
		db.usage_counter.findFirst({
			where: {
				organization_id: orgId,
				meter: "sms_segments_month",
				period_start: new Date(`${periodStart()}T00:00:00Z`),
			},
			select: { count: true },
		}),
	]);
	return {
		used: row?.count ?? 0,
		limit: ent.limits.sms_segments_month ?? null,
	};
}

export async function getSmsAccount(orgId: string): Promise<SmsAccountView> {
	const [acct, usage] = await Promise.all([
		getScopedDb(orgId).org_sms_account.findFirst({
			where: { organization_id: orgId },
		}),
		smsUsage(orgId),
	]);
	return {
		status: (acct?.status ?? "draft") as SmsAccountStatus,
		phone_number: acct?.phone_number ?? null,
		failure_reason: acct?.failure_reason ?? null,
		registration:
			(acct?.registration as Record<string, unknown> | undefined) ?? null,
		submitted_at: acct?.submitted_at ?? null,
		usage,
	};
}

const FIELD_LABELS: Record<string, string> = {
	legal_name: "Legal business name",
	dba: "Name customers know you by",
	ein: "EIN",
	entity_type: "Business type",
	vertical: "Industry",
	"address.street": "Street",
	"address.street_secondary": "Suite or unit",
	"address.city": "City",
	"address.region": "State or province",
	"address.postal_code": "Postal code",
	"address.iso_country": "Country",
	website: "Website",
	support_email: "Support email",
	support_phone: "Support phone",
	rep_name: "Representative's name",
	rep_title: "Representative's job title",
	rep_email: "Representative's email",
	rep_phone: "Representative's phone",
	sole_prop_mobile: "Owner's mobile number",
	privacy_url: "Privacy policy page",
	terms_url: "Terms page",
	area_code: "Preferred area code",
};

const firstIssue = (issues: { path: PropertyKey[]; message: string }[]) => {
	const i = issues[0];
	const label = FIELD_LABELS[i.path.join(".")];
	return label ? `${label}: ${i.message}` : i.message;
};

async function notEditable(orgId: string) {
	const acct = await getScopedDb(orgId).org_sms_account.findFirst({
		where: { organization_id: orgId },
		select: { status: true },
	});
	const message =
		acct?.status === "active"
			? "Text messaging is already set up."
			: acct?.status === "suspended"
				? "Text messaging is suspended. Contact support to change your registration."
				: "Your registration is in review and can't be changed until the carriers respond.";
	return new SmsAccountError(409, "SMS_REGISTRATION_LOCKED", message);
}

export async function saveRegistrationDraft(
	orgId: string,
	body: unknown,
): Promise<SmsAccountView> {
	const parsed = smsRegistrationDraftSchema.safeParse(body);
	if (!parsed.success)
		throw new SmsAccountError(
			400,
			"VALIDATION_ERROR",
			firstIssue(parsed.error.issues),
		);
	const sdb = getScopedDb(orgId);
	await sdb.org_sms_account.upsert({
		where: { organization_id: orgId },
		create: { organization_id: orgId },
		update: {},
	});
	const saved = await sdb.org_sms_account.updateMany({
		where: { organization_id: orgId, status: { in: EDITABLE } },
		data: { registration: parsed.data as Prisma.InputJsonValue },
	});
	if (saved.count === 0) throw await notEditable(orgId);
	return getSmsAccount(orgId);
}

/** A failed write after the provider created things leaves orphans: log their ids. */
export async function writeAfterProvider<T>(
	orgId: string,
	created: Record<string, unknown>,
	write: () => Promise<T>,
): Promise<T> {
	try {
		return await write();
	} catch (err) {
		log.error(
			{ err, orgId, providerIds: reconcilableIds(created) },
			"SMS registration ids not saved; reconcile with the provider",
		);
		throw err;
	}
}

/** Files the registration; a second call while one is in flight is refused. */
export async function submitRegistration(
	orgId: string,
	body: unknown,
): Promise<SmsAccountView> {
	const parsed = smsRegistrationSchema.safeParse(body);
	if (!parsed.success)
		throw new SmsAccountError(
			400,
			"VALIDATION_ERROR",
			firstIssue(parsed.error.issues),
		);
	const form = parsed.data as SmsRegistrationForm;
	const sdb = getScopedDb(orgId);
	const where = { organization_id: orgId };

	const before = await sdb.org_sms_account.upsert({
		where,
		create: { organization_id: orgId },
		update: {},
	});
	// The status flip is the claim: of two concurrent submits only one matches.
	const claimed = await sdb.org_sms_account.updateMany({
		where: { ...where, status: { in: EDITABLE } },
		data: {
			status: "submitted",
			registration: form as unknown as Prisma.InputJsonValue,
			failure_reason: null,
			submitted_at: new Date(),
		},
	});
	if (claimed.count === 0) throw await notEditable(orgId);

	const existing: Partial<OrgSmsAccountIds> = {};
	for (const [k, v] of Object.entries(idsOf(before)))
		if (v) existing[k as keyof OrgSmsAccountIds] = v;

	let ids: Partial<OrgSmsAccountIds>;
	try {
		ids = await smsProvider.startRegistration(orgId, form, existing);
	} catch (err) {
		if (!(err instanceof SmsRegistrationError)) {
			// Thrown before anything was created at the provider (missing
			// settings), so the org can simply try again.
			await sdb.org_sms_account.update({
				where,
				data: {
					status: before.status,
					submitted_at: before.submitted_at,
				},
			});
			throw err;
		}
		await writeAfterProvider(orgId, err.partial, () =>
			sdb.org_sms_account.update({
				where,
				data: {
					...err.partial,
					status: "failed",
					failure_reason: err.reason,
				},
			}),
		);
		return getSmsAccount(orgId);
	}
	// Outside the rollback above: the ids exist at Twilio and must be kept.
	await writeAfterProvider(orgId, ids, () =>
		sdb.org_sms_account.update({ where, data: ids }),
	);
	return getSmsAccount(orgId);
}

const SAMPLE_EVENTS = [
	"visit_reminder",
	"tech_on_the_way",
	"review_request",
] as const;

/** The 10DLC campaign, generated from the default texts rather than typed by the org. */
export function buildCampaignContent(
	form: SmsRegistrationForm,
): SmsCampaignContent {
	const name = form.dba || form.legal_name;
	// Real texts carry {{link.visit}}; carriers vet the link domain, so the
	// sample shows the real host with a placeholder in place of a token.
	const host = (
		process.env.FRONTEND_URL?.trim() || "https://app.example.com"
	).replace(/\/+$/, "");
	const model = {
		brand: { name, phone: form.support_phone, reply_to: null },
		client_name: "Jordan",
		link: { visit: `${host}/app/c/sample-link` },
		visit: {
			date: "Tuesday, March 3",
			window: "between 9:00 AM and 11:00 AM",
			tech_first_name: "Alex",
			eta: "10:15 AM",
		},
	};
	const samples = SAMPLE_EVENTS.map((e) =>
		renderTemplate(DEFAULT_NOTIFICATION_TEMPLATES[e].sms, model, {
			escape: false,
		}),
	);
	// Carriers reject campaigns whose samples carry no opt-out language.
	samples[0] += " Reply STOP to opt out.";
	return {
		soleProprietor: !form.ein,
		description: `${name} texts its service customers appointment reminders, technician on-the-way updates and a request to review the visit afterwards.`,
		messageFlow: SMS_OPT_IN_DESCRIPTION,
		messageSamples: samples,
		hasEmbeddedLinks: true,
		hasEmbeddedPhone: false,
		privacyPolicyUrl: form.privacy_url,
		termsAndConditionsUrl: form.terms_url,
	};
}
