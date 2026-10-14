import { MODULES, PERMISSION_MAP, type Access } from "./registry.js";

export type ModuleState = "on" | "off_by_org" | "not_in_plan";

export interface EntitlementRowLike {
	module_choices: Record<string, boolean>;
	module_grants: Record<string, "on" | "off">;
	limit_overrides: Record<string, number | null>;
	trial_ends_at: Date | null;
}

export interface PlanVersionLike {
	plan_key: string;
	version: number;
	modules: string[];
	limits: Record<string, number | null>;
}

export interface ResolvedEntitlements {
	planKey: string;
	planVersion: number;
	trialActive: boolean;
	modules: Record<string, ModuleState>;
	limits: Record<string, number | null>;
}

const RANK: Record<ModuleState, number> = {
	on: 0,
	off_by_org: 1,
	not_in_plan: 2,
};

export function resolveEntitlements(
	row: EntitlementRowLike,
	plan: PlanVersionLike,
	trialPlan: PlanVersionLike | null,
	now: Date,
): ResolvedEntitlements {
	const trialActive =
		!!trialPlan &&
		!!row.trial_ends_at &&
		row.trial_ends_at.getTime() > now.getTime();
	const effective = trialActive ? trialPlan! : plan;
	const included = new Set(effective.modules);

	const modules: Record<string, ModuleState> = {};
	for (const m of MODULES) {
		if (m.kind === "core") {
			modules[m.key] = "on";
			continue;
		}
		const grant = row.module_grants[m.key];
		const allowed =
			grant === "off"
				? false
				: grant === "on"
					? true
					: included.has(m.key);
		if (!allowed) {
			modules[m.key] = "not_in_plan";
			continue;
		}
		const choice = row.module_choices[m.key];
		const chosen = choice === undefined ? m.kind === "plan_gated" : choice;
		modules[m.key] = chosen ? "on" : "off_by_org";
	}

	// Only a module that is on before this pass inherits a dependency's state; one the
	// org switched off or the plan lacks keeps its own. Membership is fixed up front so
	// the result does not depend on the order of `requires`. A chain is at most two deep
	// today; loop to a fixpoint so a longer one added later still resolves.
	const wasOn = new Set(
		MODULES.filter((m) => modules[m.key] === "on").map((m) => m.key),
	);
	for (let changed = true; changed;) {
		changed = false;
		for (const m of MODULES) {
			if (!wasOn.has(m.key)) continue;
			for (const dep of m.requires) {
				const depState = modules[dep] ?? "not_in_plan";
				if (RANK[depState] > RANK[modules[m.key]]) {
					modules[m.key] = depState;
					changed = true;
				}
			}
		}
	}

	return {
		planKey: effective.plan_key,
		planVersion: effective.version,
		trialActive,
		modules,
		limits: { ...effective.limits, ...row.limit_overrides },
	};
}

export function isAccessAllowed(state: ModuleState, access: Access): boolean {
	if (state === "on") return true;
	return state === "off_by_org" && access === "read";
}

export function isPermissionEffective(
	permission: string,
	modules: Record<string, ModuleState>,
): boolean {
	const owner = PERMISSION_MAP[permission];
	if (!owner) return true;
	return isAccessAllowed(
		modules[owner.module] ?? "not_in_plan",
		owner.access,
	);
}
