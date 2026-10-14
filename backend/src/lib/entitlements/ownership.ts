import {
	getEntitlements,
	isModuleOn,
} from "../../services/entitlementService.js";
import { getModule } from "./registry.js";
import { isAccessAllowed } from "./resolve.js";

// Surfaces that pick their data by an argument (search types, assistant record
// types, report keys) cannot be gated by route, so they look the owner up here.
// A name with no entry is core.

export const ENTITY_MODULE: Record<string, string> = {
	quote: "quotes",
	project: "projects",
	recurring_plan: "recurring_plans",
	inventory_item: "inventory",
};

export const REPORT_MODULE: Record<string, string> = {
	// Report-builder sources; their GET routes carry the same gate.
	jobs: "advanced_reporting",
	invoices: "advanced_reporting",
	clients: "advanced_reporting",
	quotes: "quotes",
	inventory: "inventory",
	"reorder-forecast": "inventory",
	"recurring-revenue": "recurring_plans",
	projects: "projects",
	"cogs-by-job": "advanced_reporting",
	"cogs-by-item": "advanced_reporting",
	"job-profitability": "advanced_reporting",
};

export const PAGE_SUMMARY_MODULE: Record<string, string> = {
	quotes: "quotes",
	inventory: "inventory",
	projects: "projects",
};

/** Names from `names` whose owning module is on (core names always pass). */
export async function namesWithModuleOn<T extends string>(
	orgId: string,
	names: readonly T[],
	owners: Record<string, string>,
): Promise<T[]> {
	const state = new Map<string, boolean>();
	for (const key of new Set(names.map((n) => owners[n]).filter(Boolean))) {
		state.set(key, await isModuleOn(orgId, key));
	}
	return names.filter((n) => !owners[n] || state.get(owners[n]) === true);
}

/**
 * For a request that only reads: the owner's state when it refuses the read
 * (`not_in_plan`), otherwise null. Mirrors what a route gate allows.
 */
export async function ownerReadRefusal(
	orgId: string,
	name: string,
	owners: Record<string, string>,
): Promise<{ module: string; label: string } | null> {
	const key = owners[name];
	if (!key) return null;
	const state = (await getEntitlements(orgId)).modules[key] ?? "not_in_plan";
	if (isAccessAllowed(state, "read")) return null;
	return { module: key, label: getModule(key)?.label ?? key };
}

export async function ownerModuleOn(
	orgId: string,
	name: string,
	owners: Record<string, string>,
): Promise<boolean> {
	return !owners[name] || isModuleOn(orgId, owners[name]);
}
