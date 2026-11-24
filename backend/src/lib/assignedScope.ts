import type { Request } from "express";
import { hasPermission } from "./requirePermissions.js";

// view_visits is deliberately not here: the default Technician role holds it to
// reach the Visits tab, and view_assigned_jobs vs view_all_jobs is what says
// which jobs and visits that tab may show.
export const SEES_EVERY_JOB = ["view_jobs", "view_all_jobs"];

/** Same rule as assignedOnly, for callers holding a resolved permission list (the agent). */
export const assignedOnlyFor = (permissions: readonly string[]): boolean =>
	!SEES_EVERY_JOB.some((p) => permissions.includes(p));

export function assignedOnly(req: Request): boolean {
	return !SEES_EVERY_JOB.some((p) => hasPermission(req, p));
}

/** The caller's id when they are assigned-only; undefined means unfiltered. */
export const assignedTechId = (req: Request): string | undefined =>
	assignedOnly(req) ? (req.user!.uid as string) : undefined;

export const jobAssignedWhere = (uid: string) => ({
	visits: { some: { visit_techs: { some: { tech_id: uid } } } },
});

export const visitAssignedWhere = (uid: string) => ({
	visit_techs: { some: { tech_id: uid } },
});

// techOnNote's rule: job-level notes, or notes on one of the caller's visits.
export const noteAssignedWhere = (uid: string) => ({
	OR: [{ visit_id: null }, { visit: visitAssignedWhere(uid) }],
});

// The Available tab's pool: scheduled work nobody has taken. A visit already
// under way with its techs removed is a dispatcher's problem, not a pickup.
export const visitClaimableWhere = {
	visit_techs: { none: {} },
	status: "Scheduled" as const,
};
