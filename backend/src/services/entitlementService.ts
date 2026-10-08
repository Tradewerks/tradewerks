import { z } from "zod";
import { db } from "../db.js";
import { log } from "./appLogger.js";
import { emitToOrg } from "./socketService.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { LIMIT_KEYS, MODULES, getModule, type LimitKey } from "../lib/entitlements/registry.js";
import { diffResolved, type EntitlementDiff } from "../lib/entitlements/change.js";
import { getUsageSummary } from "../lib/entitlements/quota.js";
import { notifyDispatchers } from "../controllers/notificationsController.js";
import type { StaffActor } from "../platform/staffService.js";
import { notifyRequestResolved } from "../platform/requestNotice.js";
import { closeRequestTx } from "../platform/requestClose.js";
import {
	resolveEntitlements,
	type PlanVersionLike,
	type ResolvedEntitlements,
} from "../lib/entitlements/resolve.js";
import {
	explainEntitlements,
	type LimitBreakdown,
	type ModuleBreakdown,
} from "../lib/entitlements/explain.js";

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: ResolvedEntitlements }>();

const choicesSchema = z.record(z.string(), z.boolean());
const grantsSchema = z.record(z.string(), z.enum(["on", "off"]));
const limitsSchema = z.record(z.string(), z.number().nullable());

const asPlan = (v: {
	plan_key: string;
	version: number;
	modules: string[];
	limits: unknown;
}): PlanVersionLike => ({
	plan_key: v.plan_key,
	version: v.version,
	modules: v.modules,
	limits: limitsSchema.catch({}).parse(v.limits),
});

// An org with no row is a bug elsewhere; it must not take the org's daily
// work down with it, so it gets optional modules and no paid ones.
function fallback(): ResolvedEntitlements {
	const optional = MODULES.filter((m) => m.kind === "optional").map(
		(m) => m.key,
	);
	return resolveEntitlements(
		{
			module_choices: Object.fromEntries(optional.map((k) => [k, true])),
			module_grants: {},
			limit_overrides: {},
			trial_ends_at: null,
		},
		{ plan_key: "none", version: 0, modules: optional, limits: {} },
		null,
		new Date(),
	);
}

type LoadedRow = NonNullable<
	Awaited<
		ReturnType<
			typeof db.org_entitlement.findUnique<{
				where: { organization_id: string };
				include: { plan_version: true; trial_plan_version: true };
			}>
		>
	>
>;

const rowLike = (
	row: {
		module_choices: unknown;
		module_grants: unknown;
		limit_overrides: unknown;
		trial_ends_at: Date | null;
	},
	choices?: Record<string, boolean>,
) => ({
	module_choices: choices ?? choicesSchema.catch({}).parse(row.module_choices),
	module_grants: grantsSchema.catch({}).parse(row.module_grants),
	limit_overrides: limitsSchema.catch({}).parse(row.limit_overrides),
	trial_ends_at: row.trial_ends_at,
});

function resolveRow(
	row: LoadedRow,
	choices?: Record<string, boolean>,
): ResolvedEntitlements {
	return resolveEntitlements(
		rowLike(row, choices),
		asPlan(row.plan_version),
		row.trial_plan_version ? asPlan(row.trial_plan_version) : null,
		new Date(),
	);
}

export function invalidateEntitlements(orgId: string): void {
	cache.delete(orgId);
}

export async function getEntitlements(
	orgId: string,
): Promise<ResolvedEntitlements> {
	const hit = cache.get(orgId);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
	try {
		const row = await db.org_entitlement.findUnique({
			where: { organization_id: orgId },
			include: { plan_version: true, trial_plan_version: true },
		});
		let value: ResolvedEntitlements;
		if (!row) {
			log.error(
				{ orgId },
				"org has no org_entitlement row; using fallback",
			);
			value = fallback();
		} else {
			value = resolveRow(row);
		}
		cache.set(orgId, { at: Date.now(), value });
		return value;
	} catch (err) {
		// Serve the stale answer rather than guess; with none, the caller decides.
		if (hit) {
			log.warn(
				{ err, orgId },
				"entitlement lookup failed; serving stale",
			);
			return hit.value;
		}
		throw httpError(
			503,
			ErrorCodes.ENTITLEMENTS_UNAVAILABLE,
			"Entitlements are temporarily unavailable",
		);
	}
}

export interface TierRef {
	key: string;
	label: string;
	version: number;
}
export interface EntitlementBreakdown {
	modules: Record<string, ModuleBreakdown>;
	limits: Record<LimitKey, LimitBreakdown>;
	baseTier: TierRef;
	trialTier: (TierRef & { endsAt: string }) | null;
}

const withTiers = {
	plan_version: { include: { plan: true } },
	trial_plan_version: { include: { plan: true } },
} as const;

type StaffRow = NonNullable<
	Awaited<
		ReturnType<
			typeof db.org_entitlement.findUnique<{
				where: { organization_id: string };
				include: typeof withTiers;
			}>
		>
	>
>;

// Uncached on purpose: the back office must show the row as it is now, not as
// the 30 s entitlement cache last saw it.
export async function getEntitlementBreakdown(
	orgId: string,
): Promise<EntitlementBreakdown | null> {
	const row = await db.org_entitlement.findUnique({
		where: { organization_id: orgId },
		include: withTiers,
	});
	return row ? breakdownOf(row) : null;
}

function breakdownOf(row: StaffRow): EntitlementBreakdown {
	const { resolved, modules, limits } = explainEntitlements(
		rowLike(row),
		asPlan(row.plan_version),
		row.trial_plan_version ? asPlan(row.trial_plan_version) : null,
		new Date(),
	);
	const ref = (v: {
		plan_key: string;
		version: number;
		plan: { label: string };
	}) => ({ key: v.plan_key, label: v.plan.label, version: v.version });
	return {
		modules,
		limits,
		baseTier: ref(row.plan_version),
		trialTier:
			resolved.trialActive && row.trial_plan_version && row.trial_ends_at
				? {
						...ref(row.trial_plan_version),
						endsAt: row.trial_ends_at.toISOString(),
					}
				: null,
	};
}

// Cosmetic: a missing or unreadable label falls back to the key rather than failing the read.
export async function tierLabel(key: string): Promise<string> {
	try {
		return (
			(
				await db.plan.findUnique({
					where: { key },
					select: { label: true },
				})
			)?.label ?? key
		);
	} catch (err) {
		log.warn({ err, key }, "tier label unavailable");
		return key;
	}
}

export async function isModuleOn(orgId: string, key: string): Promise<boolean> {
	try {
		return (await getEntitlements(orgId)).modules[key] === "on";
	} catch (err) {
		log.warn(
			{ err, orgId, key },
			"isModuleOn failed; treating module as off",
		);
		return false;
	}
}

export type Blocker = (
	orgId: string,
) => Promise<{ count: number; message: string } | null>;
const blockers = new Map<string, Blocker>();
export function registerBlocker(moduleKey: string, fn: Blocker): void {
	blockers.set(moduleKey, fn);
}

export interface DisablePreview {
	module: string;
	warning: string | null;
	dependents: string[];
	blocker: { count: number; message: string } | null;
}

export async function previewDisable(
	orgId: string,
	key: string,
): Promise<DisablePreview> {
	const def = getModule(key);
	if (!def || def.kind === "core")
		throw httpError(400, ErrorCodes.BAD_REQUEST, "Unknown module");
	const current = await getEntitlements(orgId);
	const dependents = MODULES.filter(
		(m) => m.requires.includes(key) && current.modules[m.key] === "on",
	).map((m) => m.label);
	const blocker = (await blockers.get(key)?.(orgId)) ?? null;
	return {
		module: key,
		warning: def.disableWarning ?? null,
		dependents,
		blocker,
	};
}

export async function setModuleChoices(
	orgId: string,
	choices: Record<string, boolean>,
	actor: {
		id: string;
		name: string;
		type: "dispatcher" | "platform_staff" | "system";
	},
): Promise<ResolvedEntitlements> {
	const parsed = choicesSchema.safeParse(choices);
	if (!parsed.success)
		throw httpError(400, ErrorCodes.BAD_REQUEST, "Invalid module choices");
	const wanted = parsed.data;

	// Fresh read, not the cache: the decisions below and the optimistic write
	// must both see the row as it is now.
	const row = await db.org_entitlement.findUnique({
		where: { organization_id: orgId },
		include: { plan_version: true, trial_plan_version: true },
	});
	if (!row)
		throw httpError(404, ErrorCodes.NOT_FOUND, "Entitlements not found");
	const before = choicesSchema.catch({}).parse(row.module_choices);
	const current = resolveRow(row);

	const next = { ...before };
	for (const [key, value] of Object.entries(wanted)) {
		const def = getModule(key);
		if (!def || def.kind === "core")
			throw httpError(
				400,
				ErrorCodes.BAD_REQUEST,
				`Unknown module: ${key}`,
			);
		if (current.modules[key] === "not_in_plan") {
			throw httpError(
				403,
				ErrorCodes.MODULE_NOT_IN_PLAN,
				`${def.label} is not included in your plan`,
			);
		}
		next[key] = value;
	}

	for (const [key, value] of Object.entries(wanted)) {
		const def = getModule(key)!;
		if (value) {
			const missing = def.requires.filter(
				(dep) => next[dep] !== true && getModule(dep)?.kind !== "core",
			);
			if (missing.length) {
				const names = missing
					.map((d) => getModule(d)!.label)
					.join(", ");
				throw httpError(
					409,
					ErrorCodes.CONFLICT,
					`${def.label} needs ${names} to be on`,
				);
			}
			continue;
		}
		if (current.modules[key] !== "on") continue;
		// Resolved state as well as the stored choice: a dependent the plan no
		// longer includes is not running, and the org has no switch to clear it.
		const dependents = MODULES.filter(
			(m) =>
				m.requires.includes(key) &&
				next[m.key] === true &&
				current.modules[m.key] === "on",
		);
		if (dependents.length) {
			const names = dependents.map((m) => m.label).join(", ");
			throw httpError(
				409,
				ErrorCodes.CONFLICT,
				`Turn off ${names} first; it needs ${def.label}`,
			);
		}
		const blocked = await blockers.get(key)?.(orgId);
		if (blocked) throw httpError(409, ErrorCodes.CONFLICT, blocked.message);
	}

	const changed = Object.keys(next).some((k) => next[k] !== before[k]);
	if (!changed) return current;

	await db.$transaction(async (tx) => {
		const { count } = await tx.org_entitlement.updateMany({
			where: { organization_id: orgId, updated_at: row.updated_at },
			data: { module_choices: next },
		});
		if (count === 0)
			throw httpError(
				409,
				ErrorCodes.CONFLICT,
				"Module settings were changed by someone else. Reload and try again.",
			);
		await tx.log.create({
			data: {
				organization_id: orgId,
				event_type: "org_entitlement.modules_changed",
				action: "updated",
				entity_type: "org_entitlement",
				entity_id: orgId,
				actor_type: actor.type,
				actor_id: actor.id,
				actor_name: actor.name,
				changes: { module_choices: { old: before, new: next } },
			},
		});
	});

	const value = resolveRow(row, next);
	cache.set(orgId, { at: Date.now(), value });
	try {
		emitToOrg(orgId, "entitlements:changed", {});
	} catch (err) {
		log.warn({ err, orgId }, "entitlements:changed emit failed");
	}
	return value;
}

export const STAFF_ACTOR_NAME = "TradeWerks support";

export type StaffChange =
	| { kind: "plan"; planVersionId: string }
	| { kind: "trial"; trial: { planVersionId: string; endsAt: string } | null }
	| { kind: "grant"; module: string; grant: "on" | "off" | null }
	| { kind: "limit"; key: LimitKey; override: number | null | "tier" };

export interface StaffChangePreview {
	before: ResolvedEntitlements;
	after: ResolvedEntitlements;
	diff: EntitlementDiff;
	blockers: { module: string; label: string; count: number; message: string }[];
	overCap: { key: string; used: number; limit: number }[];
}

const MAX_TRIAL_MS = 365 * 24 * 3600_000;
const staleOrg = () =>
	httpError(
		409,
		ErrorCodes.CONFLICT,
		"This organization was changed by someone else. Reload and try again.",
	);

export class NotOnVersionError extends Error {
	constructor() {
		super("The organization is no longer on that tier version");
	}
}

export interface ApplyOptions {
	expectedUpdatedAt?: string;
	expectedPlanVersionId?: string;
	upgradeRequestId?: string;
}

const nothingToChange = () => httpError(400, ErrorCodes.BAD_REQUEST, "Nothing to change");

async function assignableVersion(id: string) {
	const v = await db.plan_version.findUnique({ where: { id }, include: { plan: true } });
	if (!v) throw httpError(400, ErrorCodes.BAD_REQUEST, "Unknown tier version");
	if (!v.plan.assignable || v.plan.archived_at)
		throw httpError(400, ErrorCodes.BAD_REQUEST, "This tier cannot be assigned");
	return v;
}

// The row as it would be after the change, the columns to write, and the audit diff.
async function planChange(row: StaffRow, change: StaffChange) {
	switch (change.kind) {
		case "plan": {
			const v = await assignableVersion(change.planVersionId);
			if (v.id === row.plan_version_id)
				throw httpError(
					400,
					ErrorCodes.BAD_REQUEST,
					"The organization is already on this tier version",
				);
			const data = { plan_version_id: v.id, plan_source: "operator" };
			return {
				data,
				next: { ...row, ...data, plan_version: v } as StaffRow,
				changes: { plan_version_id: { old: row.plan_version_id, new: v.id } },
			};
		}
		case "trial": {
			const cleared = { trial_warned_3d_at: null, trial_warned_end_at: null };
			const old = { version: row.trial_plan_version_id, ends: row.trial_ends_at };
			if (change.trial === null) {
				const data = { trial_plan_version_id: null, trial_ends_at: null, ...cleared };
				return {
					data,
					next: { ...row, ...data, trial_plan_version: null } as StaffRow,
					changes: { trial: { old, new: null } },
				};
			}
			const ends = new Date(change.trial.endsAt);
			const now = Date.now();
			if (
				Number.isNaN(ends.getTime()) ||
				ends.getTime() <= now ||
				ends.getTime() > now + MAX_TRIAL_MS
			)
				throw httpError(
					400,
					ErrorCodes.BAD_REQUEST,
					"Trial end must be in the future and within a year",
				);
			const v = await assignableVersion(change.trial.planVersionId);
			const data = { trial_plan_version_id: v.id, trial_ends_at: ends, ...cleared };
			return {
				data,
				next: { ...row, ...data, trial_plan_version: v } as StaffRow,
				changes: { trial: { old, new: { version: v.id, ends } } },
			};
		}
		case "grant": {
			const def = getModule(change.module);
			if (!def || def.kind === "core")
				throw httpError(400, ErrorCodes.BAD_REQUEST, `Unknown module: ${change.module}`);
			const before = grantsSchema.catch({}).parse(row.module_grants);
			if ((before[change.module] ?? null) === change.grant) throw nothingToChange();
			const next = { ...before };
			if (change.grant === null) delete next[change.module];
			else next[change.module] = change.grant;
			return {
				data: { module_grants: next },
				next: { ...row, module_grants: next } as StaffRow,
				changes: { module_grants: { old: before, new: next } },
			};
		}
		case "limit": {
			if (!(LIMIT_KEYS as readonly string[]).includes(change.key))
				throw httpError(400, ErrorCodes.BAD_REQUEST, `Unknown limit: ${change.key}`);
			const o = change.override;
			if (typeof o === "number" && (!Number.isInteger(o) || o < 0))
				throw httpError(400, ErrorCodes.BAD_REQUEST, "A limit must be a whole number, 0 or more");
			const before = limitsSchema.catch({}).parse(row.limit_overrides);
			const unchanged =
				o === "tier" ? !(change.key in before) : change.key in before && before[change.key] === o;
			if (unchanged) throw nothingToChange();
			const next = { ...before };
			if (o === "tier") delete next[change.key];
			else next[change.key] = o;
			return {
				data: { limit_overrides: next },
				next: { ...row, limit_overrides: next } as StaffRow,
				changes: { limit_overrides: { old: before, new: next } },
			};
		}
	}
}

async function loadRow(orgId: string): Promise<StaffRow> {
	const row = await db.org_entitlement.findUnique({
		where: { organization_id: orgId },
		include: withTiers,
	});
	if (!row) throw httpError(404, ErrorCodes.NOT_FOUND, "Entitlements not found");
	return row;
}

const changeTarget = (c: StaffChange) =>
	c.kind === "grant" ? `grant:${c.module}` : c.kind === "limit" ? `limit:${c.key}` : c.kind;

function validateBatch(changes: StaffChange[]): void {
	if (changes.length === 0) throw nothingToChange();
	const seen = new Set<string>();
	for (const c of changes) {
		const target = changeTarget(c);
		if (seen.has(target))
			throw httpError(400, ErrorCodes.BAD_REQUEST, "Each setting can change only once per save");
		seen.add(target);
	}
}

// Tier first, so a grant in the same save reads against the new tier.
const ordered = (changes: StaffChange[]) => [
	...changes.filter((c) => c.kind === "plan"),
	...changes.filter((c) => c.kind !== "plan"),
];

async function foldChanges(row: StaffRow, changes: StaffChange[]) {
	validateBatch(changes);
	let next = row;
	const data: Record<string, unknown> = {};
	const steps: { kind: StaffChange["kind"]; changes: Awaited<ReturnType<typeof planChange>>["changes"] }[] =
		[];
	for (const c of ordered(changes)) {
		const step = await planChange(next, c);
		next = step.next;
		Object.assign(data, step.data);
		steps.push({ kind: c.kind, changes: step.changes });
	}
	return { next, data, steps };
}

async function assessImpact(orgId: string, after: ResolvedEntitlements, diff: EntitlementDiff) {
	const blocked = await Promise.all(
		diff.lost.map(async (m) => {
			const b = await blockers.get(m)?.(orgId);
			return b ? { module: m, label: moduleLabel(m), count: b.count, message: b.message } : null;
		}),
	);
	const usage = await getUsageSummary(orgId, after.limits);
	const overCap = Object.entries(usage.meters)
		.filter(([, m]) => m.limit !== null && m.used > m.limit)
		.map(([key, m]) => ({ key, used: m.used, limit: m.limit as number }));
	return { blockers: blocked.filter((b): b is NonNullable<typeof b> => b !== null), overCap };
}

const moduleLabel = (key: string) => getModule(key)?.label ?? key;
const LIMIT_COPY: Record<string, string> = {
	dispatchers: "Dispatcher seats",
	technicians: "Technician seats",
	ai_calls_month: "AI requests per month",
	tax_lookups_month: "Tax lookups per month",
	receipt_scans_month: "Receipt scans per month",
};

function describeLoss(diff: EntitlementDiff): string {
	const parts: string[] = [];
	if (diff.lost.length)
		parts.push(`No longer included: ${diff.lost.map(moduleLabel).join(", ")}.`);
	for (const l of diff.lowered)
		parts.push(`${LIMIT_COPY[l.key] ?? l.key} limit is now ${l.to}.`);
	return parts.join(" ");
}

export interface StaffChangesPreview extends StaffChangePreview {
	breakdown: EntitlementBreakdown;
}

export async function previewStaffChanges(
	orgId: string,
	changes: StaffChange[],
): Promise<StaffChangesPreview> {
	const row = await loadRow(orgId);
	const { next } = await foldChanges(row, changes);
	const before = resolveRow(row);
	const after = resolveRow(next);
	const diff = diffResolved(before, after);
	return {
		before,
		after,
		diff,
		...(await assessImpact(orgId, after, diff)),
		breakdown: breakdownOf(next),
	};
}

export async function previewStaffChange(
	orgId: string,
	change: StaffChange,
): Promise<StaffChangePreview> {
	const { breakdown: _, ...preview } = await previewStaffChanges(orgId, [change]);
	return preview;
}

export const applyStaffChange = (
	orgId: string,
	change: StaffChange,
	actor: StaffActor,
	reason: string,
	opts: ApplyOptions = {},
): Promise<ResolvedEntitlements> => applyStaffChanges(orgId, [change], actor, reason, opts);

// One write, one CAS, one audit row per change: a save either lands whole or not at all.
export async function applyStaffChanges(
	orgId: string,
	changeList: StaffChange[],
	actor: StaffActor,
	reason: string,
	opts: ApplyOptions = {},
): Promise<ResolvedEntitlements> {
	const row = await loadRow(orgId);
	if (opts.expectedPlanVersionId && row.plan_version_id !== opts.expectedPlanVersionId)
		throw new NotOnVersionError();
	// The page's version, not just this request's read: a save from a stale page must lose too.
	if (
		opts.expectedUpdatedAt &&
		new Date(opts.expectedUpdatedAt).getTime() !== row.updated_at.getTime()
	)
		throw staleOrg();
	const { data, next, steps } = await foldChanges(row, changeList);
	const before = resolveRow(row);
	const after = resolveRow(next);
	const { upgradeRequestId } = opts;

	await db.$transaction(async (tx) => {
		// Request first: a racing approver then loses on the request (REQUEST_CLOSED), not on
		// the org row, which would tell them to retry a change that is already made.
		if (upgradeRequestId)
			await closeRequestTx(
				tx,
				{ id: upgradeRequestId, orgId },
				"approved",
				{ type: "platform_staff", id: actor.id, name: STAFF_ACTOR_NAME },
				reason,
			);
		const { count } = await tx.org_entitlement.updateMany({
			where: {
				organization_id: orgId,
				updated_at: row.updated_at,
				...(opts.expectedPlanVersionId && { plan_version_id: opts.expectedPlanVersionId }),
			},
			data,
		});
		if (count === 0) throw staleOrg();
		for (const { kind, changes } of steps)
			await tx.log.create({
				data: {
					organization_id: orgId,
					event_type: `org_entitlement.${kind}_changed`,
					action: "updated",
					entity_type: "org_entitlement",
					entity_id: orgId,
					actor_type: "platform_staff",
					actor_id: actor.id,
					actor_name: STAFF_ACTOR_NAME,
					changes: upgradeRequestId
						? { ...changes, upgrade_request_id: upgradeRequestId }
						: changes,
					reason,
				},
			});
	});

	cache.set(orgId, { at: Date.now(), value: after });
	try {
		emitToOrg(orgId, "entitlements:changed", {});
	} catch (err) {
		log.warn({ err, orgId }, "entitlements:changed emit failed");
	}
	const diff = diffResolved(before, after);
	if (diff.lost.length || diff.lowered.length) {
		try {
			await notifyDispatchers(
				{
					type: "subscription_changed",
					title: "Your subscription changed",
					body: describeLoss(diff),
					actionUrl: "/dispatch/admin?tab=entitlements",
				},
				orgId,
			);
		} catch (err) {
			log.warn({ err, orgId }, "subscription_changed notification failed");
		}
	}
	if (upgradeRequestId)
		await notifyRequestResolved(orgId, upgradeRequestId, "approved", reason);
	return after;
}

export const setOrgPlan = (
	orgId: string,
	planVersionId: string,
	actor: StaffActor,
	reason: string,
): Promise<ResolvedEntitlements> =>
	applyStaffChange(orgId, { kind: "plan", planVersionId }, actor, reason);
