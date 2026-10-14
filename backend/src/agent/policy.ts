/**
 * The agent permission ceiling.
 *
 * `requirePermissions.resolvePerms()` returns `null` for the admin role, which
 * every permission check in the app reads as "allow everything". That is right
 * for a human admin driving a UI they can see. It is wrong for an agent: it
 * would mean an admin's assistant has no upper bound at all, and a single
 * mis-selected tool call could delete an organization.
 *
 * So the agent layer does not inherit the bypass. Instead:
 *
 *   effective = expand(role, userPermissions) ∩ AGENT_PERMISSION_CEILING
 *
 * An admin's agent gets the full dispatcher catalog — then the ceiling trims it.
 * A dispatcher's agent gets their own permissions — then the same ceiling trims
 * it. The agent can therefore never do something the human could not, and never
 * does the most dangerous things even when the human could.
 *
 * Adding a permission here is a deliberate act. The exclusions at the bottom of
 * this file are the point of the module, not an oversight.
 */

import { getAllPermissions } from "../lib/permissionCatalogs.js";

/**
 * Permissions an agent may ever hold, across every phase.
 *
 * Entries are present because a tool needs them, or is planned to. Read
 * permissions are broad — an agent that cannot see the schedule is useless.
 * Write permissions are narrower and gated a second time by `AgentPolicy`.
 */
export const AGENT_PERMISSION_CEILING: ReadonlySet<string> = new Set([
	// ── Dispatcher reads ────────────────────────────────────────────────
	"view_jobs",
	"view_requests",
	"view_quotes",
	"view_invoices",
	"view_clients",
	"view_inventory",
	"view_reports",
	"view_recurring_plans",
	"view_technicians",
	"view_dispatchers",
	"view_vehicles",
	"view_followups",
	"view_projects",

	// ── Technician reads ────────────────────────────────────────────────
	"view_assigned_jobs",
	"view_all_jobs",
	"view_visits",
	"view_own_schedule",
	"view_team_schedule",
	"view_forms",

	// ── Writes (enabled per-policy from Phase 3; ceiling-eligible now) ───
	"create_jobs",
	"edit_jobs",
	"create_requests",
	"edit_requests",
	"create_quotes",
	"edit_quotes",
	"create_clients",
	"edit_clients",
	"create_invoices",
	"edit_invoices",
	"create_projects",
	"edit_projects",
	"manage_inventory",
	"manage_recurring_plans",
	"manage_followups",
	"export_reports",
	"add_job_notes",
	"update_job_status",
]);

/**
 * Deliberately absent from the ceiling — documented so that a future reader
 * knows these were considered and refused, rather than forgotten:
 *
 *   delete_jobs · delete_requests · delete_quotes · delete_invoices
 *   delete_clients · delete_projects
 *       Irreversible. A human deletes records in this product, not an agent.
 *
 *   manage_roles · manage_organization · manage_technicians · manage_dispatchers
 *       Privilege escalation surface. An agent that can edit roles can grant
 *       itself anything the ceiling withholds.
 *
 *   manage_taxes · view_admin
 *       Financial and administrative configuration with org-wide blast radius.
 *
 *   check_in · check_out · update_visit_status
 *       Assert physical presence of a technician at a site. An agent must not
 *       be able to claim someone arrived somewhere.
 *
 *   stock_own_vehicle · complete_own_restock · adjust_* · use_inventory
 *       Same reasoning: they record what a human physically did.
 */

/** Roles whose agent activity is audited under the dispatcher bucket. */
const DISPATCHER_ROLES = new Set(["dispatcher", "admin"]);

/**
 * The permissions a role could hold before the ceiling is applied.
 *
 * Admin is expanded to the full dispatcher catalog rather than left as the
 * `null` sentinel — the ceiling can only intersect a concrete set, and turning
 * "unlimited" into an explicit list is precisely the point.
 */
export function expandUserPermissions(role: string, permissions: readonly string[] | null | undefined): string[] {
	if (role === "admin") return getAllPermissions("dispatcher");
	if (role === "technician") return [...(permissions ?? [])];
	return [...(permissions ?? [])];
}

/**
 * user permissions ∩ ceiling. The only function that should ever produce the
 * `permissions` field of an `AgentContext`.
 */
export function resolveAgentPermissions(
	role: string,
	permissions: readonly string[] | null | undefined,
	ceiling: ReadonlySet<string> = AGENT_PERMISSION_CEILING,
): string[] {
	const held = new Set(expandUserPermissions(role, permissions));
	// Iterate the ceiling, not the user's set: the result is then bounded by the
	// ceiling's size no matter how permissions grow, and stays in a stable order.
	return [...ceiling].filter((p) => held.has(p));
}

/** Which audit bucket a role's agent activity belongs to. */
export function actorTypeForRole(role: string): "dispatcher" | "technician" {
	return DISPATCHER_ROLES.has(role) ? "dispatcher" : "technician";
}

/**
 * Reads only. The safe default, and what a caller gets if nobody chose.
 *
 * A write tool executed under this policy fails closed rather than running, so
 * a tool registered before its approval flow exists cannot do damage.
 */
export const READ_ONLY_POLICY = {
	allowWrites: false,
	allowDestructive: false,
	ceiling: AGENT_PERMISSION_CEILING,
} as const;

/**
 * Reads and writes; still no destructive actions.
 *
 * "Write" here does not mean unattended. Every scheduling tool sets
 * `requiresApproval`, so this policy permits the agent to *propose* a change and
 * nothing more — the executor still refuses to run one without a human decision.
 * What this policy actually unlocks is the tools being advertised to the model
 * at all.
 *
 * Destructive stays off: deletes, client emails and invoice issuance are not
 * things this system lets an agent do, whoever is asking. That is enforced twice
 * over — the ceiling withholds every `delete_*` permission as well.
 */
export const WRITE_POLICY = {
	allowWrites: true,
	allowDestructive: false,
	ceiling: AGENT_PERMISSION_CEILING,
} as const;
