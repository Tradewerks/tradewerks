// Live arrival forecasts from GET /arrivals; see backend/src/lib/arrivals.ts

export type ArrivalStatus = "on_time" | "at_risk" | "late" | "arrived" | "unknown";

// traffic: live Mapbox route · elapsed: overdue, no route · no_location: no recent GPS ·
// actual: settled on arrival
export type ArrivalBasis = "traffic" | "elapsed" | "no_location" | "actual";

export interface Arrival {
	id: string;
	visit_id: string;
	visit_name: string;
	visit_status: string;
	arrival_constraint: "anytime" | "at" | "between" | "by";
	job_id: string;
	job_number: string;
	client_id: string | null;
	client_name: string | null;
	address: string | null;
	tech_id: string;
	tech_name: string;
	tech_status: string;
	tech_last_ping_at: string | null;
	status: ArrivalStatus;
	basis: ArrivalBasis;
	en_route: boolean;
	// 0 = next stop; 1+ assumes earlier visits finish on schedule
	stop_index: number;
	due_at: string;
	eta_at: string | null;
	leave_by_at: string | null;
	arrived_at: string | null;
	// Positive = late, negative = minutes to spare
	delay_minutes: number | null;
	drive_minutes: number | null;
	traffic_delay_minutes: number | null;
	distance_miles: number | null;
	alerted: boolean;
	computed_at: string;
	routed_at: string | null;
	stale: boolean;
}

export interface ArrivalBoard {
	as_of: string;
	summary: Record<ArrivalStatus, number>;
	arrivals: Arrival[];
}
