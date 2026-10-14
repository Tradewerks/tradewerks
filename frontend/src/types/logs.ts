export interface ActivityLog {
	id: string;
	event_type: string;
	action: string;
	entity_type: string;
	entity_id: string;
	actor_type: string;
	actor_id: string | null;
	actor_name: string | null;
	changes: Record<string, { old: unknown; new: unknown }> | null;
	timestamp: string;
	ip_address: string | null;
	user_agent: string | null;
	reason: string | null;
	organization_id: string | null;
}

type entityTypes = "job" | "invoice" | "quote" | "request" | "project" | "client" | "recurring_plan" | "vehicle" | "timesheet";

export type ChangeScope =
	| { kind: "actor"; type: "dispatcher" | "technician"; id: string }
	| { kind: "entity"; type: entityTypes; id: string };
