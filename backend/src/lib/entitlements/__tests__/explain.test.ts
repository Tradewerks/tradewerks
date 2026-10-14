import { describe, it, expect } from "vitest";
import { explainEntitlements } from "../explain.js";
import { resolveEntitlements } from "../resolve.js";

const now = new Date("2026-10-07T12:00:00Z");
const plan = (modules: string[], limits: Record<string, number | null> = {}) => ({
	plan_key: "p",
	version: 1,
	modules,
	limits,
});
const row = (
	over: Partial<Parameters<typeof explainEntitlements>[0]> = {},
) => ({
	module_choices: {},
	module_grants: {},
	limit_overrides: {},
	trial_ends_at: null,
	...over,
});
const future = new Date("2026-10-21T23:59:59Z");
const past = new Date("2026-10-01T00:00:00Z");

describe("explainEntitlements", () => {
	it("plan_gated module in the tier is 'tier'", () => {
		const x = explainEntitlements(row(), plan(["quickbooks"]), null, now);
		expect(x.modules.quickbooks).toEqual({ state: "on", source: "tier" });
	});

	it("module only in the active trial tier is 'trial'", () => {
		const x = explainEntitlements(
			row({ trial_ends_at: future }),
			plan([]),
			plan(["quickbooks"]),
			now,
		);
		expect(x.modules.quickbooks).toEqual({ state: "on", source: "trial" });
	});

	it("expired trial falls back to the base tier", () => {
		const x = explainEntitlements(
			row({ trial_ends_at: past }),
			plan(["quickbooks"]),
			plan([]),
			now,
		);
		expect(x.modules.quickbooks.source).toBe("tier");
		expect(x.limits.dispatchers.trial).toBeUndefined();
	});

	it("module absent from the tier is 'not_in_tier'", () => {
		const x = explainEntitlements(row(), plan([]), null, now);
		expect(x.modules.projects).toEqual({ state: "not_in_plan", source: "not_in_tier" });
	});

	it("forced off reads 'grant_off' even though state is not_in_plan", () => {
		const x = explainEntitlements(
			row({ module_grants: { quickbooks: "off" } }),
			plan(["quickbooks"]),
			null,
			now,
		);
		expect(x.modules.quickbooks).toEqual({ state: "not_in_plan", source: "grant_off" });
	});

	it("forced on outside the tier is 'grant_on'", () => {
		const x = explainEntitlements(
			row({ module_grants: { quickbooks: "on" } }),
			plan([]),
			null,
			now,
		);
		expect(x.modules.quickbooks).toEqual({ state: "on", source: "grant_on" });
	});

	it("forced on but switched off by the org is 'org_off'", () => {
		const x = explainEntitlements(
			row({ module_grants: { quotes: "on" }, module_choices: { quotes: false } }),
			plan([]),
			null,
			now,
		);
		expect(x.modules.quotes).toEqual({ state: "off_by_org", source: "org_off" });
	});

	it("optional module in the tier but not chosen is 'org_off'", () => {
		const x = explainEntitlements(row(), plan(["quotes"]), null, now);
		expect(x.modules.quotes).toEqual({ state: "off_by_org", source: "org_off" });
	});

	it("chosen module whose dependency is off is 'requires' with blockedBy", () => {
		const x = explainEntitlements(
			row({ module_choices: { purchasing: true } }),
			plan(["purchasing"]),
			null,
			now,
		);
		expect(x.modules.purchasing).toEqual({
			state: "not_in_plan",
			source: "requires",
			blockedBy: "inventory",
		});
	});

	it("names the dependency that decided the state, not the first one that is off", () => {
		const x = explainEntitlements(
			row({ module_choices: { vehicle_stock: true, inventory: false } }),
			plan(["vehicle_stock", "inventory"]),
			null,
			now,
		);
		expect(x.modules.vehicle_stock).toEqual({
			state: "not_in_plan",
			source: "requires",
			blockedBy: "fleet",
		});
	});

	it("core modules are not listed", () => {
		const x = explainEntitlements(row(), plan([]), null, now);
		expect(x.modules.core).toBeUndefined();
	});

	it("limit breakdown: tier, trial, override, effective", () => {
		const x = explainEntitlements(
			row({ trial_ends_at: future, limit_overrides: { dispatchers: 8 } }),
			plan([], { dispatchers: 5 }),
			plan([], { dispatchers: 10 }),
			now,
		);
		expect(x.limits.dispatchers).toEqual({ tier: 5, trial: 10, override: 8, effective: 8 });
	});

	it("limit breakdown without trial or override omits those keys", () => {
		const x = explainEntitlements(row(), plan([], { dispatchers: 5 }), null, now);
		expect(x.limits.dispatchers).toEqual({ tier: 5, effective: 5 });
		expect(x.limits.technicians).toEqual({ tier: null, effective: null });
	});

	it("unlimited override is kept as null, not dropped", () => {
		const x = explainEntitlements(
			row({ limit_overrides: { dispatchers: null } }),
			plan([], { dispatchers: 5 }),
			null,
			now,
		);
		expect(x.limits.dispatchers).toEqual({ tier: 5, override: null, effective: null });
	});

	it("state and effective always equal resolveEntitlements", () => {
		const cases: Parameters<typeof explainEntitlements>[] = [
			[row(), plan(["quickbooks", "quotes", "purchasing"], { dispatchers: 3 }), null, now],
			[
				row({
					trial_ends_at: future,
					module_grants: { inventory: "on", quickbooks: "off" },
					module_choices: { purchasing: true, inventory: true },
					limit_overrides: { technicians: 2 },
				}),
				plan(["quotes"], { dispatchers: 3 }),
				plan(["purchasing", "quickbooks"], { dispatchers: null }),
				now,
			],
		];
		for (const args of cases) {
			const x = explainEntitlements(...args);
			const r = resolveEntitlements(...args);
			for (const [k, b] of Object.entries(x.modules)) expect(b.state).toBe(r.modules[k]);
			for (const [k, l] of Object.entries(x.limits))
				expect(l.effective).toBe(r.limits[k] ?? null);
		}
	});
});
