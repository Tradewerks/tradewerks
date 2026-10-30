import type { Prisma } from "../../generated/prisma/client.js";
import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import {
	getEntitlementBreakdown,
	getEntitlements,
	STAFF_ACTOR_NAME,
} from "../services/entitlementService.js";
import {
	getUsageSummary,
	type UsageSummary,
} from "../lib/entitlements/quota.js";
import { moduleCatalog } from "../lib/entitlements/registry.js";
import { historyRows } from "./historyRows.js";
import { DAY_MS } from "../lib/dayRange.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { activeTrial } from "./activeTrial.js";
import { badRequest, isUniqueViolation } from "./errors.js";
import {
	EMAIL_IN_USE,
	loginEmailTaken,
	latestVersionId,
	provisionOrganization,
} from "../services/provisionOrganization.js";
import { newOrgInvite } from "../services/orgAdminInvite.js";
import { sendOrgAdminInviteEmail } from "../services/emailService.js";

const PAGE = 25;
const emailInUse = () => httpError(409, ErrorCodes.CONFLICT, EMAIL_IN_USE);
const pendingAdminInvite = (orgId: string): Prisma.dispatcherWhereInput => ({
	organization_id: orgId,
	role: "admin",
	invite_token_hash: { not: null },
});

async function usageOf(orgId: string): Promise<UsageSummary | null> {
	try {
		return await getUsageSummary(
			orgId,
			(await getEntitlements(orgId)).limits,
		);
	} catch (err) {
		log.warn({ err, orgId }, "usage unavailable for back office");
		return null;
	}
}

export async function listOrgs(
	q: string,
	page: number,
	trialEndingDays?: number,
	tier?: { key: string; version?: number },
) {
	const from = new Date();
	const where = {
		...(q && { name: { contains: q, mode: "insensitive" as const } }),
		...((trialEndingDays || tier) && {
			entitlement: {
				...(trialEndingDays && {
					trial_plan_version_id: { not: null },
					trial_ends_at: {
						gt: from,
						lte: new Date(from.getTime() + trialEndingDays * DAY_MS),
					},
				}),
				...(tier && {
					plan_version: {
						plan: { key: tier.key },
						...(tier.version && { version: tier.version }),
					},
				}),
			},
		}),
	};
	const [total, orgs] = await Promise.all([
		db.organization.count({ where }),
		db.organization.findMany({
			where,
			orderBy: { name: "asc" },
			skip: (page - 1) * PAGE,
			take: PAGE,
			select: {
				id: true,
				name: true,
				timezone: true,
				entitlement: {
					select: {
						template_key: true,
						trial_ends_at: true,
						plan_version: {
							select: {
								version: true,
								plan: { select: { key: true, label: true } },
							},
						},
						trial_plan_version: {
							select: { plan: { select: { label: true } } },
						},
					},
				},
			},
		}),
	]);
	const now = Date.now();
	const rows = await Promise.all(
		orgs.map(async (o) => {
			const e = o.entitlement;
			return {
				id: o.id,
				name: o.name,
				timezone: o.timezone,
				tier: e
					? {
							key: e.plan_version.plan.key,
							label: e.plan_version.plan.label,
							version: e.plan_version.version,
						}
					: null,
				trial: e ? activeTrial(e, now) : null,
				template: e?.template_key ?? null,
				usage: await usageOf(o.id),
			};
		}),
	);
	return { rows, total, page, pageSize: PAGE };
}

export async function getOrgDetail(orgId: string) {
	const org = await db.organization.findUnique({
		where: { id: orgId },
		select: { id: true, name: true, timezone: true },
	});
	if (!org)
		throw httpError(404, ErrorCodes.NOT_FOUND, "Organization not found");
	const entitlement = await db.org_entitlement.findUnique({
		where: { organization_id: orgId },
		select: {
			plan_version_id: true,
			plan_source: true,
			template_key: true,
			trial_plan_version_id: true,
			trial_ends_at: true,
			module_choices: true,
			module_grants: true,
			limit_overrides: true,
			updated_at: true,
		},
	});
	const [resolved, breakdown, usage, invite] = await Promise.all([
		getEntitlements(orgId),
		getEntitlementBreakdown(orgId),
		usageOf(orgId),
		db.dispatcher.findFirst({
			where: pendingAdminInvite(orgId),
			select: { email: true, invite_expires_at: true },
		}),
	]);
	return {
		org,
		adminInvite: invite?.invite_expires_at
			? { email: invite.email, expiresAt: invite.invite_expires_at.toISOString() }
			: null,
		entitlement,
		resolved,
		breakdown,
		usage,
		catalog: moduleCatalog(),
	};
}

export const getOrgHistory = (orgId: string) =>
	historyRows({
		organization_id: orgId,
		OR: [
			{ entity_type: "org_entitlement", entity_id: orgId },
			{ entity_type: "upgrade_request" },
		],
	});

export interface CreateOrgInput {
	name: string;
	adminName: string;
	adminEmail: string;
	businessType: string;
	planKey: string;
	trial?: { planKey: string; days: number };
}

async function latestAssignable(planKey: string): Promise<string> {
	const id = await latestVersionId({ key: planKey, assignable: true, archived_at: null });
	if (!id) throw badRequest("Choose an active, assignable tier");
	return id;
}

const staffLog = (
	actor: { id: string },
	orgId: string,
	event_type: string,
	action: string,
	changes?: Record<string, { old: string | null; new: string | null }>,
) => ({
	data: {
		organization_id: orgId,
		event_type,
		action,
		entity_type: "org_entitlement",
		entity_id: orgId,
		actor_type: "platform_staff",
		actor_id: actor.id,
		actor_name: STAFF_ACTOR_NAME,
		...(changes && { changes }),
	},
});

export async function createOrgByStaff(
	actor: { id: string; name: string },
	input: CreateOrgInput,
) {
	const email = input.adminEmail.trim().toLowerCase();
	if (await loginEmailTaken(email)) throw emailInUse();
	const planVersionId = await latestAssignable(input.planKey);
	const trial = input.trial
		? {
				planVersionId: await latestAssignable(input.trial.planKey),
				endsAt: new Date(Date.now() + input.trial.days * DAY_MS),
			}
		: undefined;
	const inv = newOrgInvite();
	// Nobody knows this password; the invite link is the only way in.
	const unusable = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
	const name = input.name.trim();

	const created = await db.$transaction(async (tx) => {
		const r = await provisionOrganization(tx, {
			org: { name, email },
			admin: {
				name: input.adminName.trim(),
				email,
				password: unusable,
				invite: { hash: inv.hash, expires: inv.expires },
			},
			businessType: input.businessType,
			planVersionId,
			trial,
			source: "operator",
		});
		await tx.log.create(
			staffLog(actor, r.orgId, "organization.created", "created", {
				tier: { old: null, new: input.planKey },
				business_type: { old: null, new: input.businessType },
				...(input.trial && {
					trial: { old: null, new: `${input.trial.planKey} for ${input.trial.days} days` },
				}),
			}),
		);
		return r;
	}).catch((err) => {
		// A parallel create took the email between the check above and this insert.
		throw isUniqueViolation(err) ? emailInUse() : err;
	});
	await sendOrgAdminInviteEmail(email, name, inv.url, inv.expires, created.timezone);
	return { id: created.orgId, inviteUrl: inv.url };
}

export async function resendOrgAdminInvite(actor: { id: string; name: string }, orgId: string) {
	const d = await db.dispatcher.findFirst({
		where: pendingAdminInvite(orgId),
		select: {
			id: true,
			email: true,
			organization: { select: { name: true, timezone: true } },
		},
	});
	if (!d)
		throw httpError(409, ErrorCodes.CONFLICT, "This organization has no pending admin invite");
	const inv = newOrgInvite();
	await db.$transaction(async (tx) => {
		await tx.dispatcher.update({
			where: { id: d.id },
			data: { invite_token_hash: inv.hash, invite_expires_at: inv.expires },
		});
		await tx.log.create(staffLog(actor, orgId, "organization.admin_invite_resent", "updated"));
	});
	await sendOrgAdminInviteEmail(
		d.email,
		d.organization?.name ?? "",
		inv.url,
		inv.expires,
		d.organization?.timezone ?? "America/Chicago",
	);
	return { inviteUrl: inv.url };
}
