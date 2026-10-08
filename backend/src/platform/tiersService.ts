import { db } from "../db.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import {
	LIMIT_KEYS,
	MODULES,
	type LimitKey,
} from "../lib/entitlements/registry.js";
import {
	NotOnVersionError,
	STAFF_ACTOR_NAME,
	applyStaffChange,
	previewStaffChange,
	type StaffChangePreview,
} from "../services/entitlementService.js";
import type { EntitlementDiff } from "../lib/entitlements/change.js";
import type { StaffActor } from "./staffService.js";
import { historyRows } from "./historyRows.js";
import { activeTrial } from "./activeTrial.js";
import { badRequest, isUniqueViolation } from "./errors.js";

export type TierPatch =
	| { label: string }
	| { archived: boolean }
	| { signupDefault: true }
	| { trialDefault: true };
type Contents = { modules: string[]; limits: Record<LimitKey, number | null> };
type ContentsInput = {
	modules: string[];
	limits: Record<string, number | null>;
	note: string;
};

const NON_CORE = new Set(
	MODULES.filter((m) => m.kind !== "core").map((m) => m.key),
);

export function validateContents(
	modules: string[],
	limits: Record<string, number | null | undefined>,
): Contents {
	const unknown = modules.find((m) => !NON_CORE.has(m));
	if (unknown) throw badRequest(`Unknown module: ${unknown}`);
	const out = {} as Record<LimitKey, number | null>;
	for (const k of LIMIT_KEYS) {
		const v = limits[k];
		if (v === undefined) throw badRequest(`Missing limit: ${k}`);
		if (v !== null && (!Number.isInteger(v) || v < 0))
			throw badRequest("A limit must be a whole number, 0 or more");
		out[k] = v;
	}
	return { modules: [...new Set(modules)].sort(), limits: out };
}

export function sameContents(
	v: { modules: string[]; limits: unknown },
	c: Contents,
): boolean {
	const limits = (v.limits ?? {}) as Record<string, number | null>;
	return (
		JSON.stringify([...v.modules].sort()) === JSON.stringify(c.modules) &&
		LIMIT_KEYS.every((k) => (limits[k] ?? null) === c.limits[k])
	);
}

const tierLog = (
	actor: StaffActor,
	key: string,
	event: string,
	changes: object,
	reason: string,
) => ({
	data: {
		organization_id: null,
		event_type: `plan.${event}`,
		action: event === "created" ? "created" : "updated",
		entity_type: "plan",
		entity_id: key,
		actor_type: "platform_staff",
		actor_id: actor.id,
		actor_name: STAFF_ACTOR_NAME,
		changes,
		reason,
	},
});

export async function listTiers() {
	const [plans, counts, trialCounts] = await Promise.all([
		db.plan.findMany({
			orderBy: { key: "asc" },
			include: { versions: { orderBy: { version: "desc" } } },
		}),
		db.org_entitlement.groupBy({
			by: ["plan_version_id"],
			_count: { _all: true },
		}),
		db.org_entitlement.groupBy({
			by: ["trial_plan_version_id"],
			where: { trial_plan_version_id: { not: null } },
			_count: { _all: true },
		}),
	]);
	const base = new Map(counts.map((c) => [c.plan_version_id, c._count._all]));
	const trial = new Map(
		trialCounts.map((c) => [c.trial_plan_version_id, c._count._all]),
	);
	return plans.map((p) => ({
		key: p.key,
		label: p.label,
		assignable: p.assignable,
		archived_at: p.archived_at,
		is_signup_default: p.is_signup_default,
		is_trial_default: p.is_trial_default,
		versions: p.versions.map((v) => ({
			id: v.id,
			version: v.version,
			modules: v.modules,
			limits: v.limits as Record<string, number | null>,
			note: v.note,
			created_at: v.created_at,
			org_count: base.get(v.id) ?? 0,
			trial_org_count: trial.get(v.id) ?? 0,
		})),
	}));
}

export async function createTier(
	actor: StaffActor,
	input: ContentsInput & { key: string; label: string },
) {
	const contents = validateContents(input.modules, input.limits);
	const taken = () =>
		httpError(
			409,
			ErrorCodes.CONFLICT,
			"A tier with this key already exists",
		);
	if (await db.plan.findUnique({ where: { key: input.key } })) throw taken();
	try {
		return await db.$transaction(async (tx) => {
			const plan = await tx.plan.create({
				data: { key: input.key, label: input.label },
			});
			await tx.plan_version.create({
				data: {
					plan_key: input.key,
					version: 1,
					...contents,
					note: input.note,
					created_by_id: actor.id,
				},
			});
			await tx.log.create(
				tierLog(
					actor,
					input.key,
					"created",
					{ label: { old: null, new: input.label }, ...contents },
					input.note,
				),
			);
			return plan;
		});
	} catch (err) {
		if (isUniqueViolation(err)) throw taken();
		throw err;
	}
}

export async function patchTier(
	actor: StaffActor,
	key: string,
	patch: TierPatch,
	reason: string,
) {
	try {
		return await db.$transaction(async (tx) => {
			const plan = await tx.plan.findUnique({ where: { key } });
			if (!plan)
				throw httpError(404, ErrorCodes.NOT_FOUND, "Tier not found");
			let data: Record<string, unknown>;
			let changes: Record<string, { old: unknown; new: unknown }>;
			if ("label" in patch) {
				data = { label: patch.label };
				changes = { label: { old: plan.label, new: patch.label } };
			} else if ("archived" in patch) {
				if (patch.archived) {
					if (plan.is_signup_default || plan.is_trial_default)
						throw badRequest(
							"Choose another default tier before archiving this one",
						);
					const inUse = await tx.org_entitlement.count({
						where: {
							OR: [
								{ plan_version: { plan_key: key } },
								{ trial_plan_version: { plan_key: key } },
							],
						},
					});
					if (inUse)
						throw badRequest(
							inUse === 1
								? "1 organization still uses this tier as its tier or trial. Move it first."
								: `${inUse} organizations still use this tier as their tier or trial. Move them first.`,
						);
				}
				data = { archived_at: patch.archived ? new Date() : null };
				changes = {
					archived: { old: !!plan.archived_at, new: patch.archived },
				};
			} else {
				// The schema only accepts `true`: a default is cleared by making another tier the default.
				const field =
					"signupDefault" in patch
						? "is_signup_default"
						: "is_trial_default";
				if (!plan.assignable || plan.archived_at)
					throw badRequest(
						"Only an assignable, active tier can be a default",
					);
				if (plan[field])
					throw badRequest("This tier is already the default");
				await tx.plan.updateMany({
					where: { [field]: true },
					data: { [field]: false },
				});
				data = { [field]: true };
				changes = { [field]: { old: false, new: true } };
			}
			const updated = await tx.plan.update({ where: { key }, data });
			await tx.log.create(
				tierLog(actor, key, "updated", changes, reason),
			);
			return updated;
		});
	} catch (err) {
		if (isUniqueViolation(err))
			throw httpError(
				409,
				ErrorCodes.CONFLICT,
				"Another default change happened at the same time. Reload and try again.",
			);
		throw err;
	}
}

export async function createVersion(
	actor: StaffActor,
	key: string,
	input: ContentsInput,
) {
	const contents = validateContents(input.modules, input.limits);
	return db.$transaction(async (tx) => {
		// Serialises version numbering per tier; the (plan_key, version) unique stays the backstop.
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(10, hashtext(${key}))`;
		const plan = await tx.plan.findUnique({
			where: { key },
			include: { versions: { orderBy: { version: "desc" }, take: 1 } },
		});
		if (!plan) throw httpError(404, ErrorCodes.NOT_FOUND, "Tier not found");
		if (plan.archived_at || !plan.assignable)
			throw badRequest(
				"Archived or non-assignable tiers cannot get new versions",
			);
		const latest = plan.versions[0];
		if (latest && sameContents(latest, contents))
			throw badRequest(
				`This is identical to v${latest.version}. Change a module or a limit.`,
			);
		const created = await tx.plan_version.create({
			data: {
				plan_key: key,
				version: (latest?.version ?? 0) + 1,
				...contents,
				note: input.note,
				created_by_id: actor.id,
			},
		});
		await tx.log.create(
			tierLog(
				actor,
				key,
				"version_created",
				{
					version: {
						old: latest?.version ?? null,
						new: created.version,
					},
					...contents,
				},
				input.note,
			),
		);
		return created;
	});
}

export const tierHistory = (key: string) =>
	historyRows({ entity_type: "plan", entity_id: key });

export const MOVE_MAX = 500;
// Each preview reads the org row, its usage and its blockers.
const PREVIEW_CONCURRENCY = 10;

export type MovePreviewRow = {
	orgId: string;
	name: string;
	diff: EntitlementDiff;
	blockers: StaffChangePreview["blockers"];
	overCap: StaffChangePreview["overCap"];
	trialDefers: { tierLabel: string; endsAt: string } | null;
};
export type MoveResult = {
	toVersion: number;
	moved: { orgId: string; name: string }[];
	skipped: {
		orgId: string;
		name: string;
		cause: "not_on_version" | "no_entitlement" | "conflict" | "error";
		message?: string;
	}[];
};

async function moveContext(key: string, fromVersionId: string) {
	const plan = await db.plan.findUnique({
		where: { key },
		include: { versions: { orderBy: { version: "desc" } } },
	});
	if (!plan) throw httpError(404, ErrorCodes.NOT_FOUND, "Tier not found");
	if (!plan.assignable || plan.archived_at)
		throw badRequest("This tier cannot be assigned");
	const latest = plan.versions[0];
	const from = plan.versions.find((v) => v.id === fromVersionId);
	if (!from) throw badRequest("That version is not part of this tier");
	if (from.id === latest.id)
		throw badRequest("Orgs on the latest version have nothing to move to");
	return { latest, from };
}

export async function previewMove(key: string, fromVersionId: string) {
	const { latest, from } = await moveContext(key, fromVersionId);
	const orgs = await db.org_entitlement.findMany({
		where: { plan_version_id: from.id },
		orderBy: { organization_id: "asc" },
		take: MOVE_MAX + 1,
		select: {
			organization_id: true,
			organization: { select: { name: true } },
			trial_ends_at: true,
			trial_plan_version: {
				select: { plan: { select: { label: true } } },
			},
		},
	});
	const now = Date.now();
	const batch = orgs.slice(0, MOVE_MAX);
	const rows: MovePreviewRow[] = [];
	for (let i = 0; i < batch.length; i += PREVIEW_CONCURRENCY)
		rows.push(
			...(await Promise.all(
				batch.slice(i, i + PREVIEW_CONCURRENCY).map(async (o) => {
					const p = await previewStaffChange(o.organization_id, {
						kind: "plan",
						planVersionId: latest.id,
					});
					return {
						orgId: o.organization_id,
						name: o.organization.name,
						diff: p.diff,
						blockers: p.blockers,
						overCap: p.overCap,
						trialDefers: activeTrial(o, now),
					};
				}),
			)),
		);
	return {
		from: { id: from.id, version: from.version },
		to: { id: latest.id, version: latest.version },
		truncated: orgs.length > MOVE_MAX,
		rows,
	};
}

export async function moveOrgs(
	actor: StaffActor,
	key: string,
	fromVersionId: string,
	orgIds: string[],
	reason: string,
): Promise<MoveResult> {
	const { latest, from } = await moveContext(key, fromVersionId);
	const ids = [...new Set(orgIds)];
	const found = await db.organization.findMany({
		where: { id: { in: ids } },
		select: { id: true, name: true },
	});
	const names = new Map(found.map((o) => [o.id, o.name]));
	const result: MoveResult = {
		toVersion: latest.version,
		moved: [],
		skipped: [],
	};
	for (const orgId of ids) {
		const name = names.get(orgId) ?? orgId;
		try {
			await applyStaffChange(
				orgId,
				{ kind: "plan", planVersionId: latest.id },
				actor,
				reason,
				{
					expectedPlanVersionId: from.id,
				},
			);
			result.moved.push({ orgId, name });
		} catch (err) {
			const status = (err as { statusCode?: number }).statusCode;
			if (err instanceof NotOnVersionError)
				result.skipped.push({ orgId, name, cause: "not_on_version" });
			else if (status === 404)
				result.skipped.push({ orgId, name, cause: "no_entitlement" });
			else if (status === 409)
				result.skipped.push({ orgId, name, cause: "conflict" });
			else
				result.skipped.push({
					orgId,
					name,
					cause: "error",
					message: (err as Error).message,
				});
		}
	}
	await db.log.create(
		tierLog(
			actor,
			key,
			"orgs_moved",
			{
				from: from.version,
				to: latest.version,
				moved: result.moved.length,
				skipped: result.skipped.length,
			},
			reason,
		),
	);
	return result;
}
