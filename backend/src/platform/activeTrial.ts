export function activeTrial(
	ent: {
		trial_ends_at: Date | null;
		trial_plan_version: { plan: { label: string } } | null;
	},
	now: number,
): { tierLabel: string; endsAt: string } | null {
	if (!ent.trial_ends_at || !ent.trial_plan_version) return null;
	if (ent.trial_ends_at.getTime() <= now) return null;
	return {
		tierLabel: ent.trial_plan_version.plan.label,
		endsAt: ent.trial_ends_at.toISOString(),
	};
}
