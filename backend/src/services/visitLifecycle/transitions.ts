import type { visit_status } from "../../../generated/prisma/client.js";

export type Actor = "dispatcher" | "technician" | "system";

export type VisitAction =
	| "drive"
	| "arrive"
	| "start"
	| "pause"
	| "resume"
	| "complete"
	| "record_complete"
	| "delay"
	| "undelay"
	| "recall"
	| "cancel"
	| "restore"
	| "reopen";

type Edge = {
	from: readonly visit_status[];
	to: visit_status;
	actors: readonly Actor[];
};

const ALL: readonly Actor[] = ["dispatcher", "technician", "system"];

export const OPEN_VISIT_STATUSES: readonly visit_status[] = [
	"Scheduled",
	"Delayed",
	"Driving",
	"OnSite",
	"InProgress",
	"Paused",
];

export const ACTIVE_VISIT_STATUSES: readonly visit_status[] =
	OPEN_VISIT_STATUSES.filter((s) => s !== "Scheduled");

export const NEEDS_TECH: readonly visit_status[] = [
	"Driving",
	"OnSite",
	"InProgress",
	"Paused",
	"Completed",
];

// Key order matters: actionForStatusChange takes the first match, so `complete` must precede `record_complete`.
export const VISIT_TRANSITIONS: Record<VisitAction, Edge> = {
	drive: { from: ["Scheduled", "Delayed"], to: "Driving", actors: ALL },
	arrive: { from: ["Driving"], to: "OnSite", actors: ALL },
	start: { from: ["OnSite"], to: "InProgress", actors: ALL },
	pause: { from: ["InProgress"], to: "Paused", actors: ALL },
	resume: { from: ["Paused"], to: "InProgress", actors: ALL },
	complete: {
		from: ["OnSite", "InProgress", "Paused"],
		to: "Completed",
		actors: ALL,
	},
	record_complete: {
		from: ["Scheduled", "Delayed", "Driving"],
		to: "Completed",
		actors: ["dispatcher"],
	},
	delay: {
		from: ["Scheduled", "Driving", "OnSite"],
		to: "Delayed",
		actors: ["dispatcher"],
	},
	undelay: { from: ["Delayed"], to: "Scheduled", actors: ["dispatcher"] },
	// Only the destination switch sends a driving tech back; nobody does this by hand.
	recall: { from: ["Driving"], to: "Scheduled", actors: ["system"] },
	cancel: {
		from: OPEN_VISIT_STATUSES,
		to: "Cancelled",
		actors: ["dispatcher", "system"],
	},
	restore: { from: ["Cancelled"], to: "Scheduled", actors: ["dispatcher"] },
	reopen: { from: ["Completed"], to: "InProgress", actors: ["dispatcher"] },
};

export const HTTP_TRANSITION_ACTIONS: readonly VisitAction[] = [
	"drive",
	"arrive",
	"start",
	"pause",
	"resume",
	"complete",
	"delay",
	"restore",
];

export function actorOf(context?: {
	techId?: string;
	dispatcherId?: string;
}): Actor {
	if (context?.techId) return "technician";
	if (context?.dispatcherId) return "dispatcher";
	return "system";
}

export type TransitionCheck =
	| { ok: true; to: visit_status }
	| { ok: false; code: "FORBIDDEN" | "WRONG_STATE"; reason: string };

export function checkTransition(
	action: VisitAction,
	from: visit_status,
	actor: Actor,
): TransitionCheck {
	const edge = VISIT_TRANSITIONS[action];
	if (!edge.actors.includes(actor)) {
		return {
			ok: false,
			code: "FORBIDDEN",
			reason: `A ${actor} cannot ${action} a visit.`,
		};
	}
	if (!edge.from.includes(from)) {
		return {
			ok: false,
			code: "WRONG_STATE",
			reason: `Cannot ${action} a visit with status "${from}". Expected one of: ${edge.from.join(", ")}.`,
		};
	}
	return { ok: true, to: edge.to };
}

/** The action a PUT `status` change means, or null when no edge exists for this actor. Prefers `complete` over `record_complete`. */
export function actionForStatusChange(
	from: visit_status,
	to: visit_status,
	actor: Actor,
): VisitAction | null {
	for (const [action, edge] of Object.entries(VISIT_TRANSITIONS) as [
		VisitAction,
		Edge,
	][]) {
		if (
			edge.to === to &&
			edge.from.includes(from) &&
			edge.actors.includes(actor)
		)
			return action;
	}
	return null;
}
