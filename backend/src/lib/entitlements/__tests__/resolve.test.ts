import { describe, it, expect } from "vitest";
import {
	resolveEntitlements,
	isPermissionEffective,
	isAccessAllowed,
} from "../resolve.js";
import { offWindows } from "../windows.js";

const now = new Date("2026-10-05T12:00:00Z");
const plan = (modules: string[], limits = {}) => ({
	plan_key: "p",
	version: 1,
	modules,
	limits,
});
const row = (
	over: Partial<Parameters<typeof resolveEntitlements>[0]> = {},
) => ({
	module_choices: {},
	module_grants: {},
	limit_overrides: {},
	trial_ends_at: null,
	...over,
});

describe("resolveEntitlements", () => {
	it("core is always on", () => {
		expect(
			resolveEntitlements(row(), plan([]), null, now).modules.core,
		).toBe("on");
	});

	it("optional modules are off until chosen; plan_gated are on when included", () => {
		const r = resolveEntitlements(
			row(),
			plan(["quotes", "quickbooks"]),
			null,
			now,
		);
		expect(r.modules.quotes).toBe("off_by_org");
		expect(r.modules.quickbooks).toBe("on");
		expect(r.modules.projects).toBe("not_in_plan");
	});

	it("org choice turns an allowed module on or off", () => {
		const r = resolveEntitlements(
			row({ module_choices: { quotes: true, quickbooks: false } }),
			plan(["quotes", "quickbooks"]),
			null,
			now,
		);
		expect(r.modules.quotes).toBe("on");
		expect(r.modules.quickbooks).toBe("off_by_org");
	});

	it("an org cannot switch on a module outside its plan", () => {
		const r = resolveEntitlements(
			row({ module_choices: { ai_assistant: true } }),
			plan([]),
			null,
			now,
		);
		expect(r.modules.ai_assistant).toBe("not_in_plan");
	});

	it("staff grants add and remove", () => {
		const r = resolveEntitlements(
			row({ module_grants: { ai_assistant: "on", quickbooks: "off" } }),
			plan(["quickbooks"]),
			null,
			now,
		);
		expect(r.modules.ai_assistant).toBe("on");
		expect(r.modules.quickbooks).toBe("not_in_plan");
	});

	it("a module takes the state of an unmet dependency", () => {
		const choices = { purchasing: true, vehicle_stock: true, fleet: true };
		const off = resolveEntitlements(
			row({ module_choices: choices }),
			plan(["inventory", "purchasing", "fleet", "vehicle_stock"]),
			null,
			now,
		);
		expect(off.modules.purchasing).toBe("off_by_org");
		expect(off.modules.vehicle_stock).toBe("off_by_org");
		const out = resolveEntitlements(
			row({ module_choices: choices }),
			plan(["purchasing", "fleet", "vehicle_stock"]),
			null,
			now,
		);
		expect(out.modules.purchasing).toBe("not_in_plan");
	});

	it("a dependency only degrades a module that is on", () => {
		const unchosen = resolveEntitlements(
			row(),
			plan(["purchasing"]),
			null,
			now,
		);
		expect(unchosen.modules.purchasing).toBe("off_by_org");
		const both = resolveEntitlements(
			row({ module_choices: { vehicle_stock: true } }),
			plan(["fleet", "vehicle_stock"]),
			null,
			now,
		);
		expect(both.modules.vehicle_stock).toBe("not_in_plan");
	});

	it("uses the trial version until trial_ends_at, exclusive", () => {
		const trial = plan(["quickbooks"]);
		const active = resolveEntitlements(
			row({ trial_ends_at: new Date("2026-10-05T12:00:01Z") }),
			plan([]),
			trial,
			now,
		);
		expect(active.trialActive).toBe(true);
		expect(active.modules.quickbooks).toBe("on");
		const atBoundary = resolveEntitlements(
			row({ trial_ends_at: now }),
			plan([]),
			trial,
			now,
		);
		expect(atBoundary.trialActive).toBe(false);
		expect(atBoundary.modules.quickbooks).toBe("not_in_plan");
	});

	it("overlays limit overrides and ignores unknown keys", () => {
		const r = resolveEntitlements(
			row({
				limit_overrides: { technicians: 50 },
				module_choices: { nonsense: true },
			}),
			plan(["nonsense"], { technicians: 5, dispatchers: 3 }),
			null,
			now,
		);
		expect(r.limits).toEqual({ technicians: 50, dispatchers: 3 });
		expect(r.modules.nonsense).toBeUndefined();
	});
});

describe("permission effectiveness", () => {
	const modules = {
		core: "on",
		quotes: "off_by_org",
		ai_assistant: "not_in_plan",
		inventory: "not_in_plan",
	} as const;
	it("read survives off_by_org; write does not", () => {
		expect(isPermissionEffective("view_quotes", modules)).toBe(true);
		expect(isPermissionEffective("edit_quotes", modules)).toBe(false);
	});
	it("nothing survives not_in_plan", () => {
		expect(isPermissionEffective("view_inventory", modules)).toBe(false);
	});
	it("an unknown permission is left ungated", () => {
		expect(isPermissionEffective("some_future_permission", modules)).toBe(
			true,
		);
	});
	it("isAccessAllowed matches the table", () => {
		expect(isAccessAllowed("on", "write")).toBe(true);
		expect(isAccessAllowed("off_by_org", "read")).toBe(true);
		expect(isAccessAllowed("off_by_org", "write")).toBe(false);
		expect(isAccessAllowed("not_in_plan", "read")).toBe(false);
	});
});

describe("offWindows", () => {
	const at = (iso: string) => new Date(iso);
	const change = (iso: string, old: boolean | undefined, next: boolean) => ({
		at: at(iso),
		old: old === undefined ? {} : { quotes: old },
		next: { quotes: next },
	});

	it("pairs each switch-off with the next switch-on", () => {
		const w = offWindows(
			[
				change("2026-01-01T00:00:00Z", true, false),
				change("2026-01-05T00:00:00Z", false, true),
				change("2026-02-01T00:00:00Z", true, false),
				change("2026-02-03T00:00:00Z", false, true),
			],
			"quotes",
		);
		expect(w).toEqual([
			{ off: at("2026-01-01T00:00:00Z"), on: at("2026-01-05T00:00:00Z") },
			{ off: at("2026-02-01T00:00:00Z"), on: at("2026-02-03T00:00:00Z") },
		]);
	});

	it("leaves a window open while the module is still off", () => {
		expect(offWindows([change("2026-01-01T00:00:00Z", true, false)], "quotes")).toEqual([
			{ off: at("2026-01-01T00:00:00Z"), on: null },
		]);
	});

	it("ignores a switch-on that has no earlier switch-off", () => {
		expect(offWindows([change("2026-01-05T00:00:00Z", false, true)], "quotes")).toEqual([]);
		expect(offWindows([change("2026-01-05T00:00:00Z", undefined, true)], "quotes")).toEqual([]);
	});

	it("sorts by time and ignores rows that do not change the module", () => {
		const w = offWindows(
			[
				change("2026-01-05T00:00:00Z", false, true),
				{
					at: at("2026-01-03T00:00:00Z"),
					old: { quotes: false, projects: true },
					next: { quotes: false, projects: false },
				},
				change("2026-01-01T00:00:00Z", true, false),
			],
			"quotes",
		);
		expect(w).toEqual([{ off: at("2026-01-01T00:00:00Z"), on: at("2026-01-05T00:00:00Z") }]);
	});
});
