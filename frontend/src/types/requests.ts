import z from "zod";
import { CoordinatesSchema, type Coordinates } from "./location";
import type { ClientWithPrimaryContact } from "./clients";
import type { Priority, BaseNote, QuoteReference, JobReference } from "./common";
import { PriorityValues } from "./common";

// ============================================================================
// REQUEST-SPECIFIC TYPES
// ============================================================================

export const RequestStatusValues = [
	"New",
	"Reviewing",
	"Quoted",
	"QuoteApproved",
	"QuoteRejected",
	"ConvertedToJob",
	"Cancelled",
] as const;

export type RequestStatus = (typeof RequestStatusValues)[number];

export const RequestStatusLabels: Record<RequestStatus, string> = {
	New: "New",
	Reviewing: "Reviewing",
	Quoted: "Quoted",
	QuoteApproved: "Quote Approved",
	QuoteRejected: "Quote Rejected",
	ConvertedToJob: "Converted to Job",
	Cancelled: "Cancelled",
};

export const RequestStatusColors: Record<RequestStatus, string> = {
	New:            "bg-primary/20 text-primary-text border-primary/30",
	Reviewing:      "bg-warning/20 text-warning-text border-warning/30",
	Quoted:         "bg-reviewing/20 text-reviewing-text border-reviewing/30",
	QuoteApproved:  "bg-success/20 text-success-text border-success/30",
	QuoteRejected:  "bg-error/20 text-error-text border-error/30",
	ConvertedToJob: "bg-success/20 text-success-text border-success/30",
	Cancelled:      "bg-neutral/20 text-text-tertiary border-border-strong/30",
};

// ============================================================================
// REQUEST TYPES
// ============================================================================

export interface Request {
	id: string;
	client_id: string;
	title: string;
	description: string;
	address: string | null;
	coords: Coordinates;
	priority: Priority;
	status: RequestStatus;
	requires_quote: boolean;
	estimated_value: number | null;
	source: string | null;
	source_reference: string | null;
	cancellation_reason: string | null;
	cancelled_at: Date | null;
	created_at: Date;
	updated_at: Date;

	client?: ClientWithPrimaryContact;
	quotes?: QuoteReference[];
	jobs?: JobReference[] | null;
	notes?: RequestNote[];
}

export interface CreateRequestInput {
	client_id: string;
	title: string;
	description: string;
	address?: string;
	coords?: Coordinates;
	priority?: Priority;
	status?: RequestStatus;
	requires_quote?: boolean;
	estimated_value?: number | null;
	source?: string | null;
	source_reference?: string | null;
}

export interface UpdateRequestInput {
	title?: string;
	description?: string;
	address?: string;
	coords?: Coordinates;
	priority?: Priority;
	status?: RequestStatus;
	requires_quote?: boolean;
	estimated_value?: number | null;
	source?: string | null;
	source_reference?: string | null;
	cancellation_reason?: string | null;
}

export const CreateRequestSchema = z.object({
	client_id: z.string().uuid("Invalid client ID"),
	title: z.string().min(1, "Title is required"),
	description: z.string().min(1, "Description is required"),
	priority: z.enum(PriorityValues).default("Medium"),
	address: z.string().optional(),
	coords: CoordinatesSchema.optional(),
	status: z.enum(RequestStatusValues).optional(),
	requires_quote: z.boolean().default(false),
	estimated_value: z.number().min(0).optional().nullable(),
	source: z.string().optional().or(z.literal("")).nullable(),
	source_reference: z.string().optional().or(z.literal("")).nullable(),
});

export const UpdateRequestSchema = z.object({
	title: z.string().min(1, "Title is required").optional(),
	description: z.string().min(1, "Description is required").optional(),
	priority: z.enum(PriorityValues).optional(),
	address: z.string().optional(),
	coords: CoordinatesSchema.optional(),
	status: z.enum(RequestStatusValues).optional(),
	requires_quote: z.boolean().optional(),
	estimated_value: z.number().min(0).optional().nullable(),
	source: z.string().optional().or(z.literal("")).nullable(),
	source_reference: z.string().optional().or(z.literal("")).nullable(),
	cancellation_reason: z.string().optional().or(z.literal("")).nullable(),
});

// ============================================================================
// REQUEST NOTES
// ============================================================================

export interface RequestNote extends BaseNote {
	request_id: string;
}

export interface CreateRequestNoteInput {
	content: string;
}

export interface UpdateRequestNoteInput {
	content: string;
}

export const CreateRequestNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

export const UpdateRequestNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});
