import { db } from "../db.js";
import { log } from "../services/appLogger.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import {
	getEntitlementBreakdown,
	getEntitlements,
} from "../services/entitlementService.js";
import {
	getUsageSummary,
	type UsageSummary,
} from "../lib/entitlements/quota.js";
import { moduleCatalog } from "../lib/entitlements/registry.js";
import { historyRows } from "./historyRows.js";
import { activeTrial } from "./activeTrial.js";

const PAGE = 25;

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

export async function listOrgs(q: string, page: number) {
	const where = q
		? { name: { contains: q, mode: "insensitive" as const } }
		: {};
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
		select: { id: true, name: true },
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
	const [resolved, breakdown, usage] = await Promise.all([
		getEntitlements(orgId),
		getEntitlementBreakdown(orgId),
		usageOf(orgId),
	]);
	return {
		org,
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
