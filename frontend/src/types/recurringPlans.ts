import z from "zod";
import type { ClientWithPrimaryContact } from "./clients";
import type { Coordinates } from "./location";
import type {
	Priority,
	BaseNote,
	LineItemType,
	LineItemDisposition,
	DispatcherReference,
} from "./common";
import { PriorityValues, LineItemTypeValues, LineItemDispositionValues } from "./common";
import type { JobSummary, VisitReference } from "./jobs";

// ============================================================================
// RECURRING PLAN-SPECIFIC TYPES
// ============================================================================

export const RecurringPlanStatusValues = ["Active", "Paused", "Completed", "Cancelled"] as const;

export type RecurringPlanStatus = (typeof RecurringPlanStatusValues)[number];

export const RecurringPlanStatusLabels: Record<RecurringPlanStatus, string> = {
	Active: "Active",
	Paused: "Paused",
	Completed: "Completed",
	Cancelled: "Cancelled",
};

export const RecurringPlanStatusColors: Record<RecurringPlanStatus, string> = {
	Active: "bg-success/20 text-success-text border-success/30",
	Paused: "bg-warning/20 text-warning-text border-warning/30",
	Completed: "bg-primary/20 text-primary-text border-primary/30",
	Cancelled: "bg-error/20 text-error-text border-error/30",
};

export const RecurringFrequencyValues = ["daily", "weekly", "monthly", "yearly"] as const;

export type RecurringFrequency = (typeof RecurringFrequencyValues)[number];

export const RecurringFrequencyLabels: Record<RecurringFrequency, string> = {
	daily: "Daily",
	weekly: "Weekly",
	monthly: "Monthly",
	yearly: "Yearly",
};

export const WeekdayValues = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WeekdayValues)[number];

export const WeekdayLabels: Record<Weekday, string> = {
	MO: "Monday",
	TU: "Tuesday",
	WE: "Wednesday",
	TH: "Thursday",
	FR: "Friday",
	SA: "Saturday",
	SU: "Sunday",
};

export const WeekdayShortLabels: Record<Weekday, string> = {
	MO: "Mon",
	TU: "Tue",
	WE: "Wed",
	TH: "Thu",
	FR: "Fri",
	SA: "Sat",
	SU: "Sun",
};

// Constraint-based schedule types
export const ArrivalConstraintValues = ["anytime", "at", "between", "by"] as const;
export type ArrivalConstraint = (typeof ArrivalConstraintValues)[number];

export const ArrivalConstraintLabels: Record<ArrivalConstraint, string> = {
	anytime: "Anytime",
	at: "At specific time",
	between: "Between times",
	by: "By deadline",
};

export const FinishConstraintValues = ["when_done", "at", "by"] as const;
export type FinishConstraint = (typeof FinishConstraintValues)[number];

export const FinishConstraintLabels: Record<FinishConstraint, string> = {
	when_done: "When done",
	at: "At specific time",
	by: "By deadline",
};

export const BillingModeValues = ["per_visit", "subscription", "none"] as const;
export type BillingMode = (typeof BillingModeValues)[number];

export const BillingModeLabels: Record<BillingMode, string> = {
	per_visit: "Per Visit",
	subscription: "Subscription",
	none: "None",
};

export const InvoiceTimingValues = ["on_completion", "on_schedule_date", "manual"] as const;
export type InvoiceTiming = (typeof InvoiceTimingValues)[number];

export const InvoiceTimingLabels: Record<InvoiceTiming, string> = {
	on_completion: "On Completion",
	on_schedule_date: "On Schedule Date",
	manual: "Manual",
};

// ============================================================================
// INVOICE SCHEDULE
// ============================================================================

export const InvoiceScheduleFrequencyValues = [
	"on_visit_completion",
	"weekly",
	"biweekly",
	"monthly",
	"quarterly",
] as const;
export type InvoiceScheduleFrequency = (typeof InvoiceScheduleFrequencyValues)[number];

export const InvoiceScheduleFrequencyLabels: Record<InvoiceScheduleFrequency, string> = {
	on_visit_completion: "On Visit Completion",
	weekly: "Weekly",
	biweekly: "Biweekly",
	monthly: "Monthly",
	quarterly: "Quarterly",
};

export const InvoiceScheduleBillingBasisValues = [
	"visit_actuals",
	"plan_line_items",
	"fixed_amount",
] as const;
export type InvoiceScheduleBillingBasis = (typeof InvoiceScheduleBillingBasisValues)[number];

export const InvoiceScheduleBillingBasisLabels: Record<InvoiceScheduleBillingBasis, string> = {
	visit_actuals: "Per Visit (line items)",
	plan_line_items: "Plan Line Items",
	fixed_amount: "Fixed Amount",
};

export interface InvoiceSchedule {
	id: string;
	recurring_plan_id: string;
	billing_basis: InvoiceScheduleBillingBasis;
	fixed_amount?: number | null;
	frequency: InvoiceScheduleFrequency;
	day_of_month?: number | null;
	day_of_week?: Weekday | null;
	generate_days_before: number;
	payment_terms_days?: number | null;
	auto_send: boolean;
	memo_template?: string | null;
	next_invoice_at?: Date | string | null;
	last_invoiced_at?: Date | string | null;
	is_active: boolean;
	created_at: Date | string;
	updated_at: Date | string;
}

export interface InvoiceScheduleInput {
	billing_basis: InvoiceScheduleBillingBasis;
	fixed_amount?: number | null;
	frequency: InvoiceScheduleFrequency;
	day_of_month?: number | null;
	day_of_week?: Weekday | null;
	generate_days_before?: number;
	payment_terms_days?: number;
	auto_send?: boolean;
	memo_template?: string | null;
}

export const OccurrenceStatusValues = [
	"planned",
	"generated",
	"skipped",
	"cancelled",
	"completed",
] as const;

export type OccurrenceStatus = (typeof OccurrenceStatusValues)[number];

export const OccurrenceStatusLabels: Record<OccurrenceStatus, string> = {
	planned: "Planned",
	generated: "Generated",
	skipped: "Skipped",
	cancelled: "Cancelled",
	completed: "Completed",
};

export const OccurrenceStatusColors: Record<OccurrenceStatus, string> = {
	planned: "bg-primary/20 text-primary-text border-primary/30",
	generated: "bg-reviewing/20 text-reviewing-text border-reviewing/30",
	skipped: "bg-warning/20 text-warning-text border-warning/30",
	cancelled: "bg-error/20 text-error-text border-error/30",
	completed: "bg-success/20 text-success-text border-success/30",
};

// ============================================================================
// RECURRING PLAN TYPES
// ============================================================================

export interface RecurringRuleWeekday {
	id: string;
	recurring_rule_id: string;
	weekday: Weekday;
}

export interface RecurringRule {
	id: string;
	recurring_plan_id: string;
	frequency: RecurringFrequency;
	interval: number;
	by_weekday?: RecurringRuleWeekday[];
	by_month_day?: number | null;
	by_month?: number | null;

	arrival_constraint: ArrivalConstraint;
	finish_constraint: FinishConstraint;
	arrival_time?: string | null; // HH:MM format
	arrival_window_start?: string | null; // HH:MM format
	arrival_window_end?: string | null; // HH:MM format
	finish_time?: string | null; // HH:MM format

	created_at: Date | string;
}

export interface RecurringPlanLineItem {
	id: string;
	recurring_plan_id: string;
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	item_type?: LineItemType | null;
	sort_order: number;
	created_at: Date | string;
	isNew?: boolean; // Frontend only - marks items created in form
	isDeleted?: boolean; // Frontend only - soft delete marker
	/** Catalog link, when the line was picked from inventory rather than typed. */
	inventory_item_id?: string | null;
	/** Inherited by every visit this template generates. */
	disposition?: LineItemDisposition | null;
	disposition_vehicle_id?: string | null;
}

export interface RecurringOccurrence {
	id: string;
	recurring_plan_id: string;
	occurrence_start_at: Date | string;
	occurrence_end_at: Date | string;
	status: OccurrenceStatus;
	arrival_constraint: ArrivalConstraint;
	finish_constraint: FinishConstraint;
	arrival_time?: string | null;
	arrival_window_start?: string | null;
	arrival_window_end?: string | null;
	finish_time?: string | null;
	job_visit_id?: string | null;
	job_visit?: VisitReference | null;
	generated_at?: Date | string | null;
	completed_at?: Date | string | null;
	skipped_at?: Date | string | null;
	skip_reason?: string | null;
	template_version: number;
	created_at: Date | string;
}

export interface RecurringPlanNote extends BaseNote {
	recurring_plan_id: string;
}

export interface RecurringPlanSummary {
	id: string;
	name: string;
	client_id: string;
	address: string;
	priority: Priority;
	status: RecurringPlanStatus;
	starts_at: Date | string;
	ends_at?: Date | string | null;
}

export interface RecurringPlan {
	id: string;
	organization_id?: string | null;
	client_id: string;
	name: string;
	description: string;
	address: string;
	coords?: Coordinates | null;
	priority: Priority;
	status: RecurringPlanStatus;
	starts_at: Date | string;
	ends_at?: Date | string | null;
	timezone: string;
	generation_window_days: number;
	min_advance_days: number;
	billing_mode: BillingMode;
	invoice_timing: InvoiceTiming;
	auto_invoice: boolean;
	created_at: Date | string;
	updated_at: Date | string;
	created_by_dispatcher_id?: string | null;

	client?: ClientWithPrimaryContact;
	job_container?: JobSummary | null;
	created_by_dispatcher?: DispatcherReference | null;
	rules?: RecurringRule[];
	line_items?: RecurringPlanLineItem[];
	occurrences?: RecurringOccurrence[];
	notes?: RecurringPlanNote[];
	invoice_schedule?: InvoiceSchedule | null;
}

// ============================================================================
// RESPONSE TYPES
// ============================================================================

export interface OccurrenceGenerationResult {
	generated: number;
	skipped: number;
	start_date: Date | string;
	end_date: Date | string;
}

export interface VisitGenerationResult {
	visit_id: string;
	occurrence_id: string;
	scheduled_start_at: Date | string;
	scheduled_end_at: Date | string;
	template_version: number;
}

export interface RecurringPlanResponse {
	err: string;
	data: RecurringPlan[];
}

export interface RecurringOccurrenceResponse {
	err: string;
	data: RecurringOccurrence[];
}

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

export const CreateRecurringPlanSchema = z
	.object({
		client_id: z.string().uuid("Invalid client ID"),
		name: z.string().min(1, "Plan name is required"),
		description: z.string().min(1, "Description is required"),
		address: z.string().min(1, "Address is required"),
		coords: z
			.object({
				lat: z.number(),
				lon: z.number(),
			})
			.optional(),
		priority: z.enum(PriorityValues).default("Medium"),

		starts_at: z.string().datetime("Invalid start date"),
		ends_at: z.string().datetime("Invalid end date").optional().nullable(),
		timezone: z.string().default("America/Chicago"),
		generation_window_days: z.number().int().min(1).max(365).default(90),
		min_advance_days: z.number().int().min(1).max(90).default(14),

		billing_mode: z.enum(BillingModeValues).default("per_visit"),
		invoice_timing: z.enum(InvoiceTimingValues).default("on_completion"),
		auto_invoice: z.boolean().default(false),

		rule: z.object({
			frequency: z.enum(RecurringFrequencyValues),
			interval: z.number().int().min(1).max(365).default(1),
			by_weekday: z.array(z.enum(WeekdayValues)).optional().nullable(),
			by_month_day: z.number().int().min(1).max(31).optional().nullable(),
			by_month: z.number().int().min(1).max(12).optional().nullable(),

			arrival_constraint: z.enum(ArrivalConstraintValues),
			finish_constraint: z.enum(FinishConstraintValues),
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
		}),

		line_items: z
			.array(
				z.object({
					name: z.string().min(1, "Item name is required"),
					description: z.string().optional().nullable(),
					quantity: z.number().positive("Quantity must be positive"),
					unit_price: z
						.number()
						.nonnegative("Unit price must be non-negative"),
					item_type: z.enum(LineItemTypeValues).optional().nullable(),
					sort_order: z.number().int().min(0).optional(),
					inventory_item_id: z.string().uuid().nullable().optional(),
					disposition: z.enum(LineItemDispositionValues).nullable().optional(),
					disposition_vehicle_id: z.string().uuid().nullable().optional(),
				})
			)
			.optional(),

		invoice_schedule: z.object({
			billing_basis: z.enum(InvoiceScheduleBillingBasisValues),
			fixed_amount: z.number().min(0).optional().nullable(),
			frequency: z.enum(InvoiceScheduleFrequencyValues),
			day_of_month: z.number().int().min(1).max(31).optional().nullable(),
			day_of_week: z.enum(WeekdayValues).optional().nullable(),
			generate_days_before: z.number().int().min(0).optional().default(0),
			payment_terms_days: z.number().int().min(0).optional().default(30),
			auto_send: z.boolean().optional().default(false),
			memo_template: z.string().optional().nullable(),
		}).optional(),
	})
	.refine(
		(data) => {
			if (
				data.rule.frequency === "weekly" &&
				(!data.rule.by_weekday || data.rule.by_weekday.length === 0)
			) {
				return false;
			}
			return true;
		},
		{
			message: "Weekly frequency requires at least one weekday",
			path: ["rule", "by_weekday"],
		}
	)
	.refine(
		(data) => {
			if (data.rule.frequency === "monthly" && !data.rule.by_month_day) {
				return false;
			}
			return true;
		},
		{
			message: "Monthly frequency requires by_month_day",
			path: ["rule", "by_month_day"],
		}
	)
	.refine(
		(data) => {
			if (data.rule.frequency === "yearly" && !data.rule.by_month) {
				return false;
			}
			return true;
		},
		{
			message: "Yearly frequency requires by_month",
			path: ["rule", "by_month"],
		}
	)
	.refine(
		(data) => {
			if (data.rule.arrival_constraint === "at" && !data.rule.arrival_time) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival time is required when constraint is 'at'",
			path: ["rule", "arrival_time"],
		}
	)
	.refine(
		(data) => {
			if (
				data.rule.arrival_constraint === "between" &&
				(!data.rule.arrival_window_start || !data.rule.arrival_window_end)
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival window start and end are required for 'between' constraint",
			path: ["rule", "arrival_window_start"],
		}
	)
	.refine(
		(data) => {
			if (
				data.rule.arrival_constraint === "by" &&
				!data.rule.arrival_window_end
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival deadline is required for 'by' constraint",
			path: ["rule", "arrival_window_end"],
		}
	)
	.refine(
		(data) => {
			if (
				(data.rule.finish_constraint === "at" ||
					data.rule.finish_constraint === "by") &&
				!data.rule.finish_time
			) {
				return false;
			}
			return true;
		},
		{
			message: "Finish time is required for 'at' or 'by' constraint",
			path: ["rule", "finish_time"],
		}
	)
	.refine(
		(data) => {
			if (data.ends_at) {
				return new Date(data.ends_at) > new Date(data.starts_at);
			}
			return true;
		},
		{
			message: "End date must be after start date",
			path: ["ends_at"],
		}
	);

export const UpdateRecurringPlanSchema = z
	.object({
		name: z.string().min(1, "Plan name is required").optional(),
		description: z.string().min(1, "Description is required").optional(),
		address: z.string().min(1, "Address is required").optional(),
		coords: z
			.object({
				lat: z.number(),
				lon: z.number(),
			})
			.optional(),
		priority: z.enum(PriorityValues).optional(),
		starts_at: z.string().datetime("Invalid start date").optional(),
		ends_at: z.string().datetime("Invalid end date").optional().nullable(),
		timezone: z.string().optional(),
		generation_window_days: z.number().int().min(1).max(365).optional(),
		min_advance_days: z.number().int().min(1).max(90).optional(),
		billing_mode: z.enum(BillingModeValues).optional(),
		invoice_timing: z.enum(InvoiceTimingValues).optional(),
		auto_invoice: z.boolean().optional(),
		status: z.enum(RecurringPlanStatusValues).optional(),

		rule: z
			.object({
				frequency: z.enum(RecurringFrequencyValues),
				interval: z.number().int().min(1).max(365).default(1),
				by_weekday: z.array(z.enum(WeekdayValues)).optional().nullable(),
				by_month_day: z.number().int().min(1).max(31).optional().nullable(),
				by_month: z.number().int().min(1).max(12).optional().nullable(),

				arrival_constraint: z.enum(ArrivalConstraintValues),
				finish_constraint: z.enum(FinishConstraintValues),
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
			})
			.optional(),

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
					item_type: z.enum(LineItemTypeValues).optional().nullable(),
					sort_order: z.number().int().min(0).optional(),
					inventory_item_id: z.string().uuid().nullable().optional(),
					disposition: z.enum(LineItemDispositionValues).nullable().optional(),
					disposition_vehicle_id: z.string().uuid().nullable().optional(),
				})
			)
			.optional(),

		invoice_schedule: z.object({
			billing_basis: z.enum(InvoiceScheduleBillingBasisValues),
			fixed_amount: z.number().min(0).optional().nullable(),
			frequency: z.enum(InvoiceScheduleFrequencyValues),
			day_of_month: z.number().int().min(1).max(31).optional().nullable(),
			day_of_week: z.enum(WeekdayValues).optional().nullable(),
			generate_days_before: z.number().int().min(0).optional().default(0),
			payment_terms_days: z.number().int().min(0).optional().default(30),
			auto_send: z.boolean().optional().default(false),
			memo_template: z.string().optional().nullable(),
		}).optional(),
	})
	.refine(
		(data) => {
			if (data.starts_at && data.ends_at) {
				return new Date(data.ends_at) > new Date(data.starts_at);
			}
			return true;
		},
		{
			message: "End date must be after start date",
			path: ["ends_at"],
		}
	)
	.refine(
		(data) => {
			if (
				data.rule &&
				data.rule.frequency === "weekly" &&
				(!data.rule.by_weekday || data.rule.by_weekday.length === 0)
			) {
				return false;
			}
			return true;
		},
		{
			message: "Weekly frequency requires at least one weekday",
			path: ["rule", "by_weekday"],
		}
	)
	.refine(
		(data) => {
			if (
				data.rule &&
				data.rule.frequency === "monthly" &&
				!data.rule.by_month_day
			) {
				return false;
			}
			return true;
		},
		{
			message: "Monthly frequency requires by_month_day",
			path: ["rule", "by_month_day"],
		}
	)
	.refine(
		(data) => {
			if (data.rule && data.rule.frequency === "yearly" && !data.rule.by_month) {
				return false;
			}
			return true;
		},
		{
			message: "Yearly frequency requires by_month",
			path: ["rule", "by_month"],
		}
	)
	.refine(
		(data) => {
			if (!data.rule) return true;
			if (data.rule.arrival_constraint === "at" && !data.rule.arrival_time) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival time is required when constraint is 'at'",
			path: ["rule", "arrival_time"],
		}
	)
	.refine(
		(data) => {
			if (!data.rule) return true;
			if (
				data.rule.arrival_constraint === "between" &&
				(!data.rule.arrival_window_start || !data.rule.arrival_window_end)
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival window start and end are required for 'between' constraint",
			path: ["rule", "arrival_window_start"],
		}
	)
	.refine(
		(data) => {
			if (!data.rule) return true;
			if (
				data.rule.arrival_constraint === "by" &&
				!data.rule.arrival_window_end
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival deadline is required for 'by' constraint",
			path: ["rule", "arrival_window_end"],
		}
	)
	.refine(
		(data) => {
			if (!data.rule) return true;
			if (
				(data.rule.finish_constraint === "at" ||
					data.rule.finish_constraint === "by") &&
				!data.rule.finish_time
			) {
				return false;
			}
			return true;
		},
		{
			message: "Finish time is required for 'at' or 'by' constraint",
			path: ["rule", "finish_time"],
		}
	);

export const UpdateRecurringPlanLineItemsSchema = z.object({
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
				item_type: z.enum(LineItemTypeValues).optional().nullable(),
				sort_order: z.number().int().min(0).optional(),
				inventory_item_id: z.string().uuid().nullable().optional(),
				disposition: z.enum(LineItemDispositionValues).nullable().optional(),
				disposition_vehicle_id: z.string().uuid().nullable().optional(),
			})
		)
		.min(1, "At least one line item is required"),
});

export const GenerateOccurrencesSchema = z.object({
	days_ahead: z.number().int().min(1).max(365).default(30),
});

export const SkipOccurrenceSchema = z.object({
	skip_reason: z.string().min(1, "Skip reason is required"),
});

export const RescheduleOccurrenceSchema = z.object({
	new_start_at: z.string().datetime("Invalid start date"),
	new_end_at: z.string().datetime("Invalid end date").optional(),
	scope: z.enum(["this", "future"]).optional(),
	arrival_constraint:   z.enum(ArrivalConstraintValues).optional(),
	finish_constraint:    z.enum(FinishConstraintValues).optional(),
	arrival_time:         z.string().nullable().optional(),
	arrival_window_start: z.string().nullable().optional(),
	arrival_window_end:   z.string().nullable().optional(),
	finish_time:          z.string().nullable().optional(),
});

export const BulkSkipOccurrencesSchema = z.object({
	occurrence_ids: z.array(z.string().uuid()).min(1, "At least one occurrence ID required"),
	skip_reason: z.string().min(1, "Skip reason is required"),
});

export const BulkRescheduleOccurrencesSchema = z.object({
	occurrence_ids: z.array(z.string().uuid()).min(1, "At least one occurrence ID required"),
	offset_days: z.number().int().min(-365).max(365),
});

export const CreateRecurringPlanNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

export const UpdateRecurringPlanNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

// ============================================================================
// TYPE EXPORTS FROM ZOD SCHEMAS
// ============================================================================

export type CreateRecurringPlanInput = z.infer<typeof CreateRecurringPlanSchema>;
export type UpdateRecurringPlanInput = z.infer<typeof UpdateRecurringPlanSchema>;
export type UpdateRecurringPlanLineItemsInput = z.infer<typeof UpdateRecurringPlanLineItemsSchema>;
export type GenerateOccurrencesInput = z.infer<typeof GenerateOccurrencesSchema>;
export type SkipOccurrenceInput = z.infer<typeof SkipOccurrenceSchema>;
export type RescheduleOccurrenceInput = z.infer<typeof RescheduleOccurrenceSchema>;
export type BulkSkipOccurrencesInput = z.infer<typeof BulkSkipOccurrencesSchema>;
export type BulkRescheduleOccurrencesInput = z.infer<typeof BulkRescheduleOccurrencesSchema>;
export type CreateRecurringPlanNoteInput = z.infer<typeof CreateRecurringPlanNoteSchema>;
export type UpdateRecurringPlanNoteInput = z.infer<typeof UpdateRecurringPlanNoteSchema>;

// ============================================================================
// TYPE GUARDS & HELPERS
// ============================================================================

export function isActiveRecurringPlan(plan: RecurringPlan | RecurringPlanSummary): boolean {
	return plan.status === "Active";
}

export function isPausedRecurringPlan(plan: RecurringPlan | RecurringPlanSummary): boolean {
	return plan.status === "Paused";
}

export function isCompletedRecurringPlan(plan: RecurringPlan | RecurringPlanSummary): boolean {
	return plan.status === "Completed";
}

export function isCancelledRecurringPlan(plan: RecurringPlan | RecurringPlanSummary): boolean {
	return plan.status === "Cancelled";
}

export function isPlannedOccurrence(occurrence: RecurringOccurrence): boolean {
	return occurrence.status === "planned";
}

export function isGeneratedOccurrence(occurrence: RecurringOccurrence): boolean {
	return occurrence.status === "generated";
}

export function formatRecurringSchedule(rule: RecurringRule): string {
	const { frequency, interval, by_weekday, by_month_day, by_month } = rule;

	if (frequency === "daily") {
		return interval === 1 ? "Daily" : `Every ${interval} days`;
	}

	if (frequency === "weekly") {
		const days = by_weekday?.map((wd) => WeekdayShortLabels[wd.weekday]).join(", ");
		return interval === 1 ? `Weekly on ${days}` : `Every ${interval} weeks on ${days}`;
	}

	if (frequency === "monthly") {
		const day = by_month_day;
		return interval === 1
			? `Monthly on day ${day}`
			: `Every ${interval} months on day ${day}`;
	}

	if (frequency === "yearly") {
		const monthNames = [
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		];
		const month = by_month ? monthNames[by_month - 1] : "";
		const day = by_month_day;
		return interval === 1
			? `Yearly on ${month} ${day}`
			: `Every ${interval} years on ${month} ${day}`;
	}

	return "Unknown schedule";
}

export function calculateTemplateTotal(lineItems: RecurringPlanLineItem[]): number {
	return lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
}

export function formatScheduleConstraints(rule: RecurringRule): string {
	const {
		arrival_constraint,
		finish_constraint,
		arrival_time,
		arrival_window_start,
		arrival_window_end,
		finish_time,
	} = rule;

	let arrivalStr = "";
	switch (arrival_constraint) {
		case "anytime":
			arrivalStr = "Arrive anytime";
			break;
		case "at":
			arrivalStr = `Arrive at ${arrival_time}`;
			break;
		case "between":
			arrivalStr = `Arrive between ${arrival_window_start} - ${arrival_window_end}`;
			break;
		case "by":
			arrivalStr = `Arrive by ${arrival_window_end}`;
			break;
	}

	let finishStr = "";
	switch (finish_constraint) {
		case "when_done":
			finishStr = "finish when done";
			break;
		case "at":
			finishStr = `finish at ${finish_time}`;
			break;
		case "by":
			finishStr = `finish by ${finish_time}`;
			break;
	}

	return `${arrivalStr}, ${finishStr}`;
}
