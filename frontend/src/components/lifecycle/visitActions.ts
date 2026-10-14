import { canApplyVisitVerb, VISIT_TRANSITIONS } from "../../lib/visitTransitions";
import type { VisitVerb } from "../../lib/visitTransitions";
import { VisitStatusLabels } from "../../types/jobs";
import type { VisitStatus } from "../../types/jobs";
import type { LifecycleAction } from "./types";
import { buildAction as build, NO_PERMISSION, notApplicable } from "./actionBuilder";
import type { ActionGate } from "./actionBuilder";

/**
 * The happy path, in order. Paused and Delayed are absent: both are returns to
 * a step already passed, so placing them on the path would draw a visit that
 * pauses as moving forward.
 */
export const VISIT_STEPS = ["Scheduled", "Driving", "OnSite", "InProgress", "Completed"] as const;

export const VISIT_OFF_RAMPS: readonly VisitStatus[] = ["Paused", "Delayed", "Cancelled"];

export function isVisitOffRamp(status: string): boolean {
	return (VISIT_OFF_RAMPS as readonly string[]).includes(status);
}

/**
 * Paused and Delayed are return trips, not endings — each has a live exit in
 * the bar's action row. Only a cancelled visit has stopped.
 */
export const VISIT_TERMINAL: readonly VisitStatus[] = ["Cancelled"];

export function isVisitTerminal(status: string): boolean {
	return (VISIT_TERMINAL as readonly string[]).includes(status);
}

/**
 * Off the happy path but not over: an off-ramp with a live exit. Derived from
 * the two sets above so a new status can't leave it behind.
 */
export function isVisitNonTerminalOffRamp(status: string): boolean {
	return isVisitOffRamp(status) && !isVisitTerminal(status);
}

export interface VisitActionContext {
	status: VisitStatus;
	canUpdateStatus: boolean;
	handlers: Record<VisitVerb | "cancel", () => void>;
}

/** "on site", "in progress" — for mid-sentence use in a reason. */
const phrase = (s: VisitStatus) => VisitStatusLabels[s].toLowerCase();

/** "on site", or "in progress, paused or on site" for a multi-state from-set. */
function fromPhrase(verb: VisitVerb): string {
	const names = VISIT_TRANSITIONS[verb].from.map(phrase);
	if (names.length === 1) return names[0];
	return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function verbReason(ctx: VisitActionContext, verb: VisitVerb): ActionGate {
	if (!ctx.canUpdateStatus) return NO_PERMISSION;
	if (canApplyVisitVerb(verb, ctx.status)) return null;
	return notApplicable(
		`Only available while the visit is ${fromPhrase(verb)} — this one is ${phrase(ctx.status)}.`
	);
}

/**
 * The visit's offered actions, in a fixed order.
 *
 * Order follows the path (drive, arrive, start), then the interruptions
 * (pause, resume, delay), then the two exits. Every action is present in every
 * status; ones the current status rules out arrive hidden.
 */
export function visitActions(ctx: VisitActionContext): LifecycleAction[] {
	const verb = (
		id: VisitVerb,
		labelText: string,
		intent: LifecycleAction["intent"]
	): LifecycleAction => build(id, labelText, intent, verbReason(ctx, id), ctx.handlers[id]);

	const cancelReason = !ctx.canUpdateStatus
		? NO_PERMISSION
		: ctx.status === "Completed"
			? notApplicable("This visit is already complete.")
			: ctx.status === "Cancelled"
				? notApplicable("This visit is already cancelled.")
				: null;

	return [
		verb("drive", "Start Driving", "primary"),
		verb("arrive", "Mark On Site", "primary"),
		verb("start", "Start Work", "primary"),
		verb("pause", "Pause", "neutral"),
		verb("resume", "Resume", "primary"),
		verb("delay", "Mark Delayed", "warning"),
		verb("complete", "Complete Visit", "primary"),
		build("cancel", "Cancel Visit", "destructive", cancelReason, ctx.handlers.cancel),
	];
}
