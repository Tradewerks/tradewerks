/**
 * One offered lifecycle action. Unavailable actions are returned disabled with
 * a reason rather than omitted, so a dispatcher learns why.
 */
export interface LifecycleAction {
	id: string;
	label: string;
	/** warning = dispute-adjacent; destructive = kills the document. */
	intent: "primary" | "neutral" | "warning" | "destructive";
	disabled: boolean;
	disabledReason?: string;
	/**
	 * The action can never apply from the current state. Implies disabled, and
	 * splitActions drops it from both the bar and the menu. Reasons the
	 * dispatcher can change (permission, prerequisite, pending write) stay
	 * visible and disabled instead.
	 */
	hidden?: boolean;
	onSelect: () => void;
}

export type LifecycleStage = "normal" | "dispute" | "terminal";

export type LifecycleKind = "quote" | "invoice";
