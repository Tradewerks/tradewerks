import { describe, it, expect } from "vitest";
import {
	MODULES,
	PERMISSION_MAP,
	assertRegistry,
	getModule,
	LIMIT_KEYS,
	METER_KEYS,
} from "../registry.js";
import { getAllPermissions } from "../../permissionCatalogs.js";
import { BUSINESS_TYPES, businessTypeProblems, getBusinessType } from "../businessTypes.js";

describe("entitlement registry", () => {
	it("owns every catalog permission exactly once with an access value", () => {
		for (const tier of ["dispatcher", "technician"] as const) {
			for (const perm of getAllPermissions(tier)) {
				expect(PERMISSION_MAP[perm], perm).toBeDefined();
				expect(["read", "write"]).toContain(
					PERMISSION_MAP[perm].access,
				);
			}
		}
		expect(() => assertRegistry()).not.toThrow();
	});

	it("declares only known modules in requires, with no cycles", () => {
		for (const m of MODULES) {
			for (const dep of m.requires)
				expect(getModule(dep), `${m.key} -> ${dep}`).toBeDefined();
		}
		expect(getModule("vehicle_stock")!.requires).toEqual([
			"inventory",
			"fleet",
		]);
	});

	it("keeps core permissions in core", () => {
		expect(PERMISSION_MAP.view_jobs).toEqual({
			module: "core",
			access: "read",
		});
		expect(PERMISSION_MAP.edit_quotes).toEqual({
			module: "quotes",
			access: "write",
		});
		expect(PERMISSION_MAP.stock_own_vehicle.module).toBe("vehicle_stock");
	});
});

describe("limit keys (build plan 2)", () => {
	it("names the five limit keys the seed and spec use", () => {
		expect([...LIMIT_KEYS].sort()).toEqual([
			"ai_calls_month",
			"dispatchers",
			"receipt_scans_month",
			"tax_lookups_month",
			"technicians",
		]);
	});

	it("meters are the monthly subset", () => {
		expect([...METER_KEYS].sort()).toEqual([
			"ai_calls_month",
			"receipt_scans_month",
			"tax_lookups_month",
		]);
		for (const m of METER_KEYS) expect(LIMIT_KEYS).toContain(m);
	});
});

describe("business types", () => {
	const optional = MODULES.filter((m) => m.kind === "optional").map((m) => m.key);
	const full = (over: Record<string, boolean> = {}) => ({
		...Object.fromEntries(optional.map((k) => [k, true])),
		...over,
	});

	it("the shipped list is valid", () => {
		expect(businessTypeProblems()).toEqual([]);
	});
	it("every type lists every optional module", () => {
		for (const t of BUSINESS_TYPES)
			expect(Object.keys(t.moduleDefaults).sort()).toEqual([...optional].sort());
	});
	it("general matches the old signup defaults", () => {
		expect(getBusinessType("general")?.moduleDefaults).toEqual(full({ followups: false }));
	});
	it("flags a missing module, an unknown or non-optional module, a broken requires and a duplicate key", () => {
		const { quotes: _q, ...missing } = full();
		const problems = businessTypeProblems([
			{ key: "a", label: "A", moduleDefaults: missing },
			{ key: "b", label: "B", moduleDefaults: { ...full(), nope: true, ai_assistant: true } },
			{ key: "c", label: "C", moduleDefaults: full({ inventory: false }) },
			{ key: "c", label: "C2", moduleDefaults: full() },
		]);
		expect(problems).toEqual(
			expect.arrayContaining([
				"a: missing quotes",
				"b: unknown or non-optional nope",
				"b: unknown or non-optional ai_assistant",
				"c: vehicle_stock needs inventory",
				"duplicate key c",
			]),
		);
	});
});
