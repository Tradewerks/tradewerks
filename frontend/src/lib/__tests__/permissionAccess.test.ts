import { describe, it, expect } from "vitest";
import {
	activeOnly,
	isActiveUser,
	isPermissionEffective,
	moduleState,
	type EntitlementsData,
} from "../permissionAccess";
import {
	groupModules,
	joinLabels,
	meterText,
	meterTone,
	relationsOf,
	resetLabel,
	sentence,
	stateLabel,
	type Module,
} from "../moduleGroups";

const ent = (states: Record<string, "on" | "off_by_org" | "not_in_plan">): EntitlementsData => ({
	plan: { key: "p", version: 1, trialActive: false },
	modules: Object.entries(states).map(([key, state]) => ({
		key,
		label: key,
		description: "",
		kind: "optional",
		requires: [],
		state,
	})),
	permissionMap: {
		view_quotes: { module: "quotes", access: "read" },
		edit_quotes: { module: "quotes", access: "write" },
		view_jobs: { module: "core", access: "read" },
	},
	limits: {},
	usage: null,
});

describe("isPermissionEffective", () => {
	it("is permissive while entitlements are not loaded", () => {
		expect(isPermissionEffective("edit_quotes", undefined)).toBe(true);
		expect(moduleState(undefined, "quotes")).toBe("on");
	});
	it("on: unchanged", () => {
		expect(isPermissionEffective("edit_quotes", ent({ quotes: "on" }))).toBe(true);
	});
	it("off_by_org: read passes, write does not", () => {
		const e = ent({ quotes: "off_by_org" });
		expect(isPermissionEffective("view_quotes", e)).toBe(true);
		expect(isPermissionEffective("edit_quotes", e)).toBe(false);
	});
	it("not_in_plan: nothing passes", () => {
		expect(isPermissionEffective("view_quotes", ent({ quotes: "not_in_plan" }))).toBe(false);
	});
	it("a permission missing from the map is left alone", () => {
		expect(isPermissionEffective("brand_new_permission", ent({ quotes: "not_in_plan" }))).toBe(true);
	});
	it("a core permission passes even when core is absent from the response", () => {
		expect(isPermissionEffective("view_jobs", ent({ quotes: "not_in_plan" }))).toBe(true);
	});
	it("a module missing from the response counts as not in plan", () => {
		expect(moduleState(ent({}), "quotes")).toBe("not_in_plan");
	});
});

const mod = (key: string, over: Partial<Module> = {}): Module => ({
	key,
	label: key,
	description: "",
	kind: "optional",
	requires: [],
	state: "on",
	...over,
});

describe("moduleGroups", () => {
	it("orders known modules by group and puts unknown ones under Other", () => {
		const groups = groupModules([
			mod("vehicle_stock"),
			mod("brand_new_module"),
			mod("inventory"),
			mod("quotes"),
			mod("quickbooks", { kind: "plan_gated" }),
			mod("core", { kind: "core" }),
		]);
		expect(groups.map((g) => [g.label, g.modules.map((m) => m.key)])).toEqual([
			["Sales", ["quotes"]],
			["Parts & vehicles", ["inventory", "vehicle_stock"]],
			["Other", ["brand_new_module"]],
		]);
	});

	it("names only the missing requirement and only dependents that are on", () => {
		const modules = [
			mod("inventory", { label: "Inventory" }),
			mod("fleet", { label: "Fleet", state: "off_by_org" }),
			mod("vehicle_stock", {
				label: "Vehicle Stock",
				requires: ["inventory", "fleet"],
				state: "off_by_org",
			}),
			mod("purchasing", { label: "Purchasing", requires: ["inventory"] }),
		];
		expect(relationsOf(modules[2], modules)).toEqual({
			requires: ["Inventory", "Fleet"],
			missing: ["Fleet"],
			usedBy: [],
		});
		expect(relationsOf(modules[0], modules).usedBy).toEqual(["Purchasing"]);
	});

	it("ignores the core requirement", () => {
		const m = mod("quotes", { requires: ["core"] });
		expect(relationsOf(m, [m]).requires).toEqual([]);
	});

	it("labels each state in the agreed vocabulary", () => {
		expect(stateLabel(mod("a"))).toBe("On");
		expect(stateLabel(mod("a", { kind: "plan_gated" }))).toBe("Included");
		expect(stateLabel(mod("a", { state: "off_by_org" }))).toBe("Off");
		expect(stateLabel(mod("a", { state: "not_in_plan" }))).toBe("Not in your subscription");
	});

	it("joins labels and closes sentences once", () => {
		expect(joinLabels([])).toBe("");
		expect(joinLabels(["A"])).toBe("A");
		expect(joinLabels(["A", "B"])).toBe("A and B");
		expect(joinLabels(["A", "B", "C"])).toBe("A, B and C");
		expect(sentence("2 purchases not yet received")).toBe("2 purchases not yet received.");
		expect(sentence("Already closed.")).toBe("Already closed.");
	});
});

describe("active users (build plan 2)", () => {
	it("treats null or missing deactivated_at as active", () => {
		expect(isActiveUser({ deactivated_at: null })).toBe(true);
		expect(isActiveUser({})).toBe(true);
		expect(isActiveUser({ deactivated_at: "2026-10-06T00:00:00Z" })).toBe(false);
	});

	it("activeOnly keeps order and drops deactivated", () => {
		const list = [
			{ id: "a", deactivated_at: null },
			{ id: "b", deactivated_at: "2026-10-06T00:00:00Z" },
			{ id: "c", deactivated_at: null },
		];
		expect(activeOnly(list).map((u) => u.id)).toEqual(["a", "c"]);
	});
});

describe("usage meter helpers (build plan 2)", () => {
	it("tone: under 80 % normal, 80–99 % warning, at/over limit full, unlimited normal, limit 0 full", () => {
		expect(meterTone({ used: 79, limit: 100 })).toBe("normal");
		expect(meterTone({ used: 80, limit: 100 })).toBe("warning");
		expect(meterTone({ used: 100, limit: 100 })).toBe("full");
		expect(meterTone({ used: 7, limit: 5 })).toBe("full");
		expect(meterTone({ used: 9999, limit: null })).toBe("normal");
		expect(meterTone({ used: 0, limit: 0 })).toBe("full");
	});

	it("text", () => {
		expect(meterText({ used: 1200, limit: 2000 })).toBe("1,200 / 2,000");
		expect(meterText({ used: 4, limit: null })).toBe("4 · Unlimited");
	});

	it("reset label is the first of next month, UTC", () => {
		expect(resetLabel("2026-10-01")).toBe("Resets Nov 1");
		expect(resetLabel("2026-12-01")).toBe("Resets Jan 1");
	});
});
