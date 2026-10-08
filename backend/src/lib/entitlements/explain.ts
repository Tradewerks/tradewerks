import { LIMIT_KEYS, MODULES, type LimitKey } from "./registry.js";
import {
	resolveEntitlements,
	type EntitlementRowLike,
	type ModuleState,
	type PlanVersionLike,
	type ResolvedEntitlements,
} from "./resolve.js";

export type ModuleSource =
	| "tier"
	| "trial"
	| "grant_on"
	| "grant_off"
	| "not_in_tier"
	| "org_off"
	| "requires";

export interface ModuleBreakdown {
	state: ModuleState;
	source: ModuleSource;
	blockedBy?: string;
}

export interface LimitBreakdown {
	tier: number | null;
	trial?: number | null;
	override?: number | null;
	effective: number | null;
}

// Mirrors resolveEntitlements' rule order (grant → tier → org choice → dependency).
// state/effective come from resolveEntitlements itself, so only the explanation
// can drift; explain.test.ts pins that.
export function explainEntitlements(
	row: EntitlementRowLike,
	plan: PlanVersionLike,
	trialPlan: PlanVersionLike | null,
	now: Date,
): {
	resolved: ResolvedEntitlements;
	modules: Record<string, ModuleBreakdown>;
	limits: Record<LimitKey, LimitBreakdown>;
} {
	const resolved = resolveEntitlements(row, plan, trialPlan, now);
	const included = new Set((resolved.trialActive ? trialPlan! : plan).modules);

	const modules: Record<string, ModuleBreakdown> = {};
	for (const m of MODULES) {
		if (m.kind === "core") continue;
		const state = resolved.modules[m.key];
		const grant = row.module_grants[m.key];
		if (grant === "off") {
			modules[m.key] = { state, source: "grant_off" };
		} else if (grant !== "on" && !included.has(m.key)) {
			modules[m.key] = { state, source: "not_in_tier" };
		} else if (state === "on") {
			const source =
				grant === "on" ? "grant_on" : resolved.trialActive ? "trial" : "tier";
			modules[m.key] = { state, source };
		} else {
			const chosen = row.module_choices[m.key] ?? m.kind === "plan_gated";
			// The module inherits its worst dependency's state, so name that one: pointing at
			// a dependency that is merely off-by-org sends support to fix the wrong module.
			const blockedBy =
				m.requires.find((d) => resolved.modules[d] === state) ??
				m.requires.find((d) => resolved.modules[d] !== "on");
			modules[m.key] =
				chosen && blockedBy
					? { state, source: "requires", blockedBy }
					: { state, source: "org_off" };
		}
	}

	const limits = {} as Record<LimitKey, LimitBreakdown>;
	for (const k of LIMIT_KEYS) {
		limits[k] = {
			tier: plan.limits[k] ?? null,
			...(resolved.trialActive ? { trial: trialPlan!.limits[k] ?? null } : {}),
			...(Object.prototype.hasOwnProperty.call(row.limit_overrides, k)
				? { override: row.limit_overrides[k] }
				: {}),
			effective: resolved.limits[k] ?? null,
		};
	}
	return { resolved, modules, limits };
}
