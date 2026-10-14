import { canTransitionRequest, isRequestTerminal } from "../../lib/requestTransitions";
import { RequestStatusLabels } from "../../types/requests";
import type { RequestStatus } from "../../types/requests";
import type { LifecycleAction } from "./types";
import { buildAction as build, NO_PERMISSION, notApplicable } from "./actionBuilder";
import type { ActionGate } from "./actionBuilder";

/**
 * The happy path, in order. The rejection state is absent on purpose:
 * QuoteRejected is a real destination a request can sit in and recover from,
 * not a step on the way anywhere.
 */
export const REQUEST_STEPS = ["New", "Reviewing", "Quoted", "QuoteApproved"] as const;

export const REQUEST_OFF_RAMPS: readonly RequestStatus[] = [
	"QuoteRejected",
	"ConvertedToJob",
	"Cancelled",
];

export function isRequestOffRamp(status: string): boolean {
	return (REQUEST_OFF_RAMPS as readonly string[]).includes(status);
}

/**
 * The off-ramps with no exits — the presentational fact the page's `stage`
 * needs. Narrower than REQUEST_OFF_RAMPS, because QuoteRejected still has legal
 * transitions. Kept apart from isRequestTerminal, which reads the backend's
 * transition table; the two name the same statuses today by assertion, not by
 * construction.
 */
export const REQUEST_TERMINAL_OFF_RAMPS: readonly RequestStatus[] = [
	"ConvertedToJob",
	"Cancelled",
];

export function isRequestTerminalOffRamp(status: string): boolean {
	return (REQUEST_TERMINAL_OFF_RAMPS as readonly string[]).includes(status);
}

/**
 * Off the happy path but not over: an off-ramp with a live exit. Derived from
 * the two off-ramp sets so a new status can't leave it behind.
 */
export function isRequestNonTerminalOffRamp(status: string): boolean {
	return isRequestOffRamp(status) && !isRequestTerminalOffRamp(status);
}

export interface RequestActionContext {
	status: RequestStatus;
	hasQuote: boolean;
	hasJob: boolean;
	/** The page's five-second New → Reviewing timer is armed. See reviewReason. */
	autoAdvancePending: boolean;
	canEdit: boolean;
	canCreateQuote: boolean;
	canCreateJob: boolean;
	handlers: Record<"review" | "quote" | "job" | "cancel", () => void>;
}

/** Lower-cased for mid-sentence use: "A converted to job request can't be…". */
const label = (status: RequestStatus) => RequestStatusLabels[status].toLowerCase();

function transition(ctx: RequestActionContext, to: RequestStatus): ActionGate {
	if (!ctx.canEdit) return NO_PERMISSION;
	if (isRequestTerminal(ctx.status)) {
		return notApplicable(`A ${label(ctx.status)} request can't be changed.`);
	}
	if (!canTransitionRequest(ctx.status, to)) {
		return notApplicable(`A ${label(ctx.status)} request can't be marked ${label(to)}.`);
	}
	return null;
}

function reviewReason(ctx: RequestActionContext): ActionGate {
	// Ahead of the transition gates so an armed timer reads as in flight rather
	// than as not allowed; a second write would race it.
	if (ctx.autoAdvancePending) {
		return "This request is being marked as reviewed automatically.";
	}
	return transition(ctx, "Reviewing");
}

/**
 * Hidden once the document exists, unlike quoteActions' convert: the request
 * page's relation cards already navigate there, so a live action would be a
 * second door to the same place.
 */
function quoteReason(ctx: RequestActionContext): ActionGate {
	if (ctx.hasQuote) return notApplicable("A quote has already been created from this request.");
	if (!ctx.canCreateQuote) return NO_PERMISSION;
	if (isRequestTerminal(ctx.status)) {
		return notApplicable(`A ${label(ctx.status)} request can't be quoted.`);
	}
	return null;
}

function jobReason(ctx: RequestActionContext): ActionGate {
	if (ctx.hasJob) return notApplicable("A job has already been created from this request.");
	if (!ctx.canCreateJob) return NO_PERMISSION;
	if (isRequestTerminal(ctx.status)) {
		return notApplicable(`A ${label(ctx.status)} request can't be converted to a job.`);
	}
	return null;
}

/**
 * The request's offered actions, in a fixed order. Every action is always
 * returned: ones that can't apply to the current state arrive hidden, ones the
 * dispatcher could unblock arrive disabled with the reason.
 */
export function requestActions(ctx: RequestActionContext): LifecycleAction[] {
	return [
		build("review", "Mark as Reviewing", "neutral", reviewReason(ctx), ctx.handlers.review),
		build(
			"quote",
			ctx.hasQuote ? "Quote Already Created" : "Convert to Quote",
			"primary",
			quoteReason(ctx),
			ctx.handlers.quote
		),
		build(
			"job",
			ctx.hasJob ? "Job Already Created" : "Convert to Job",
			"primary",
			jobReason(ctx),
			ctx.handlers.job
		),
		build(
			"cancel",
			"Cancel Request",
			"destructive",
			transition(ctx, "Cancelled"),
			ctx.handlers.cancel
		),
	];
}
