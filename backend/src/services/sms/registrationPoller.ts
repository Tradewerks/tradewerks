import type { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { getScopedDb } from "../../lib/context.js";
import { notifyDispatchers } from "../../controllers/notificationsController.js";
import { log } from "../appLogger.js";
import { SmsRegistrationError } from "./errors.js";
import {
	smsProvider,
	type SmsAccountStatus,
	type SmsRegistrationForm,
	type SmsRegistrationStep,
} from "./provider.js";
import {
	buildCampaignContent,
	idsOf,
	writeAfterProvider,
} from "./registrationService.js";

const INTERVAL_MS = 15 * 60_000;
// Shorter than the interval so timer drift never skips a tick, longer than a
// poll takes so two instances never poll (and buy a number for) the same org.
const CLAIM_MS = 10 * 60_000;
// A submit that never got as far as filing the brand (the request died).
const ABANDONED_MS = 30 * 60_000;
const POLLED: SmsAccountStatus[] = [
	"submitted",
	"brand_pending",
	"campaign_pending",
];
// A carrier can suspend a brand after approval; nothing else would notice.
const ACTIVE_RECHECK_MS = 24 * 3_600_000;
const SETTINGS_URL = "/dispatch/admin?tab=customer_messages";

const dueWhere = (now: Date) => ({
	OR: [
		{
			status: { in: POLLED },
			OR: [
				{ last_polled_at: null },
				{ last_polled_at: { lt: new Date(now.getTime() - CLAIM_MS) } },
			],
		},
		{
			status: "active",
			OR: [
				{ last_polled_at: null },
				{
					last_polled_at: {
						lt: new Date(now.getTime() - ACTIVE_RECHECK_MS),
					},
				},
			],
		},
	],
});

const sentence = (s: string) => s.trim().replace(/[.!?]*$/, ".");

async function notify(
	orgId: string,
	status: SmsAccountStatus,
	phone: string | null,
	reason: string | null,
) {
	const copy =
		status === "active"
			? {
					title: "Text messaging is ready",
					body: `Customers can now get texts from ${phone}. Turn texts on for each message under Customer messages.`,
				}
			: status === "failed"
				? {
						title: "Text messaging setup needs changes",
						body: `${sentence(reason ?? "No reason was given")} Edit your details under Customer messages and submit again.`,
					}
				: {
						title: "Text messaging was suspended",
						body: "The carrier suspended your text messaging registration. Texts are not being sent.",
					};
	try {
		await notifyDispatchers(
			{
				type: "sms_registration_update",
				...copy,
				actionUrl: SETTINGS_URL,
			},
			orgId,
		);
	} catch (err) {
		log.error({ err, orgId, status }, "SMS registration notice failed");
	}
}

/** Advances one org's registration by a step; returns its new status. */
export async function pollSmsAccount(
	orgId: string,
	now: Date,
): Promise<SmsAccountStatus | null> {
	const sdb = getScopedDb(orgId);
	const where = { organization_id: orgId };
	const claim = await sdb.org_sms_account.updateMany({
		where: { ...where, ...dueWhere(now) },
		data: { last_polled_at: now },
	});
	if (claim.count === 0) return null;
	const acct = await sdb.org_sms_account.findFirst({ where });
	if (!acct) return null;
	const prev = acct.status as SmsAccountStatus;
	if (prev === "active") return recheckActive(orgId, acct);
	const form = acct.registration as unknown as SmsRegistrationForm;
	let ids = idsOf(acct);
	const data: Prisma.org_sms_accountUpdateManyMutationInput = {};
	let status: SmsAccountStatus;
	let step: SmsRegistrationStep | null = null;
	let reason: string | null = null;

	try {
		if (
			prev === "submitted" &&
			!ids.brand_sid &&
			acct.submitted_at &&
			acct.submitted_at.getTime() < now.getTime() - ABANDONED_MS
		) {
			status = "failed";
			reason = "Registration didn't finish. Submit it again.";
		} else {
			// A campaign tied to a failed brand or campaign must go before a
			// new one is filed; its sid is dropped only once it is removed.
			if (
				ids.campaign_sid &&
				(acct.failed_step === "brand" ||
					acct.failed_step === "campaign")
			) {
				await smsProvider.deleteCampaign(ids);
				ids = { ...ids, campaign_sid: null };
				data.campaign_sid = null;
			}
			data.failed_step = null;

			const res = await smsProvider.pollRegistration(ids);
			ids = { ...ids, ...res.patch };
			Object.assign(data, res.patch);
			status = res.status;
			if (status === "failed") {
				step = res.failedStep ?? "brand";
				reason = res.failureReason ?? "Registration was not approved.";
			} else if (res.needsNumber) {
				step = "number";
				Object.assign(
					data,
					await smsProvider.provisionNumber(ids, {
						areaCode: form.area_code,
						region: form.address.region,
						isoCountry: form.address.iso_country,
					}),
				);
				status = "active";
			} else if (status === "campaign_pending" && !ids.campaign_sid) {
				step = "campaign";
				Object.assign(
					data,
					await smsProvider.createCampaign(
						ids,
						buildCampaignContent(form),
					),
				);
			}
		}
	} catch (err) {
		// Only a refusal of the step in progress fails the registration;
		// anything else is retried on the next tick.
		if (!(err instanceof SmsRegistrationError) || !step) throw err;
		Object.assign(data, err.partial);
		status = "failed";
		reason = err.reason;
	}

	if (status === "failed") {
		data.failure_reason = reason;
		// An abandoned submit has no step; keep the last one for the resubmit.
		if (step) data.failed_step = step;
		// A resubmit files a new brand; a failed campaign is removed (above)
		// and refiled; a failed number keeps everything and is retried.
		if (step === "brand")
			Object.assign(data, { brand_sid: null, profile_sid: null });
	}
	if (status === "active" && !acct.activated_at) data.activated_at = now;
	data.status = status;

	const saved = await writeAfterProvider(orgId, data, () =>
		sdb.org_sms_account.updateMany({
			where: { ...where, status: prev },
			data,
		}),
	);
	if (saved.count === 1 && status !== prev && !POLLED.includes(status))
		await notify(
			orgId,
			status,
			(data.phone_number as string | undefined) ?? acct.phone_number,
			reason,
		);
	return status;
}

/**
 * Only a suspension moves a live account. Anything else the provider reports
 * (a detached number, say) is left for a person: the registration steps would
 * buy numbers and refile campaigns for an org that is already sending.
 */
async function recheckActive(
	orgId: string,
	acct: Parameters<typeof idsOf>[0] & { phone_number: string | null },
): Promise<SmsAccountStatus> {
	const res = await smsProvider.pollRegistration(idsOf(acct));
	if (res.status !== "suspended") return "active";
	const where = { organization_id: orgId, status: "active" };
	const saved = await getScopedDb(orgId).org_sms_account.updateMany({
		where,
		data: { status: "suspended" },
	});
	if (saved.count === 1)
		await notify(orgId, "suspended", acct.phone_number, null);
	log.warn({ orgId }, "SMS account suspended by the carrier");
	return "suspended";
}

export async function runRegistrationPoll(now = new Date()): Promise<void> {
	// Root db for the selection only; each org is then read through its scope.
	const due = await db.org_sms_account.findMany({
		where: dueWhere(now),
		select: { organization_id: true },
	});
	for (const { organization_id: orgId } of due) {
		try {
			await pollSmsAccount(orgId, now);
		} catch (err) {
			log.warn({ err, orgId }, "SMS registration poll failed");
		}
	}
}

let running = false;

export function startRegistrationPollerInterval(): void {
	setInterval(async () => {
		if (running) return;
		running = true;
		try {
			await runRegistrationPoll();
		} catch (err) {
			log.error({ err }, "SMS registration poll sweep failed");
		} finally {
			running = false;
		}
	}, INTERVAL_MS);
}
