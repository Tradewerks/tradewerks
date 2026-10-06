/**
 * Building an `AgentContext` from a verified token.
 *
 * Identity comes from JWT claims and nothing else — the same rule
 * `lib/context.ts:getUserContext` follows, and for the same reason: anything a
 * caller can set, a caller can forge. An MCP client and the in-app assistant
 * both arrive here, so this is the one place the ceiling gets applied.
 */

import { db } from "../db.js";
import { getEntitlements } from "../services/entitlementService.js";
import { isPermissionEffective, type ModuleState } from "../lib/entitlements/resolve.js";
import { actorTypeForRole, resolveAgentPermissions } from "./policy.js";
import type { AgentContext, AgentSurface } from "./types.js";

/** The verified claim subset an agent context needs. Matches `Express.Request["user"]`. */
export interface AgentClaims {
	uid: string;
	role: string;
	organization_id: string | null;
	permissions: string[] | null;
}

export class AgentContextError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentContextError";
	}
}

/**
 * Resolve the caller's display name for audit rows. One query per conversation,
 * not per tool call — callers should build a context once and reuse it.
 */
async function resolveUserName(userId: string, role: string): Promise<string | undefined> {
	const row =
		role === "technician"
			? await db.technician.findUnique({ where: { id: userId }, select: { name: true } })
			: await db.dispatcher.findUnique({ where: { id: userId }, select: { name: true } });
	return row?.name ?? undefined;
}

export async function buildAgentContext(
	claims: AgentClaims,
	surface: AgentSurface,
	opts: { ipAddress?: string; userAgent?: string } = {},
): Promise<AgentContext> {
	if (!claims.uid) throw new AgentContextError("Token carries no user id");
	// Every tool receives an org-scoped client. Without an org there is nothing
	// safe to scope to, so refuse rather than fall back to an unscoped client.
	if (!claims.organization_id) throw new AgentContextError("Agent access requires an organization");

	// Tools decide what they offer from `permissions`, per record type as well as
	// per tool, so dropping the permissions of modules the org cannot use here
	// closes those tools on the assistant and on MCP, which passes no route gate.
	const modules = await getEntitlements(claims.organization_id)
		.then((e) => e.modules)
		.catch((): Record<string, ModuleState> => ({ core: "on" }));

	return {
		userId: claims.uid,
		role: claims.role,
		organizationId: claims.organization_id,
		permissions: resolveAgentPermissions(claims.role, claims.permissions).filter((p) =>
			isPermissionEffective(p, modules),
		),
		actorType: actorTypeForRole(claims.role),
		surface,
		userName: await resolveUserName(claims.uid, claims.role),
		ipAddress: opts.ipAddress,
		userAgent: opts.userAgent,
	};
}
