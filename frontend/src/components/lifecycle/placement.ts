import { splitActions } from "./overflow";
import type { LifecycleAction, LifecycleStage } from "./types";

export interface LifecyclePlacement {
	/** Rendered in DetailHeader's inlineActions slot. */
	headerActions: LifecycleAction[];
	/** Rendered inside LifecycleBar, beside the block they answer. */
	barActions: LifecycleAction[];
	/** Rendered as the kebab's "Lifecycle" group. */
	overflow: LifecycleAction[];
	/** Whether LifecycleBar has anything left worth a band. */
	showBar: boolean;
}

export interface PlaceActionsOptions {
	/**
	 * Off the happy path while still on the `normal` stage. Only affects
	 * splitActions' ordering, not placement.
	 */
	offRamp?: boolean;
}

/**
 * Which of the three destinations each lifecycle action goes to.
 *
 * On the happy path the actions are the page's next moves, so they sit beside
 * the title. On a dispute or terminal stage they answer a block of text (the
 * contested reason, the void reason) and stay with it. splitActions decides
 * what is inline at all; this decides only where the inline share is drawn.
 */
export function placeActions(
	stage: LifecycleStage,
	actions: LifecycleAction[],
	options: PlaceActionsOptions = {}
): LifecyclePlacement {
	const { inline, overflow } = splitActions(stage, actions, {
		offRamp: Boolean(options.offRamp),
	});
	const happyPath = stage === "normal";

	return {
		headerActions: happyPath ? inline : [],
		barActions: happyPath ? [] : inline,
		overflow,
		showBar: !happyPath,
	};
}
