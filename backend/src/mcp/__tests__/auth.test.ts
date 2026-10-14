import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateUser, technicianFindUnique, dispatcherFindUnique, roleFindUnique } = vi.hoisted(() => ({
	authenticateUser: vi.fn(),
	technicianFindUnique: vi.fn(),
	dispatcherFindUnique: vi.fn(),
	roleFindUnique: vi.fn(),
}));

vi.mock("../../services/oauthService.js", () => ({ authenticateUser }));
vi.mock("../../db.js", () => ({
	db: {
		technician: { findUnique: technicianFindUnique },
		dispatcher: { findUnique: dispatcherFindUnique },
		organization_role: { findUnique: roleFindUnique },
	},
}));

import { AGENT_PERMISSION_CEILING } from "../../agent/policy.js";
import { authenticateFromEnv, McpAuthError } from "../auth.js";

const original = { ...process.env };

describe("authenticateFromEnv", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.MCP_USER_EMAIL = "dispatcher@example.com";
		process.env.MCP_USER_PASSWORD = "hunter2";
		dispatcherFindUnique.mockResolvedValue({ organization_role_id: "role-1", name: "Dana Reyes" });
		roleFindUnique.mockResolvedValue({ permissions: ["view_jobs", "delete_jobs"] });
	});
	afterEach(() => {
		process.env = { ...original };
	});

	it.each(["MCP_USER_EMAIL", "MCP_USER_PASSWORD"])("explains what to set when %s is missing", async (key) => {
		delete process.env[key];
		await expect(authenticateFromEnv()).rejects.toThrow(McpAuthError);
		await expect(authenticateFromEnv()).rejects.toThrow(/MCP_USER_EMAIL and MCP_USER_PASSWORD/);
	});

	it("refuses bad credentials without saying which half was wrong", async () => {
		authenticateUser.mockResolvedValue(null);
		await expect(authenticateFromEnv()).rejects.toThrow("Those credentials were not accepted.");
	});

	it("refuses an account with no organization", async () => {
		// Every tool receives an org-scoped client; there is nothing safe to scope to.
		authenticateUser.mockResolvedValue({ userId: "u1", role: "dispatcher", organizationId: null });
		await expect(authenticateFromEnv()).rejects.toThrow(/not attached to an organization/);
	});

	it("builds a context on the mcp surface", async () => {
		authenticateUser.mockResolvedValue({ userId: "u1", role: "dispatcher", organizationId: "org-1" });
		const ctx = await authenticateFromEnv();
		expect(ctx).toMatchObject({
			userId: "u1",
			role: "dispatcher",
			organizationId: "org-1",
			surface: "mcp",
			actorType: "dispatcher",
		});
	});

	it("applies the agent ceiling to the user's own permissions", async () => {
		authenticateUser.mockResolvedValue({ userId: "u1", role: "dispatcher", organizationId: "org-1" });
		const ctx = await authenticateFromEnv();
		expect(ctx.permissions).toContain("view_jobs");
		// Held by the role, withheld by the ceiling.
		expect(ctx.permissions).not.toContain("delete_jobs");
	});

	it("expands an admin's bypass and then trims it to the ceiling", async () => {
		// The same rule the HTTP surface follows: an admin's agent is not an admin.
		authenticateUser.mockResolvedValue({ userId: "a1", role: "admin", organizationId: "org-1" });
		const ctx = await authenticateFromEnv();
		expect(ctx.permissions.length).toBeGreaterThan(0);
		for (const permission of ctx.permissions) {
			expect(AGENT_PERMISSION_CEILING.has(permission)).toBe(true);
		}
		expect(ctx.permissions).not.toContain("manage_roles");
	});

	it("gives a user with no role no permissions at all", async () => {
		authenticateUser.mockResolvedValue({ userId: "u1", role: "dispatcher", organizationId: "org-1" });
		dispatcherFindUnique.mockResolvedValue({ organization_role_id: null, name: "Nobody" });
		const ctx = await authenticateFromEnv();
		expect(ctx.permissions).toEqual([]);
	});

	it("reads a technician's role from the technician table", async () => {
		authenticateUser.mockResolvedValue({ userId: "t1", role: "technician", organizationId: "org-1" });
		technicianFindUnique.mockResolvedValue({ organization_role_id: "role-2", name: "Sam" });
		roleFindUnique.mockResolvedValue({ permissions: ["view_assigned_jobs"] });

		const ctx = await authenticateFromEnv();

		expect(technicianFindUnique).toHaveBeenCalled();
		expect(ctx.actorType).toBe("technician");
		expect(ctx.permissions).toEqual(["view_assigned_jobs"]);
	});
});
