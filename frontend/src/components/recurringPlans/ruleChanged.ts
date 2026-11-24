import type { RecurringRule, UpdateRecurringPlanInput } from "../../types/recurringPlans";

type RuleInput = NonNullable<UpdateRecurringPlanInput["rule"]>;

type Comparable = {
	frequency: string;
	interval: number;
	weekdays: string[];
	by_month_day?: number | null;
	by_month?: number | null;
	arrival_constraint: string;
	finish_constraint: string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_time?: string | null;
};

// Only the times the constraints use, as the edit form builds them; a value
// left behind under another constraint changes nothing.
function signature(r: Comparable): string {
	const arrival = r.arrival_constraint;
	const finish = r.finish_constraint;
	return JSON.stringify([
		r.frequency,
		Number(r.interval),
		[...r.weekdays].sort(),
		r.by_month_day ?? null,
		r.by_month ?? null,
		arrival,
		finish,
		arrival === "at" ? (r.arrival_time ?? null) : null,
		arrival === "between" ? (r.arrival_window_start ?? null) : null,
		arrival === "between" || arrival === "by" ? (r.arrival_window_end ?? null) : null,
		finish === "at" || finish === "by" ? (r.finish_time ?? null) : null,
	]);
}

/**
 * Whether the edited rule differs from the stored one. Sending a rule makes the
 * server delete and regenerate every planned date, which snaps individually
 * moved visits back, so an unchanged rule must not be sent.
 */
export function ruleChanged(next: RuleInput, stored: RecurringRule | undefined): boolean {
	if (!stored) return true;
	return (
		signature({ ...next, weekdays: next.by_weekday ?? [] }) !==
		signature({ ...stored, weekdays: (stored.by_weekday ?? []).map((w) => w.weekday) })
	);
}
