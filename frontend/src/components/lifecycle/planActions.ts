import type { RecurringPlanStatus } from "../../types/recurringPlans";
import type { LifecycleAction } from "./types";
import { buildAction, NO_PERMISSION, notApplicable } from "./actionBuilder";

export interface PlanActionContext {
	status: RecurringPlanStatus;
	canManage: boolean;
	/** Whether the plan has generated its first occurrence (and so has a job
	 *  container). Every verb here acts on that container, so none of them can
	 *  do anything until it exists. */
	hasJobContainer: boolean;
	handlers: Record<PlanVerb, () => void>;
}

type PlanVerb = "pause" | "resume" | "generate" | "complete" | "cancel" | "renew";

/**
 * Which states each verb is reachable from. Mirrors the named operations in
 * backend/src/controllers/recurringPlansController.ts plus the
 * `plan.status !== "Active"` guard the occurrence generator applies. A table,
 * not a chain of ifs: a plan has no path, only modes, so reachability is the
 * whole rule.
 */
const PLAN_VERB_FROM: Record<PlanVerb, readonly RecurringPlanStatus[]> = {
	pause: ["Active"],
	resume: ["Paused"],
	generate: ["Active"],
	complete: ["Active", "Paused"],
	cancel: ["Active", "Paused", "Expired"],
	renew: ["Expired"],
};

const REFUSAL: Record<PlanVerb, (s: RecurringPlanStatus) => string> = {
	pause: (s) => `Only an active plan can be paused — this one is ${s.toLowerCase()}.`,
	resume: (s) => `Only a paused plan can be resumed — this one is ${s.toLowerCase()}.`,
	generate: (s) =>
		`Occurrences are only generated for an active plan — this one is ${s.toLowerCase()}.`,
	complete: (s) => `This plan is already ${s.toLowerCase()}.`,
	renew: (s) => `Only an expired plan can be renewed — this one is ${s.toLowerCase()}.`,
	cancel: (s) => `This plan is already ${s.toLowerCase()}.`,
};

/**
 * The plan's offered actions, in a fixed order.
 *
 * Pause and Resume sit adjacent and are never both applicable: whichever the
 * plan's mode rules out is hidden, so the pair occupies one position in the row.
 */
export function planActions(ctx: PlanActionContext): LifecycleAction[] {
	const build = (
		id: PlanVerb,
		labelText: string,
		intent: LifecycleAction["intent"]
	): LifecycleAction =>
		buildAction(
			id,
			labelText,
			intent,
			// State before permission for renew: only an Expired plan offers it, so a
			// user who can't manage must not see a disabled Renew in every other state.
			id === "renew" && !PLAN_VERB_FROM.renew.includes(ctx.status)
				? notApplicable(REFUSAL.renew(ctx.status))
				: !ctx.canManage
					? NO_PERMISSION
					: !ctx.hasJobContainer
						? "This plan hasn't generated its first occurrence yet."
						: PLAN_VERB_FROM[id].includes(ctx.status)
							? null
							: notApplicable(REFUSAL[id](ctx.status)),
			ctx.handlers[id]
		);

	return [
		build("pause", "Pause Plan", "neutral"),
		build("resume", "Resume Plan", "primary"),
		build("generate", "Generate Next Occurrence", "primary"),
		build("complete", "Complete Plan", "neutral"),
		build("cancel", "Cancel Plan", "destructive"),
		build("renew", "Renew Plan", "primary"),
	];
}
