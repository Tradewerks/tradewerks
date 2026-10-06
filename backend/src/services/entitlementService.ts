import { z } from "zod";
import { db } from "../db.js";
import { log } from "./appLogger.js";
import { emitToOrg } from "./socketService.js";
import { ErrorCodes, httpError } from "../types/responses.js";
import { MODULES, getModule } from "../lib/entitlements/registry.js";
import {
	resolveEntitlements,
	type PlanVersionLike,
	type ResolvedEntitlements,
} from "../lib/entitlements/resolve.js";

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

function resolveRow(
	row: LoadedRow,
	choices?: Record<string, boolean>,
): ResolvedEntitlements {
	return resolveEntitlements(
		{
			module_choices:
				choices ?? choicesSchema.catch({}).parse(row.module_choices),
			module_grants: grantsSchema.catch({}).parse(row.module_grants),
			limit_overrides: limitsSchema.catch({}).parse(row.limit_overrides),
			trial_ends_at: row.trial_ends_at,
		},
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
