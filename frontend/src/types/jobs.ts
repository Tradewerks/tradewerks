import z from "zod";
import type { ClientWithPrimaryContact } from "./clients";
import type { BillingRef } from "./invoices";
import type { Coordinates } from "./location";
import type {
	Priority,
	BaseNote,
	RequestReference,
	QuoteReference,
	LineItemType,
	LineItemSource,
	LineItemDisposition,
	PricingBreakdown,
	ExecutionTotals,
} from "./common";
import {
	PriorityValues,
	LineItemTypeValues,
	LineItemSourceValues,
	DiscountTypeValues,
} from "./common";
import {
	ArrivalConstraintValues,
	FinishConstraintValues,
	type ArrivalConstraint,
	type FinishConstraint,
	type RecurringPlanStatus,
	type RecurringOccurrence,
} from "./recurringPlans";
import type { ProjectRef } from "./project";

// ============================================================================
// JOB-SPECIFIC TYPES
// ============================================================================

export const JobStatusValues = [
	"Unscheduled",
	"Scheduled",
	"InProgress",
	"Completed",
	"Cancelled",
] as const;

export type JobStatus = (typeof JobStatusValues)[number];

export const JobStatusLabels: Record<JobStatus, string> = {
	Unscheduled: "Unscheduled",
	Scheduled: "Scheduled",
	InProgress: "In Progress",
	Completed: "Completed",
	Cancelled: "Cancelled",
};

export const JobStatusColors: Record<JobStatus, string> = {
	Unscheduled: "bg-neutral/20 text-text-tertiary border-border-strong/30",
	Scheduled: "bg-primary/20 text-primary-text border-primary/30",
	InProgress: "bg-warning/20 text-warning-text border-warning/30",
	Completed: "bg-success/20 text-success-text border-success/30",
	Cancelled: "bg-error/20 text-error-text border-error/30",
};

export const VisitStatusValues = [
	"Scheduled",
	"Driving",
	"OnSite",
	"InProgress",
	"Paused",
	"Delayed",
	"Completed",
	"Cancelled",
] as const;

export type VisitStatus = (typeof VisitStatusValues)[number];

export const VisitStatusLabels: Record<VisitStatus, string> = {
	Scheduled: "Scheduled",
	Driving: "Driving",
	OnSite: "On Site",
	InProgress: "In Progress",
	Paused: "Paused",
	Delayed: "Delayed",
	Completed: "Completed",
	Cancelled: "Cancelled",
};

export const VisitStatusColors: Record<VisitStatus, string> = {
	Scheduled:  "bg-surface-raised/40 text-text-tertiary border-border-strong/40",
	Driving:    "bg-info/20 text-info-text border-info/30",
	OnSite:     "bg-reviewing/20 text-reviewing-text border-reviewing/30",
	InProgress: "bg-primary/20 text-primary-text border-primary/30",
	Paused:     "bg-warning/20 text-warning-text border-warning/30",
	Delayed:    "bg-orange/20 text-orange-text border-orange/30",
	Completed:  "bg-success/20 text-success-text border-success/30",
	Cancelled:  "bg-surface-raised/40 text-text-muted border-border-strong/40",
};

export type LifecycleAction = "drive" | "arrive" | "start" | "pause" | "resume" | "complete" | "delay";

// Re-export constraint types from recurringPlans for convenience
export { ArrivalConstraintValues, FinishConstraintValues };
export type { ArrivalConstraint, FinishConstraint };

// ============================================================================
// JOB TYPES
// ============================================================================

export interface JobVisitTechnician {
	visit_id: string;
	tech_id: string;
	tech_status: string;
	tech: {
		id: string;
		name: string;
		email: string;
		phone: string;
		title: string;
		status: string;
	};
}

export interface VisitTechTimeEntry {
	id: string;
	visit_id: string;
	tech_id: string;
	tech: { id: string; name: string };
	clocked_in_at: Date | string;
	clocked_out_at: Date | string | null;
	hours_worked: number | null;
	line_item_id: string | null;
	pause_reason: string | null;
	created_at: Date | string;
}

export interface ClockInResult {
	id: string;
	visit_id: string;
	tech_id: string;
	clocked_in_at: Date | string;
	clocked_out_at: null;
	hours_worked: null;
	line_item_id: null;
	tech: { id: string; name: string };
}

export interface ClockOutResult {
	entry: VisitTechTimeEntry;
	line_item: VisitLineItem;
	is_last_tech: boolean;
	statusChangedToPaused?: boolean;
}

export interface JobSummary {
	id: string;
	name: string;
	job_number: string;
	client_id: string;
	address: string;
	description: string;
	priority: Priority;
	status: JobStatus;
}

export interface VisitReference {
	id: string;
	name?: string;
	scheduled_start_at: Date | string;
	scheduled_end_at: Date | string;
	status: VisitStatus;
}

export interface RecurringPlanReference {
	id: string;
	name: string;
	status: RecurringPlanStatus;
	starts_at: Date | string;
	occurrences?: RecurringOccurrence[];
}

export interface Job extends PricingBreakdown, ExecutionTotals {
	id: string;
	name: string;
	job_number: string;
	client_id: string;
	address: string;
	coords: Coordinates;
	description: string;
	priority: Priority;
	status: JobStatus;

	created_at: Date | string;
	updated_at?: Date | string;
	completed_at?: Date | string | null;
	cancelled_at?: Date | string | null;
	cancellation_reason?: string | null;

	request_id: string | null;
	quote_id: string | null;
	recurring_plan_id?: string | null;

	project_id?: string | null;
	client?: ClientWithPrimaryContact;
	request?: RequestReference | null;
	quote?: QuoteReference | null;
	recurring_plan?: RecurringPlanReference | null;
	visits?: JobVisit[];
	notes?: JobNote[];
	line_items?: JobLineItem[];
}

export interface CreateJobInput extends PricingBreakdown, ExecutionTotals {
	name: string;
	client_id: string;
	address: string;
	coords?: Coordinates;
	description: string;
	priority?: Priority;
	status?: JobStatus;
	request_id?: string;
	quote_id?: string;
	recurring_plan_id?: string;
	line_items?: CreateJobLineItemInput[];
}

export interface UpdateJobInput extends PricingBreakdown, ExecutionTotals {
	name?: string;
	address?: string;
	coords?: Coordinates;
	description?: string;
	priority?: Priority;
	status?: JobStatus;

	cancellation_reason?: string;
	line_items?: UpdateJobLineItemInput[];
}

// ============================================================================
// LINE ITEM TYPES
// ============================================================================

export interface JobLineItem {
	id?: string;
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	item_type?: LineItemType | null;
	source?: LineItemSource;
	source_job_id?: string | null;
	source_visit_id?: string | null;
	taxable: boolean;
	tax_group_id: string | null;
	tax_amount: number | null;
	tax_group?: { id: string; name: string; rates?: { tax_rate: { id: string; name: string; rate: number } }[] } | null;
	isNew?: boolean;
	isDeleted?: boolean;
	/** Catalog link, when the line was picked from inventory rather than typed. */
	inventory_item_id?: string | null;
}

export interface CreateJobLineItemInput {
	name: string;
	description?: string;
	quantity: number;
	unit_price: number;
	total?: number;
	item_type?: LineItemType | null;
	source?: LineItemSource;
	taxable?: boolean;
	tax_group_id?: string | null;
	inventory_item_id?: string | null;
}

export interface UpdateJobLineItemInput {
	id?: string;
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	item_type?: LineItemType | null;
	source?: LineItemSource;
	taxable?: boolean;
	tax_group_id?: string | null;
	inventory_item_id?: string | null;
}

export interface VisitLineItem {
	id?: string;
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	item_type?: LineItemType | null;
	inventory_item_id?: string | null;
	disposition?: LineItemDisposition | null;
	disposition_vehicle_id?: string | null;
	source?: LineItemSource;
	source_job_id?: string | null;
	source_visit_id?: string | null;
	taxable: boolean;
	tax_group_id: string | null;
	tax_amount: number | null;
	tax_group?: { id: string; name: string; rates?: { tax_rate: { id: string; name: string; rate: number } }[] } | null;
	isNew?: boolean;
	isDeleted?: boolean;
	fulfillment_status?: string | null;
}

export interface CreateVisitLineItemInput {
	name: string;
	description?: string;
	quantity: number;
	unit_price: number;
	total?: number;
	item_type?: LineItemType | null;
	source?: LineItemSource;
	sort_order?: number;
	taxable?: boolean;
	tax_group_id?: string | null;
	inventory_item_id?: string | null;
	disposition?: LineItemDisposition | null;
	disposition_vehicle_id?: string | null;
}

export interface UpdateVisitLineItemInput {
	id?: string;
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	item_type?: LineItemType | null;
	source?: LineItemSource;
	sort_order?: number;
	taxable?: boolean;
	tax_group_id?: string | null;
	inventory_item_id?: string | null;
	disposition?: LineItemDisposition | null;
	disposition_vehicle_id?: string | null;
}

// ============================================================================
// JOB VISIT TYPES
// ============================================================================

export interface JobVisit extends PricingBreakdown {
	id: string;
	job_id: string;

	name?: string;
	description?: string | null;

	arrival_constraint: ArrivalConstraint;
	finish_constraint: FinishConstraint;
	scheduled_start_at: Date | string;
	scheduled_end_at: Date | string;
	arrival_time?: string | null; // HH:MM
	arrival_window_start?: string | null; // HH:MM
	arrival_window_end?: string | null; // HH:MM
	finish_time?: string | null; // HH:MM

	actual_start_at?: Date | string | null;
	actual_end_at?: Date | string | null;
	estimated_drive_miles?: number | null;
	status: VisitStatus;
	cancellation_reason?: string | null;

	created_at?: Date | string;
	updated_at?: Date | string;

	job?: JobSummary & { client: ClientWithPrimaryContact; coords: Coordinates; quote?: QuoteReference | null, project?: ProjectRef | null; };
	visit_techs: JobVisitTechnician[];
	notes?: JobNote[];
	line_items?: VisitLineItem[];
	time_entries?: VisitTechTimeEntry[];
	invoice_visits?: BillingRef[];
	_count?: {
		invoice_visits: number;
	};
}

export interface CreateJobVisitInput {
	job_id: string;

	name: string;
	description?: string | null;

	arrival_constraint: ArrivalConstraint;
	finish_constraint: FinishConstraint;
	scheduled_start_at: Date | string;
	scheduled_end_at: Date | string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_time?: string | null;

	status?: VisitStatus;
	tech_ids?: string[];
	line_items?: CreateVisitLineItemInput[];
}

export interface UpdateJobVisitInput {
	name?: string;
	description?: string | null;

	arrival_constraint?: ArrivalConstraint;
	finish_constraint?: FinishConstraint;
	scheduled_start_at?: Date | string;
	scheduled_end_at?: Date | string;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_time?: string | null;

	actual_start_at?: Date | string | null;
	actual_end_at?: Date | string | null;
	status?: VisitStatus;
	cancellation_reason?: string | null;
	tech_ids?: string[];
	line_items?: UpdateVisitLineItemInput[];
	reschedule_scope?: "this" | "future";
}

// ============================================================================
// NOTE TYPES
// ============================================================================

export interface JobNotePhoto {
	id: string;
	note_id: string;
	photo_url: string;
	photo_label: "Before" | "After" | "Other";
	created_at: string;
}

export interface NotePhoto {
	photo_url: string;
	photo_label: "Before" | "After" | "Other";
	filename: string;
	preview_url: string;
}

export interface JobNote extends BaseNote {
	job_id: string;
	visit_id?: string | null;
	visit?: VisitReference | null;
	photos?: JobNotePhoto[];
}

export interface CreateJobNoteInput {
	content: string;
	visit_id?: string | null;
	photos?: { photo_url: string; photo_label: string }[];
}

export interface UpdateJobNoteInput {
	content: string;
	visit_id?: string | null;
	photos?: { id?: string; photo_url: string; photo_label: string }[];
}

// ============================================================================
// API RESPONSE TYPES
// ============================================================================

export interface JobResponse {
	err: string;
	data: Job[];
}

export interface JobVisitResponse {
	err: string;
	data: JobVisit[];
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================
export const CreateJobSchema = z.object({
	name: z.string().min(1, "Job name is required"),
	client_id: z.string().min(1, "Please select a client"),
	address: z.string().min(1, "Address is required"),
	coords: z
		.object({
			lat: z.number(),
			lon: z.number(),
		})
		.optional(),
	description: z.string().min(1, "Description is required"),
	priority: z.enum(PriorityValues).default("Medium"),
	status: z.enum(JobStatusValues).default("Unscheduled"),
	request_id: z.string().uuid().optional().nullable(),
	quote_id: z.string().uuid().optional().nullable(),
	recurring_plan_id: z.string().uuid().optional().nullable(),

	estimated_total: z.number().nonnegative().optional().nullable(),
	line_items: z
		.array(
			z.object({
				name: z.string().min(1, "Item name is required"),
				description: z.string().optional(),
				quantity: z.number().positive("Quantity must be positive"),
				unit_price: z
					.number()
					.nonnegative("Unit price must be non-negative"),
			})
		)
		.optional(),

	subtotal: z.number().nonnegative().optional(),
	tax_rate: z.number().min(0).max(1).optional(),
	tax_amount: z.number().nonnegative().optional(),
	discount_type: z.enum(DiscountTypeValues).optional(),
	discount_value: z.number().nonnegative().optional(),
	discount_amount: z.number().nonnegative().optional(),
});

export const UpdateJobSchema = z.object({
	name: z.string().min(1, "Job name is required").optional(),
	address: z.string().min(1, "Address is required").optional(),
	coords: z
		.object({
			lat: z.number(),
			lon: z.number(),
		})
		.optional(),
	description: z.string().min(1, "Description is required").optional(),
	priority: z.enum(PriorityValues).optional(),
	status: z.enum(JobStatusValues).optional(),
	estimated_total: z.number().nonnegative().optional().nullable(),
	actual_total: z.number().nonnegative().optional().nullable(),
	cancellation_reason: z.string().optional(),
	line_items: z
		.array(
			z.object({
				id: z.string().uuid().optional(),
				name: z.string().min(1, "Item name is required"),
				description: z.string().optional(),
				quantity: z.number().positive("Quantity must be positive"),
				unit_price: z
					.number()
					.nonnegative("Unit price must be non-negative"),
				total: z.number().nonnegative("Total must be non-negative"),
				item_type: z.enum(LineItemTypeValues).optional(),
				source: z.enum(LineItemSourceValues).optional(),
			})
		)
		.optional(),

	subtotal: z.number().nonnegative().optional(),
	tax_rate: z.number().min(0).max(1).optional(),
	tax_amount: z.number().nonnegative().optional(),
	discount_type: z.enum(DiscountTypeValues).optional(),
	discount_value: z.number().nonnegative().optional(),
	discount_amount: z.number().nonnegative().optional(),
});

export const CreateJobVisitSchema = z
	.object({
		job_id: z.string().uuid("Invalid job ID"),

		name: z.string().min(1, "Visit name is required").max(255),
		description: z.string().optional().nullable(),

		arrival_constraint: z.enum(ArrivalConstraintValues),
		finish_constraint: z.enum(FinishConstraintValues),
		scheduled_start_at: z.coerce.date({ message: "Start time is required" }),
		scheduled_end_at: z.coerce.date({ message: "End time is required" }),
		arrival_time: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),
		arrival_window_start: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),
		arrival_window_end: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),
		finish_time: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),

		status: z.enum(VisitStatusValues).default("Scheduled"),
		tech_ids: z.array(z.string().uuid()).optional(),
		line_items: z
			.array(
				z.object({
					name: z.string().min(1, "Item name is required"),
					description: z.string().optional().nullable(),
					quantity: z.number().positive("Quantity must be positive"),
					unit_price: z
						.number()
						.nonnegative("Unit price must be non-negative"),
					total: z
						.number()
						.nonnegative("Total must be non-negative")
						.optional(),
					source: z.enum(LineItemSourceValues).optional(),
					item_type: z.enum(LineItemTypeValues).optional().nullable(),
					sort_order: z.number().nonnegative().default(0),
					taxable: z.boolean().optional(),
					tax_group_id: z.string().uuid().nullable().optional(),
				})
			)
			.optional(),
	})
	.refine(
		(data) => {
			return data.scheduled_end_at > data.scheduled_start_at;
		},
		{
			message: "End time must be after start time",
			path: ["scheduled_end_at"],
		}
	)
	.refine(
		(data) => {
			if (data.arrival_constraint === "at" && !data.arrival_time) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival time is required when constraint is 'at'",
			path: ["arrival_time"],
		}
	)
	.refine(
		(data) => {
			if (
				data.arrival_constraint === "between" &&
				(!data.arrival_window_start || !data.arrival_window_end)
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival window start and end are required for 'between' constraint",
			path: ["arrival_window_start"],
		}
	)
	.refine(
		(data) => {
			if (data.arrival_constraint === "by" && !data.arrival_window_end) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival deadline is required for 'by' constraint",
			path: ["arrival_window_end"],
		}
	)
	.refine(
		(data) => {
			if (
				(data.finish_constraint === "at" ||
					data.finish_constraint === "by") &&
				!data.finish_time
			) {
				return false;
			}
			return true;
		},
		{
			message: "Finish time is required for 'at' or 'by' constraint",
			path: ["finish_time"],
		}
	);

export const UpdateJobVisitSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		description: z.string().optional().nullable(),

		arrival_constraint: z.enum(ArrivalConstraintValues).optional(),
		finish_constraint: z.enum(FinishConstraintValues).optional(),
		scheduled_start_at: z.coerce.date().optional(),
		scheduled_end_at: z.coerce.date().optional(),
		arrival_time: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),
		arrival_window_start: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),
		arrival_window_end: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),
		finish_time: z
			.string()
			.regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format")
			.optional()
			.nullable(),

		actual_start_at: z.coerce.date().optional().nullable(),
		actual_end_at: z.coerce.date().optional().nullable(),
		status: z.enum(VisitStatusValues).optional(),
		cancellation_reason: z.string().optional().nullable(),
		tech_ids: z.array(z.string().uuid()).optional(),
		line_items: z
			.array(
				z.object({
					id: z.string().uuid().optional(),
					name: z.string().min(1, "Item name is required"),
					description: z.string().optional().nullable(),
					quantity: z.number().positive("Quantity must be positive"),
					unit_price: z
						.number()
						.nonnegative("Unit price must be non-negative"),
					total: z.number().nonnegative("Total must be non-negative"),
					source: z.enum(LineItemSourceValues).optional(),
					item_type: z.enum(LineItemTypeValues).optional().nullable(),
					sort_order: z.number().nonnegative().default(0),
					taxable: z.boolean().optional(),
					tax_group_id: z.string().uuid().nullable().optional(),
				})
			)
			.optional(),
	})
	.refine(
		(data) => {
			if (data.scheduled_start_at && data.scheduled_end_at) {
				return data.scheduled_end_at > data.scheduled_start_at;
			}
			return true;
		},
		{
			message: "End time must be after start time",
			path: ["scheduled_end_at"],
		}
	)
	.refine(
		(data) => {
			if (data.actual_start_at && data.actual_end_at) {
				return data.actual_end_at > data.actual_start_at;
			}
			return true;
		},
		{
			message: "Actual end time must be after actual start time",
			path: ["actual_end_at"],
		}
	)
	.refine(
		(data) => {
			if (data.arrival_constraint === "at" && data.arrival_time === undefined) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival time is required when constraint is 'at'",
			path: ["arrival_time"],
		}
	)
	.refine(
		(data) => {
			if (
				data.arrival_constraint === "between" &&
				(data.arrival_window_start === undefined ||
					data.arrival_window_end === undefined)
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival window start and end are required for 'between' constraint",
			path: ["arrival_window_start"],
		}
	)
	.refine(
		(data) => {
			if (
				data.arrival_constraint === "by" &&
				data.arrival_window_end === undefined
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival deadline is required for 'by' constraint",
			path: ["arrival_window_end"],
		}
	)
	.refine(
		(data) => {
			if (
				(data.finish_constraint === "at" ||
					data.finish_constraint === "by") &&
				data.finish_time === undefined
			) {
				return false;
			}
			return true;
		},
		{
			message: "Finish time is required for 'at' or 'by' constraint",
			path: ["finish_time"],
		}
	);

export const CreateJobNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
	visit_id: z.string().uuid().optional().nullable(),
});

export const UpdateJobNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
	visit_id: z.string().uuid().optional().nullable(),
	photos: z.array(
		z.object({
			id: z.string().uuid().optional(),
			photo_url: z.string().url(),
			photo_label: z.enum(["Before", "After", "Other"]),
		}),
	).optional(),
});

// ============================================================================
// SOCKET EVENT TYPES
// ============================================================================

export interface VisitStatusEvent {
	visitStatusChanged: boolean;
	visitStatus: VisitStatus;
	previousVisitStatus: VisitStatus;
	actor: {
		type: "technician" | "dispatcher";
		name: string | null;
		id: string;
	} | null;
	visit: {
		id: string;
		name?: string | null;
		scheduledAt: string;
		job: {
			id: string;
			client: { name: string };
		};
	};
	changedAt: string;
}
