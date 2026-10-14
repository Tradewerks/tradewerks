/**
 * Establishing who a local MCP session acts as.
 *
 * The stdio server runs on someone's own machine, in the same repo, against the
 * same database — it already has DATABASE_URL. So this credential check is not
 * guarding the data; anyone who can start the process could read the tables
 * directly. What it establishes is *identity*: which user, which organization,
 * and therefore which permissions the agent ceiling gets intersected with.
 *
 * That distinction is why email and password in a config file is acceptable here
 * and would not be over the network. The remote HTTP transport (Phase 4b) uses
 * the OAuth server instead, and none of this code is involved.
 */

import { authenticateUser } from "../services/oauthService.js";
import { buildAgentContext } from "../agent/context.js";
import { getAllPermissions } from "../lib/permissionCatalogs.js";
import { db } from "../db.js";
import type { AgentContext } from "../agent/types.js";

export class McpAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpAuthError";
	}
}

/**
 * Resolve the permissions a user actually holds.
 *
 * `authenticateUser` returns identity but not permissions, and the agent layer
 * needs a concrete list to intersect with its ceiling — including for admins,
 * whose "unlimited" is expanded rather than honoured (see agent/policy.ts).
 */
async function permissionsFor(userId: string, role: string): Promise<string[]> {
	if (role === "admin") return getAllPermissions("dispatcher");

	const user =
		role === "technician"
			? await db.technician.findUnique({ where: { id: userId }, select: { organization_role_id: true } })
			: await db.dispatcher.findUnique({ where: { id: userId }, select: { organization_role_id: true } });

	if (!user?.organization_role_id) return [];

	const orgRole = await db.organization_role.findUnique({
		where: { id: user.organization_role_id },
		select: { permissions: true },
	});
	return orgRole?.permissions ?? [];
}

/**
 * Sign in from the environment and build the context every tool call runs under.
 *
 * Done once at startup rather than per call: the session's identity does not
 * change, and re-checking a password on every tool call would be theatre.
 */
export async function authenticateFromEnv(): Promise<AgentContext> {
	const email = process.env.MCP_USER_EMAIL;
	const password = process.env.MCP_USER_PASSWORD;

	if (!email || !password) {
		throw new McpAuthError(
			"Set MCP_USER_EMAIL and MCP_USER_PASSWORD to the dispatcher account this server should act as.",
		);
	}

	const user = await authenticateUser(email, password);
	if (!user) {
		throw new McpAuthError("Those credentials were not accepted.");
	}
	if (!user.organizationId) {
		throw new McpAuthError("That account is not attached to an organization.");
	}

	return buildAgentContext(
		{
			uid: user.userId,
			role: user.role,
			organization_id: user.organizationId,
			permissions: await permissionsFor(user.userId, user.role),
		},
		"mcp",
		{ userAgent: "mcp-stdio" },
	);
}
