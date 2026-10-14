import { describe, expect, it } from "vitest";

import { getAllPermissions } from "../../lib/permissionCatalogs.js";
import {
	AGENT_PERMISSION_CEILING,
	actorTypeForRole,
	expandUserPermissions,
	resolveAgentPermissions,
} from "../policy.js";

describe("agent permission ceiling", () => {
	it("expands admin into the concrete dispatcher catalog rather than a bypass sentinel", () => {
		// The whole point: requirePermissions treats admin as null/"allow all".
		// The agent layer must turn that into a list it can intersect.
		expect(expandUserPermissions("admin", [])).toEqual(getAllPermissions("dispatcher"));
	});

	it("gives an admin's agent strictly less than the admin", () => {
		const admin = new Set(expandUserPermissions("admin", []));
		const agent = resolveAgentPermissions("admin", []);
		expect(agent.length).toBeGreaterThan(0);
		expect(agent.length).toBeLessThan(admin.size);
		for (const p of agent) expect(admin.has(p)).toBe(true);
	});

	it.each([
		"delete_jobs",
		"delete_clients",
		"delete_quotes",
		"delete_invoices",
		"manage_roles",
		"manage_organization",
		"manage_technicians",
		"manage_dispatchers",
		"manage_taxes",
		"view_admin",
	])("never grants %s, even to an admin", (permission) => {
		expect(AGENT_PERMISSION_CEILING.has(permission)).toBe(false);
		expect(resolveAgentPermissions("admin", [])).not.toContain(permission);
	});

	it.each(["check_in", "check_out", "update_visit_status", "stock_own_vehicle", "adjust_field_loss"])(
		"never grants %s — it asserts a human was physically somewhere",
		(permission) => {
			expect(AGENT_PERMISSION_CEILING.has(permission)).toBe(false);
			expect(resolveAgentPermissions("technician", [permission])).not.toContain(permission);
		},
	);

	it("never grants a dispatcher's agent something the dispatcher lacks", () => {
		const held = ["view_jobs", "view_clients"];
		expect(resolveAgentPermissions("dispatcher", held).sort()).toEqual([...held].sort());
	});

	it("intersects rather than unions — a permission outside the ceiling is dropped", () => {
		const resolved = resolveAgentPermissions("dispatcher", ["view_jobs", "delete_jobs", "manage_roles"]);
		expect(resolved).toEqual(["view_jobs"]);
	});

	it("treats absent permissions as none, not as everything", () => {
		expect(resolveAgentPermissions("dispatcher", null)).toEqual([]);
		expect(resolveAgentPermissions("dispatcher", undefined)).toEqual([]);
		expect(resolveAgentPermissions("technician", [])).toEqual([]);
	});

	it("honours a caller-supplied ceiling", () => {
		const narrow = new Set(["view_jobs"]);
		expect(resolveAgentPermissions("admin", [], narrow)).toEqual(["view_jobs"]);
	});

	it.each([
		["admin", "dispatcher"],
		["dispatcher", "dispatcher"],
		["technician", "technician"],
	])("audits %s under the %s bucket", (role, bucket) => {
		expect(actorTypeForRole(role)).toBe(bucket);
	});
});
