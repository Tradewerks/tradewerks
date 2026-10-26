import { MODULES, getModule } from "./registry.js";

export interface BusinessType {
	key: string;
	label: string;
	// Every optional module, explicit: a module added to the registry later must be placed on purpose.
	moduleDefaults: Record<string, boolean>;
}

const ALL = [
	"quotes",
	"recurring_plans",
	"projects",
	"inventory",
	"fleet",
	"vehicle_stock",
	"purchasing",
	"field_purchases",
	"followups",
	"disputes",
];
const only = (...keys: string[]): Record<string, boolean> =>
	Object.fromEntries(ALL.map((k) => [k, keys.includes(k)]));
const except = (...off: string[]) => only(...ALL.filter((k) => !off.includes(k)));

// Display order for the register page.
export const BUSINESS_TYPES: readonly BusinessType[] = [
	{ key: "hvac", label: "HVAC", moduleDefaults: only(...ALL) },
	{ key: "plumbing", label: "Plumbing", moduleDefaults: only(...ALL) },
	{ key: "electrical", label: "Electrical", moduleDefaults: except("recurring_plans") },
	{
		key: "landscaping",
		label: "Landscaping",
		moduleDefaults: only("quotes", "recurring_plans", "fleet", "followups", "disputes"),
	},
	{
		key: "cleaning",
		label: "Cleaning",
		moduleDefaults: only("quotes", "recurring_plans", "followups", "disputes"),
	},
	{ key: "towing", label: "Towing", moduleDefaults: only("fleet", "disputes") },
	{ key: "general", label: "Other", moduleDefaults: except("followups") },
];

export const getBusinessType = (key: string) => BUSINESS_TYPES.find((t) => t.key === key);

export function businessTypeProblems(types: readonly BusinessType[] = BUSINESS_TYPES): string[] {
	const optional = MODULES.filter((m) => m.kind === "optional").map((m) => m.key);
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const t of types) {
		if (seen.has(t.key)) problems.push(`duplicate key ${t.key}`);
		seen.add(t.key);
		for (const k of optional)
			if (!(k in t.moduleDefaults)) problems.push(`${t.key}: missing ${k}`);
		for (const [k, value] of Object.entries(t.moduleDefaults)) {
			const def = getModule(k);
			if (!def || def.kind !== "optional") {
				problems.push(`${t.key}: unknown or non-optional ${k}`);
				continue;
			}
			if (!value) continue;
			for (const dep of def.requires)
				if (getModule(dep)?.kind === "optional" && t.moduleDefaults[dep] !== true)
					problems.push(`${t.key}: ${k} needs ${dep}`);
		}
	}
	return problems;
}

export function assertBusinessTypes(): void {
	const problems = businessTypeProblems();
	if (problems.length) throw new Error(`Business types invalid: ${problems.join("; ")}`);
}
