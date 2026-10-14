import { JobStatusLabels } from "../../types/jobs";
import type { JobStatus } from "../../types/jobs";
import type { LifecycleAction } from "./types";
import { buildAction as build, NO_PERMISSION, notApplicable } from "./actionBuilder";

export const JOB_STEPS = ["Unscheduled", "Scheduled", "InProgress", "Completed"] as const;

export function isJobOffRamp(status: string): boolean {
	return status === "Cancelled";
}

/** The job's off-ramp is also its only ending; named for symmetry with the other catalogs. */
export const JOB_TERMINAL: readonly JobStatus[] = ["Cancelled"];

export function isJobTerminal(status: string): boolean {
	return (JOB_TERMINAL as readonly string[]).includes(status);
}

export interface JobActionContext {
	status: JobStatus;
	visitCount: number;
	/** Visits that are neither Completed nor Cancelled. Feeds the page's stat tile. */
	openVisitCount: number;
	canEdit: boolean;
	canCreateVisit: boolean;
	canCreateInvoice: boolean;
	handlers: Record<"scheduleVisit" | "invoice" | "cancel", () => void>;
}

const phrase = (s: JobStatus) => JobStatusLabels[s].toLowerCase();

const finished = (s: JobStatus) => s === "Completed" || s === "Cancelled";

/**
 * The job's offered actions, in a fixed order. Nothing here writes job.status:
 * jobVisitsController recomputes it from the visits on every visit write, so a
 * "Mark as Completed" button would be overwritten by the next visit save. The
 * levers that do move a job are its visits and its invoices.
 */
export function jobActions(ctx: JobActionContext): LifecycleAction[] {
	const visitReason = !ctx.canCreateVisit
		? NO_PERMISSION
		: finished(ctx.status)
			? notApplicable(
					`A ${phrase(ctx.status)} job can't take another visit. Reopen it by rescheduling an existing visit.`
				)
			: null;

	const invoiceReason = !ctx.canCreateInvoice
		? NO_PERMISSION
		: ctx.status === "Cancelled"
			? notApplicable("This job was cancelled.")
			: ctx.visitCount === 0
				? "This job has no visits yet, so there is nothing to invoice."
				: null;

	const cancelReason = !ctx.canEdit
		? NO_PERMISSION
		: ctx.status === "Cancelled"
			? notApplicable("This job is already cancelled.")
			: ctx.status === "Completed"
				? notApplicable(
						"This job is complete. Cancelling it would contradict its finished visits."
					)
				: null;

	return [
		build(
			"scheduleVisit",
			"Schedule Visit",
			"primary",
			visitReason,
			ctx.handlers.scheduleVisit
		),
		build("invoice", "Create Invoice", "primary", invoiceReason, ctx.handlers.invoice),
		build("cancel", "Cancel Job", "destructive", cancelReason, ctx.handlers.cancel),
	];
}
