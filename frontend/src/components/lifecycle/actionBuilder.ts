import type { LifecycleAction } from "./types";

/** Shown wherever a grant the action needs is missing. */
export const NO_PERMISSION = "You don't have permission to perform this action";

/** A reason the action is shut that also hides it. See LifecycleAction.hidden. */
export interface NotApplicable {
	reason: string;
	hidden: true;
}

export type ActionGate = string | NotApplicable | null;

/** Marks a reason as state-based: the action is hidden, not just disabled. */
export function notApplicable(reason: string): NotApplicable {
	return { reason, hidden: true };
}

/**
 * The `LifecycleAction` factory shared by every catalog. A null gate means the
 * action is live; a string disables it; notApplicable() disables and hides it.
 */
export function buildAction(
	id: string,
	label: string,
	intent: LifecycleAction["intent"],
	gate: ActionGate,
	onSelect: () => void
): LifecycleAction {
	if (gate == null) return { id, label, intent, disabled: false, onSelect };
	if (typeof gate === "string") {
		return { id, label, intent, disabled: true, disabledReason: gate, onSelect };
	}
	return { id, label, intent, disabled: true, disabledReason: gate.reason, hidden: true, onSelect };
}

/** Shown when the dispute list failed to load, so no action can be judged safe. */
export function unknownDisputeReason(kind: "quote" | "invoice"): string {
	return `This ${kind}'s dispute status couldn't be loaded. Reload the page and try again.`;
}

/** Why "Open Dispute" is shut for this document, or null. */
export function openDisputeReason(ctx: {
	kind: "quote" | "invoice";
	canOpenDispute: boolean;
	/** Invoice only: a Void document. Quotes never reach this state. */
	isDead?: boolean;
	disputeStateUnknown: boolean;
	hasOpenDispute: boolean;
	openRefusal: string | null;
}): ActionGate {
	if (!ctx.canOpenDispute) return NO_PERMISSION;
	if (ctx.isDead) return notApplicable(`A void ${ctx.kind} can't be disputed.`);
	if (ctx.disputeStateUnknown) return unknownDisputeReason(ctx.kind);
	if (ctx.hasOpenDispute) return notApplicable(`This ${ctx.kind} already has an open dispute.`);
	return ctx.openRefusal;
}
