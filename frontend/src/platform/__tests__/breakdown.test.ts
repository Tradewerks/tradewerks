import { describe, expect, it } from "vitest";
import {
	appliedMessage,
	changedKeys,
	diffItems,
	initialMode,
	limitSourceLine,
	moduleSourceLine,
	nextOverride,
	tierContentsDiff,
} from "../breakdown";
import type { EntitlementBreakdown, TierVersion } from "../types";

const bd = (trial = false): EntitlementBreakdown => ({
	modules: {},
	limits: {} as EntitlementBreakdown["limits"],
	baseTier: { key: "pro", label: "Pro", version: 2 },
	trialTier: trial
		? { key: "max", label: "Max", version: 1, endsAt: "2026-10-21T00:00:00Z" }
		: null,
});
const label = (k: string) => ({ inventory: "Inventory", quickbooks: "QuickBooks" })[k] ?? k;
const version = (modules: string[], limits: Record<string, number | null>): TierVersion => ({
	id: "v",
	version: 1,
	modules,
	limits,
	note: null,
	created_at: "",
	org_count: 0,
	trial_org_count: 0,
});
const none = { gained: [], lost: [], raised: [], lowered: [] };

describe("moduleSourceLine", () => {
	it.each([
		["tier", undefined, false, "Included in Pro"],
		["trial", undefined, true, "Included in trial (Max)"],
		["not_in_tier", undefined, false, "Not in Pro"],
		["not_in_tier", undefined, true, "Not in Max"],
		["grant_on", undefined, false, "Forced on"],
		["grant_off", undefined, false, "Forced off"],
		["org_off", undefined, false, "Allowed · switched off by the organization"],
		["requires", "inventory", false, "Off · requires Inventory"],
	] as const)("%s", (source, blockedBy, trial, text) => {
		expect(moduleSourceLine({ state: "on", source, blockedBy }, bd(trial), label)).toBe(
			text
		);
	});
});

describe("limitSourceLine", () => {
	it("tier only", () => expect(limitSourceLine({ tier: 5, effective: 5 })).toBe("Tier 5"));
	it("trial", () =>
		expect(limitSourceLine({ tier: 5, trial: null, effective: null })).toBe(
			"Trial Unlimited (tier 5)"
		));
	it("override", () =>
		expect(limitSourceLine({ tier: 5, override: 8, effective: 8 })).toBe(
			"Override 8 · tier 5"
		));
	it("override during trial", () =>
		expect(limitSourceLine({ tier: 5, trial: 10, override: 8, effective: 8 })).toBe(
			"Override 8 · tier 5 · trial 10"
		));
});

describe("tierContentsDiff", () => {
	it("lists modules and limits that differ, null = unlimited", () => {
		const d = tierContentsDiff(
			version(["quickbooks"], { dispatchers: 5, technicians: null }),
			version(["inventory"], { dispatchers: 10, technicians: 3 })
		);
		expect(d.gained).toEqual(["inventory"]);
		expect(d.lost).toEqual(["quickbooks"]);
		expect(d.raised).toEqual([{ key: "dispatchers", from: 5, to: 10 }]);
		expect(d.lowered).toEqual([{ key: "technicians", from: null, to: 3 }]);
	});
});

describe("appliedMessage / diffItems", () => {
	const diff = {
		gained: ["inventory"],
		lost: ["quickbooks"],
		raised: [{ key: "dispatchers", from: 5, to: 10 }],
		lowered: [{ key: "technicians", from: 4, to: 2 }],
	};
	it("caps at three items", () =>
		expect(appliedMessage("Change tier", diff, label, false)).toBe(
			"Change tier · Inventory on · QuickBooks off · Dispatchers 5→10 · +1 more"
		));
	it("empty, deferred", () =>
		expect(appliedMessage("Change tier", none, label, true)).toBe(
			"Change tier · Saved. No change today."
		));
	it("empty", () => expect(appliedMessage("X", none, label, false)).toBe("X · Saved."));
	it("order: gained, lost, raised, lowered", () =>
		expect(diffItems(diff, label)).toEqual([
			"Inventory on",
			"QuickBooks off",
			"Dispatchers 5→10",
			"Technicians 4→2",
		]));
});

describe("changedKeys", () => {
	it("includes diff keys and the change's own target", () => {
		expect([
			...changedKeys(none, { kind: "grant", module: "quotes", grant: "on" }),
		]).toEqual(["quotes"]);
		expect([
			...changedKeys(
				{ ...none, raised: [{ key: "dispatchers", from: 1, to: 2 }] },
				{ kind: "limit", key: "dispatchers", override: 2 }
			),
		]).toEqual(["dispatchers"]);
	});
});

describe("limit modes", () => {
	it("initialMode", () => {
		expect(initialMode(undefined)).toBe("tier");
		expect(initialMode(null)).toBe("unlimited");
		expect(initialMode(3)).toBe("custom");
	});
	it("nextOverride", () => {
		expect(nextOverride("tier", "", undefined)).toBeUndefined();
		expect(nextOverride("tier", "", 4)).toBe("tier");
		expect(nextOverride("unlimited", "", null)).toBeUndefined();
		expect(nextOverride("unlimited", "", 4)).toBeNull();
		expect(nextOverride("custom", "0", undefined)).toBe(0);
		expect(nextOverride("custom", "", undefined)).toBeUndefined();
		expect(nextOverride("custom", "-1", undefined)).toBeUndefined();
		expect(nextOverride("custom", "1.5", undefined)).toBeUndefined();
		expect(nextOverride("custom", "4", 4)).toBeUndefined();
		expect(nextOverride("custom", "6", 4)).toBe(6);
	});
});
