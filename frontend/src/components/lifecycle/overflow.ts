import type { LifecycleAction, LifecycleStage } from "./types";

/** How many actions the bar shows before the rest spill into the kebab. */
export const PRIMARY_SLOTS = 3;

export interface SplitActions {
	/** Rendered as buttons in the bar. */
	inline: LifecycleAction[];
	/** Rendered in the header kebab's Lifecycle group. */
	overflow: LifecycleAction[];
}

export interface SplitActionsOptions {
	/**
	 * The entity is off the happy path even though its stage is "normal" — a
	 * Paused/Delayed visit, a QuoteRejected request. See Rule 2 below.
	 */
	offRamp?: boolean;
}

/**
 * Where each lifecycle action goes. Pure, and the only place the two placement
 * rules live, so the bar and the header kebab cannot disagree about what each
 * one owns.
 *
 * Rule 1, stage-aware: on the normal stage a destructive action always
 * overflows, so a document-killing button is never one stray click from the
 * pointer. On a terminal or dispute stage it isn't held back — there it is
 * either already disabled or it IS the stage's exit, as Repeal is for a
 * disputed quote.
 *
 * Rule 2, stage-aware: on the normal happy path a disabled action keeps its
 * slot, so buttons don't move under the dispatcher as a document progresses.
 * Off the happy path — terminal, dispute, or `offRamp` — that inverts and live
 * actions take the visible slots, otherwise the one legal move (a paused
 * visit's Resume, a rejected quote's Create Revision) ends up behind the menu.
 * Rule 1 ignores offRamp, so a paused visit's Cancel Visit still overflows.
 */
export function splitActions(
	stage: LifecycleStage,
	actions: LifecycleAction[],
	options: SplitActionsOptions = {}
): SplitActions {
	const { offRamp = false } = options;
	// Hidden actions reach neither the bar nor the menu.
	const visible = actions.filter((a) => !a.hidden);
	const candidates =
		stage === "normal"
			? visible.filter((a) => a.intent !== "destructive")
			: visible;
	const ordered =
		stage === "normal" && !offRamp
			? candidates
			: [
					...candidates.filter((a) => !a.disabled),
					...candidates.filter((a) => a.disabled),
				];
	const inline = ordered.slice(0, PRIMARY_SLOTS);
	// Identity, not id: inline holds the very objects sliced out of visible.
	return { inline, overflow: visible.filter((a) => !inline.includes(a)) };
}
