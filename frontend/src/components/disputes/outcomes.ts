import type { DisputeKind, DisputeOutcomeState, DisputeResolution } from "../../types/disputes";

export interface OutcomeOption {
	id: DisputeResolution;
	label: string;
	blurb: string;
	disabled: boolean;
	disabledReason?: string;
	destructive: boolean;
}

/** The dispatcher-facing name of each outcome. Read by outcomesFor below and
 *  by LifecycleRecord, which names a resolved dispute's outcome. */
export const OUTCOME_LABELS: Record<DisputeResolution, string> = {
	ReviseAndResend: "Revise & Resend",
	IssueAdjustment: "Issue Adjustment",
	Repeal: "Repeal",
};

const BLURBS: Record<DisputeKind, Record<DisputeResolution, string>> = {
	quote: {
		ReviseAndResend: "Create a new version of this quote. The original is marked superseded.",
		IssueAdjustment: "Record a correcting document against the original.",
		Repeal: "Cancel this quote permanently. No replacement is created.",
	},
	invoice: {
		ReviseAndResend: "Void this invoice and issue a replacement. Only possible before any payment.",
		IssueAdjustment:
			"Write a linked correcting document. The original is never altered. A negative adjustment is a credit.",
		Repeal: "Void this invoice permanently. No replacement is created.",
	},
};

/**
 * Words and styling for the server's judgement of each outcome. Which ones are
 * open, and why the rest are closed, arrive with the dispute: the same code
 * that refuses a submit produced them, so nothing here restates a rule.
 *
 * Closed outcomes stay in the list rather than being omitted. A dispatcher who
 * can see why an option is closed learns the rule; one who sees a shorter list
 * learns nothing.
 */
export function outcomesFor(
	kind: DisputeKind,
	states: readonly DisputeOutcomeState[]
): OutcomeOption[] {
	return states.map((state) => ({
		id: state.id,
		label: OUTCOME_LABELS[state.id],
		blurb: BLURBS[kind][state.id],
		disabled: state.disabled,
		disabledReason: state.reason ?? undefined,
		destructive: state.id === "Repeal",
	}));
}
