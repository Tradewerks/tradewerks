import type { VisitStatusEvent } from "./jobs";

export interface InventoryUpdatedEvent {
	organizationId: string;
	itemId?: string;
	vehicleId?: string;
}

export interface JobUpdatedEvent {
	jobId: string;
	organizationId: string;
}

export interface JobNoteCreatedEvent {
	organizationId: string;
}

export interface JobVisitCreatedEvent {
	visitId: string;
	organizationId: string;
}

export interface JobVisitUpdatedEvent {
	visitId: string | null;
	organizationId: string;
}

export interface JobVisitDeletedEvent {
	visitId: string;
	organizationId: string;
}

export interface FieldPurchaseEvent {
	id: string;
	status?: string;
}

/** Extraction runs off the upload request, so only a socket says it finished. */
export interface FieldPurchaseOcrEvent {
	id: string;
	status: "succeeded" | "failed";
}

export interface FieldPurchaseGrantRequestedEvent {
	technicianId: string;
}

export type { VisitStatusEvent };
