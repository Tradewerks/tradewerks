import { describe, it, expect } from "vitest";
import {
	MODULES,
	PERMISSION_MAP,
	assertRegistry,
	getModule,
} from "../registry.js";
import { getAllPermissions } from "../../permissionCatalogs.js";

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
