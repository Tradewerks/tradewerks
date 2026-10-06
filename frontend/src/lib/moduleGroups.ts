import type { EntitlementsData } from "./permissionAccess";

export type Module = EntitlementsData["modules"][number];

// Inside a group a module sits after the modules it requires.
const GROUPS: { label: string; keys: string[] }[] = [
	{ label: "Sales", keys: ["quotes", "followups", "disputes"] },
	{ label: "Scheduled work", keys: ["recurring_plans", "projects"] },
	{
		label: "Parts & vehicles",
		keys: ["inventory", "purchasing", "field_purchases", "fleet", "vehicle_stock"],
	},
];

export function groupModules(modules: Module[]): { label: string; modules: Module[] }[] {
	const optional = modules.filter((m) => m.kind === "optional");
	const named = new Set(GROUPS.flatMap((g) => g.keys));
	const groups = GROUPS.map((g) => ({
		label: g.label,
		modules: g.keys
			.map((key) => optional.find((m) => m.key === key))
			.filter((m): m is Module => !!m),
	}));
	// A module the registry gains later must not vanish from the page.
	groups.push({ label: "Other", modules: optional.filter((m) => !named.has(m.key)) });
	return groups.filter((g) => g.modules.length > 0);
}

export function relationsOf(
	module: Module,
	modules: Module[],
): { requires: string[]; missing: string[]; usedBy: string[] } {
	const byKey = new Map(modules.map((m) => [m.key, m]));
	const labelOf = (key: string) => byKey.get(key)?.label ?? key;
	const deps = module.requires.filter((key) => key !== "core");
	return {
		requires: deps.map(labelOf),
		missing: deps.filter((key) => byKey.get(key)?.state !== "on").map(labelOf),
		usedBy: modules
			.filter((m) => m.requires.includes(module.key) && m.state === "on")
			.map((m) => m.label),
	};
}

export function stateLabel(module: Module): string {
	if (module.state === "not_in_plan") return "Not in your subscription";
	if (module.state === "off_by_org") return "Off";
	return module.kind === "plan_gated" ? "Included" : "On";
}

export function joinLabels(labels: string[]): string {
	if (labels.length <= 1) return labels[0] ?? "";
	return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

// Only modules whose blocking records have a list page.
export const BLOCKER_LINKS: Record<string, { to: string; label: string }> = {
	purchasing: { to: "/dispatch/purchases", label: "View purchases" },
	field_purchases: { to: "/dispatch/purchases", label: "View purchases" },
};

export const SUBSCRIPTION_PATH = "/dispatch/admin?tab=entitlements";
