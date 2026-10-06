export type ModuleState = "on" | "off_by_org" | "not_in_plan";

export interface UsageMeter {
	used: number;
	limit: number | null;
}

export interface UsageSummary {
	period_start: string;
	meters: Record<"dispatchers" | "technicians" | "ai_calls_month" | "tax_lookups_month", UsageMeter>;
}

export interface EntitlementsData {
	plan: { key: string; version: number; trialActive: boolean };
	modules: {
		key: string;
		label: string;
		description: string;
		kind: "core" | "optional" | "plan_gated";
		requires: string[];
		state: ModuleState;
	}[];
	permissionMap: Record<string, { module: string; access: "read" | "write" }>;
	limits: Record<string, number | null>;
	usage: UsageSummary | null;
}

// Undefined means "not loaded". The backend enforces regardless, so the UI
// stays permissive rather than flashing an empty shell.
export function moduleState(ent: EntitlementsData | undefined, key: string): ModuleState {
	if (!ent) return "on";
	if (key === "core") return "on";
	return ent.modules.find((m) => m.key === key)?.state ?? "not_in_plan";
}

export function isPermissionEffective(
	permission: string,
	ent: EntitlementsData | undefined,
): boolean {
	if (!ent) return true;
	const owner = ent.permissionMap[permission];
	if (!owner) return true;
	const state = moduleState(ent, owner.module);
	if (state === "on") return true;
	return state === "off_by_org" && owner.access === "read";
}

/** Whether a role editor should offer this permission: only while its module is on. */
export function isPermissionOffered(permission: string, ent: EntitlementsData | undefined): boolean {
	const owner = ent?.permissionMap[permission];
	return !owner || moduleState(ent, owner.module) === "on";
}

// Fired when a request is refused for a module reason: the cached state is out of date.
export const ENTITLEMENTS_STALE_EVENT = "entitlements:stale";

export const isActiveUser = (u: { deactivated_at?: string | null }): boolean => !u.deactivated_at;

export const activeOnly = <T extends { deactivated_at?: string | null }>(list: T[]): T[] =>
	list.filter(isActiveUser);
