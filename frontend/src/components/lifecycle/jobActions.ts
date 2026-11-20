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
	/** Job-level line items, billable without a visit. */
	lineItemCount: number;
	/** Visits that are neither Completed nor Cancelled. Feeds the page's stat tile. */
	openVisitCount: number;
	/** Visits that reached Completed; they stay billable after the job is cancelled. */
	completedVisitCount: number;
	canEdit: boolean;
	canCreateVisit: boolean;
	canCreateInvoice: boolean;
	handlers: Record<"scheduleVisit" | "invoice" | "cancel", () => void>;
}

/**
 * The job's offered actions, in a fixed order. Nothing here writes job.status:
 * the backend derives it from the visits on every visit status change, so a
 * "Mark as Completed" button would be overwritten by the next visit save. The
 * levers that do move a job are its visits and its invoices.
 */
export function jobActions(ctx: JobActionContext): LifecycleAction[] {
	const visitReason = !ctx.canCreateVisit ? NO_PERMISSION : null;

	const invoiceReason = !ctx.canCreateInvoice
		? NO_PERMISSION
		: ctx.status === "Cancelled" && ctx.completedVisitCount === 0
			? notApplicable("This job was cancelled before any visit was completed.")
			: ctx.visitCount === 0 && ctx.lineItemCount === 0
				? "This job has no visits or line items yet, so there is nothing to invoice."
				: null;

	const cancelReason = !ctx.canEdit
		? NO_PERMISSION
		: ctx.status === "Cancelled"
			? notApplicable("This job is already cancelled.")
			: ctx.status === "Completed"
				? notApplicable(
						"This job is complete. Cancel its invoice instead."
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
