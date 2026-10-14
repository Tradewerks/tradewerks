import type { VisitStatus } from "../types/jobs";

export type VisitVerb = "drive" | "arrive" | "start" | "pause" | "resume" | "complete" | "delay";

/**
 * Mirrors LIFECYCLE_TRANSITIONS in
 * backend/src/controllers/jobVisitsController.ts. The dispatcher page needs the
 * from-sets to explain a shut action; the controller stays the enforcer.
 *
 * NOT lib/visitActionConstraints.ts — that encodes technician clock-in and
 * driving rules for the field app, which are a different question from whether
 * the transition itself is legal.
 */
export const VISIT_TRANSITIONS: Record<
	VisitVerb,
	{ from: readonly VisitStatus[]; to: VisitStatus }
> = {
	drive: { from: ["Scheduled", "Delayed"], to: "Driving" },
	arrive: { from: ["Driving"], to: "OnSite" },
	start: { from: ["OnSite"], to: "InProgress" },
	pause: { from: ["InProgress"], to: "Paused" },
	resume: { from: ["Paused"], to: "InProgress" },
	complete: { from: ["InProgress", "Paused", "OnSite"], to: "Completed" },
	delay: { from: ["Scheduled", "Driving", "OnSite"], to: "Delayed" },
};

export function canApplyVisitVerb(verb: VisitVerb, from: VisitStatus): boolean {
	return VISIT_TRANSITIONS[verb].from.includes(from);
}
