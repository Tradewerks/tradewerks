import type { BoardOccurrence, BoardVisit } from "../../../types/board";
import type { Job, JobVisit } from "../../../types/jobs";
import type { RecurringOccurrence, RecurringPlan } from "../../../types/recurringPlans";
import type { Technician } from "../../../types/technicians";
import { dateKeyAt, localDateKey } from "./scheduleBoardUtils";

export interface VisitWithJob extends JobVisit {
	job_obj: Job;
}

export interface OccurrenceWithPlan extends RecurringOccurrence {
	plan: RecurringPlan;
	job_obj: Job;
}

/**
 * A board row has only the fields the schedule draws, so this narrows by cast.
 * Anything it omits (line item rows, money, notes) is not read on these surfaces.
 */
export function boardToVisitWithJob(v: BoardVisit): VisitWithJob {
	return { ...v, job_obj: v.job } as unknown as VisitWithJob;
}

/** A plan-generated job, whether the full plan was loaded or only its id. */
export function isPlanJob(job: Pick<Job, "recurring_plan" | "recurring_plan_id"> | null | undefined): boolean {
	return !!(job?.recurring_plan || job?.recurring_plan_id);
}

export function formatTime(date: Date | string): string {
	const d = typeof date === "string" ? new Date(date) : date;
	return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Board occurrences become the card shape: the plan's priority and client ride
 * on `job_obj` because the cards read them there. A slot whose plan has no job
 * container has nothing to open, so it is dropped, as it was from the job list.
 * Slots before `today` ("YYYY-MM-DD") are not shown.
 */
export function boardToOccurrences(
	occurrences: BoardOccurrence[],
	today: string = localDateKey(new Date()),
): OccurrenceWithPlan[] {
	const startOfToday = dateKeyAt(today);
	return occurrences.flatMap((o) => {
		const { job_container, ...plan } = o.recurring_plan;
		if (!job_container) return [];
		if (new Date(o.occurrence_start_at) < startOfToday) return [];
		const job_obj = { ...job_container, priority: plan.priority, client: plan.client };
		const { recurring_plan: _plan, ...occ } = o;
		return [{ ...occ, plan, job_obj }] as unknown as OccurrenceWithPlan[];
	});
}

export interface AgendaGroup {
	techId: string;              // technician id or "unassigned"
	techName: string;
	color: string;
	items: Array<{ type: "visit"; item: VisitWithJob } | { type: "occ"; item: OccurrenceWithPlan }>;
}

export function itemStart(entry: AgendaGroup["items"][number]): number {
	return new Date(
		entry.type === "visit" ? entry.item.scheduled_start_at : entry.item.occurrence_start_at
	).getTime();
}

export function buildAgendaGroups(
	dayVisits: VisitWithJob[],
	dayOccs: OccurrenceWithPlan[],
	technicians: Technician[],
	techColorMap: Map<string, string>,
	globalTechOrder: string[],
): AgendaGroup[] {
	const groups: Map<string, AgendaGroup> = new Map(technicians.map((t) => {
		return [t.id, {
			techId: t.id,
			techName: t.name,
			color: techColorMap.get(t.id) ?? "var(--color-tech-unassigned)",
			items: [],
		} as AgendaGroup]
	}));
	groups.set("unassigned", {
		techId: "unassigned",
		techName: "",
		color: "var(--color-tech-unassigned)",
		items: []
	});
	dayVisits.forEach((job) => {
		if (job.visit_techs.length === 0) {
			groups.get("unassigned")?.items.push({ type: "visit", item: job });
			return;
		}
		job.visit_techs.forEach((tech) => {
			groups.get(tech.tech_id)?.items.push({ type: "visit", item: job})
		});
	});
	dayOccs.forEach((occ) => {
		groups.get("unassigned")?.items.push({ type: "occ", item: occ })
	});

	groups.forEach((g) => g.items.sort((a, b) => itemStart(a) - itemStart(b)));

	const result = globalTechOrder.map((t) => {
		return groups.get(t);
	});
	result.push(groups.get("unassigned"));
	return result.filter((ag) => ag !== undefined).filter((ag) => ag.items.length > 0);
}

export function buildChronologicalAgenda(
	dayVisits: VisitWithJob[],
	dayOccs: OccurrenceWithPlan[],
): AgendaGroup[] {
	const items: AgendaGroup["items"] = [
		...dayVisits.map((v) => ({ type: "visit" as const, item: v})),
		...dayOccs.map((o) => ({ type: "occ" as const, item: o})),
	];

	items.sort((a, b) => itemStart(a) - itemStart(b));
	if (items.length === 0) return [];
	return [{ techId: "__all__", techName: "", color: "var(--color-tech-unassigned)", items }];
}
