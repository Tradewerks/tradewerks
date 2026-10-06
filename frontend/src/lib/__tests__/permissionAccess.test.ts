import { describe, it, expect } from "vitest";
import { isPermissionEffective, moduleState, type EntitlementsData } from "../permissionAccess";
import {
	groupModules,
	joinLabels,
	relationsOf,
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
