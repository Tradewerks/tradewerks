import type { Priority } from "./common";
import type { ArrivalConstraint, FinishConstraint, JobStatus, VisitStatus } from "./jobs";
import type { Coordinates } from "./location";

/** One row of `GET /job-visits/board`: just what the schedule surfaces draw. */
export interface BoardVisit {
	id: string;
	job_id: string;
	name?: string | null;
	description?: string | null;
	status: VisitStatus;
	scheduled_start_at: string;
	scheduled_end_at: string;
	arrival_constraint: ArrivalConstraint;
	finish_constraint: FinishConstraint;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_time?: string | null;
	actual_start_at?: string | null;
	actual_end_at?: string | null;
	updated_at?: string;
	_count: { line_items: number };
	visit_techs: { tech_id: string; tech: { id: string; name: string } }[];
	job: {
		id: string;
		job_number: string;
		name: string;
		description: string | null;
		status: JobStatus;
		priority: Priority;
		address: string | null;
		coords: Coordinates;
		recurring_plan_id: string | null;
		client: { id: string; name: string };
	};
}

/** A planned recurring slot; the plan carries only what the cards print. */
export interface BoardOccurrence {
	id: string;
	recurring_plan_id: string;
	occurrence_start_at: string;
	occurrence_end_at: string;
	status: "planned";
	arrival_constraint: ArrivalConstraint;
	finish_constraint: FinishConstraint;
	arrival_time: string | null;
	arrival_window_start: string | null;
	arrival_window_end: string | null;
	finish_time: string | null;
	job_visit_id: null;
	recurring_plan: {
		id: string;
		name: string;
		description: string | null;
		address: string | null;
		priority: Priority;
		client: { id: string; name: string };
		job_container: { id: string; job_number: string; name: string } | null;
	};
}

export interface UnscheduledJob {
	id: string;
	job_number: string;
	name: string;
	priority: Priority;
	address: string;
	client: { id: string; name: string };
}

export interface BoardResponse {
	visits: BoardVisit[];
	/** Planned recurring slots in the range; empty without `view_jobs`. */
	occurrences: BoardOccurrence[];
	/** Present only when requested; empty without `view_jobs`. */
	unscheduledJobs?: UnscheduledJob[];
}
