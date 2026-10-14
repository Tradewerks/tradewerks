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

export function formatTime(date: Date | string): string {
	const d = typeof date === "string" ? new Date(date) : date;
	return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function extractVisits(jobs: Job[]): VisitWithJob[] {
	return jobs.flatMap((job_obj) =>
		(job_obj.visits ?? []).map((visit) => ({ ...visit, job_obj }))
	);
}

/** Planned, ungenerated occurrences from `today` (a "YYYY-MM-DD" key) onward. */
export function extractOccurrences(
	jobs: Job[],
	today: string = localDateKey(new Date()),
): OccurrenceWithPlan[] {
	const startOfToday = dateKeyAt(today);
	return jobs.flatMap((job_obj) => {
		const plan = job_obj.recurring_plan as RecurringPlan | undefined | null;
		if (!plan?.occurrences?.length) return [];
		return plan.occurrences
			.filter((occ) => {
				if (occ.job_visit_id) return false;
				if (new Date(occ.occurrence_start_at) < startOfToday) return false;
				if (occ.status === "skipped" || occ.status === "cancelled") return false;
				return occ.status === "planned";
			})
			.map((occ) => ({ ...occ, plan, job_obj }));
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
