import z from "zod";
import { coordsSchema, dispositionFieldsSchema } from "./shared.js";

// ============================================================================
// INVOICE SCHEDULE
// ============================================================================

export const invoiceScheduleSchema = z
	.object({
		billing_basis: z.enum(["visit_actuals", "plan_line_items", "fixed_amount"]),
		fixed_amount: z.number().min(0).optional().nullable(),
		frequency: z.enum([
			"on_visit_completion",
			"weekly",
			"biweekly",
			"monthly",
			"quarterly",
		]),
		day_of_month: z.number().int().min(1).max(31).optional().nullable(),
		day_of_week: z
			.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"])
			.optional()
			.nullable(),
		generate_days_before: z.number().int().min(0).optional().default(0),
		payment_terms_days: z.number().int().min(0).optional().default(30),
		auto_send: z.boolean().optional().default(false),
		memo_template: z.string().optional().nullable(),
	})
	.refine(
		(d) => d.billing_basis !== "fixed_amount" || (d.fixed_amount != null && d.fixed_amount >= 0),
		{ message: "fixed_amount is required when billing_basis is 'fixed_amount'", path: ["fixed_amount"] },
	)
	.refine(
		(d) =>
			!["weekly", "biweekly"].includes(d.frequency) || d.day_of_week != null,
		{ message: "day_of_week is required for weekly and biweekly schedules", path: ["day_of_week"] },
	)
	.refine(
		(d) =>
			!["monthly", "quarterly"].includes(d.frequency) || d.day_of_month != null,
		{ message: "day_of_month is required for monthly and quarterly schedules", path: ["day_of_month"] },
	);

export const updateInvoiceScheduleSchema = invoiceScheduleSchema;

export const ArrivalConstraintValues = [
	"anytime",
	"at",
	"between",
	"by",
] as const;
export const FinishConstraintValues = ["when_done", "at", "by"] as const;

export const createRecurringPlanSchema = z
	.object({
		client_id: z.string().uuid("Invalid client ID"),
		name: z.string().min(1, "Plan name is required"),
		description: z.string().min(1, "Description is required"),
		address: z.string().min(1, "Address is required"),
		coords: coordsSchema,
		priority: z
			.enum(["Low", "Medium", "High", "Urgent", "Emergency"])
			.optional()
			.default("Medium"),

		starts_at: z.string().datetime("Invalid start date"),
		ends_at: z.string().datetime("Invalid end date").optional().nullable(),
		timezone: z.string().optional().default("UTC"),
		generation_window_days: z
			.number()
			.int()
			.min(1)
			.max(365)
			.optional()
			.default(90),
		min_advance_days: z
			.number()
			.int()
			.min(1)
			.max(90)
			.optional()
			.default(14),

		billing_mode: z
			.enum(["per_visit", "subscription", "none"])
			.optional()
			.default("per_visit"),
		invoice_timing: z
			.enum(["on_completion", "on_schedule_date", "manual"])
			.optional()
			.default("on_completion"),
		auto_invoice: z.boolean().optional().default(false),

		rule: z.object({
			frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
			interval: z.number().int().min(1).max(365).default(1),
			by_weekday: z
				.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
				.optional()
				.nullable(),
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
						.min(0, "Unit price must be non-negative"),
					item_type: z
						.enum(["labor", "material", "equipment", "other"])
						.optional()
						.nullable(),
					sort_order: z.number().int().min(0).optional(),
					inventory_item_id: z.string().uuid().nullable().optional(),
					...dispositionFieldsSchema,
				}),
			)
			.optional(),

		invoice_schedule: invoiceScheduleSchema.optional(),
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
		},
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
		},
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
		},
	)
	.refine(
		(data) => {
			if (
				data.rule.arrival_constraint === "at" &&
				!data.rule.arrival_time
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival time is required when constraint is 'at'",
			path: ["rule", "arrival_time"],
		},
	)
	.refine(
		(data) => {
			if (
				data.rule.arrival_constraint === "between" &&
				(!data.rule.arrival_window_start ||
					!data.rule.arrival_window_end)
			) {
				return false;
			}
			return true;
		},
		{
			message:
				"Arrival window start and end are required for 'between' constraint",
			path: ["rule", "arrival_window_start"],
		},
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
		},
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
		},
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
		},
	)
	.transform((data) => ({
		...data,
		coords: data.coords || undefined,
		ends_at: data.ends_at || undefined,
		rule: {
			...data.rule,
			by_weekday: data.rule.by_weekday || undefined,
			by_month_day: data.rule.by_month_day || undefined,
			by_month: data.rule.by_month || undefined,
			arrival_time: data.rule.arrival_time || undefined,
			arrival_window_start: data.rule.arrival_window_start || undefined,
			arrival_window_end: data.rule.arrival_window_end || undefined,
			finish_time: data.rule.finish_time || undefined,
		},
		line_items: data.line_items
			? data.line_items.map((item, idx) => ({
					...item,
					description: item.description || undefined,
					item_type: item.item_type || undefined,
					sort_order: item.sort_order ?? idx,
				}))
			: undefined,
	}));

export const updateRecurringPlanSchema = z
	.object({
		name: z.string().min(1, "Plan name is required").optional(),
		description: z.string().min(1, "Description is required").optional(),
		address: z.string().min(1, "Address is required").optional(),
		coords: coordsSchema.optional(),
		priority: z
			.enum(["Low", "Medium", "High", "Urgent", "Emergency"])
			.optional(),

		starts_at: z.string().datetime("Invalid start date").optional(),
		ends_at: z.string().datetime("Invalid end date").optional().nullable(),
		timezone: z.string().optional(),
		generation_window_days: z.number().int().min(1).max(365).optional(),
		min_advance_days: z.number().int().min(1).max(90).optional(),

		billing_mode: z.enum(["per_visit", "subscription", "none"]).optional(),
		invoice_timing: z
			.enum(["on_completion", "on_schedule_date", "manual"])
			.optional(),
		auto_invoice: z.boolean().optional(),

		status: z
			.enum(["Active", "Paused", "Completed", "Cancelled"])
			.optional(),

		rule: z
			.object({
				frequency: z.enum(["daily", "weekly", "monthly", "yearly"]),
				interval: z.number().int().min(1).max(365).default(1),
				by_weekday: z
					.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
					.optional()
					.nullable(),
				by_month_day: z
					.number()
					.int()
					.min(1)
					.max(31)
					.optional()
					.nullable(),
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
						.min(0, "Unit price must be non-negative"),
					item_type: z
						.enum(["labor", "material", "equipment", "other"])
						.optional()
						.nullable(),
					sort_order: z.number().int().min(0).optional(),
					inventory_item_id: z.string().uuid().nullable().optional(),
					...dispositionFieldsSchema,
				}),
			)
			.optional(),

		invoice_schedule: invoiceScheduleSchema.optional(),
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
		},
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
		},
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
		},
	)
	.refine(
		(data) => {
			if (
				data.rule &&
				data.rule.frequency === "yearly" &&
				!data.rule.by_month
			) {
				return false;
			}
			return true;
		},
		{
			message: "Yearly frequency requires by_month",
			path: ["rule", "by_month"],
		},
	)
	.refine(
		(data) => {
			if (!data.rule) return true;
			if (
				data.rule.arrival_constraint === "at" &&
				!data.rule.arrival_time
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival time is required when constraint is 'at'",
			path: ["rule", "arrival_time"],
		},
	)
	.refine(
		(data) => {
			if (!data.rule) return true;
			if (
				data.rule.arrival_constraint === "between" &&
				(!data.rule.arrival_window_start ||
					!data.rule.arrival_window_end)
			) {
				return false;
			}
			return true;
		},
		{
			message:
				"Arrival window start and end are required for 'between' constraint",
			path: ["rule", "arrival_window_start"],
		},
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
		},
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
		},
	)
	.refine(
		(data) => {
			if (data.line_items && data.line_items.length === 0) {
				return false;
			}
			return true;
		},
		{
			message:
				"At least one line item is required when updating line items",
			path: ["line_items"],
		},
	)
	.transform((data) => ({
		...data,
		coords: data.coords ?? undefined,
		ends_at: data.ends_at === null ? null : data.ends_at,
	}));

export const updateRecurringPlanLineItemsSchema = z.object({
	line_items: z
		.array(
			z.object({
				id: z.string().uuid().optional(),
				name: z.string().min(1, "Item name is required"),
				description: z.string().optional().nullable(),
				quantity: z.number().positive("Quantity must be positive"),
				unit_price: z
					.number()
					.min(0, "Unit price must be non-negative"),
				item_type: z
					.enum(["labor", "material", "equipment", "other"])
					.optional()
					.nullable(),
				sort_order: z.number().int().min(0).optional(),
				inventory_item_id: z.string().uuid().nullable().optional(),
				...dispositionFieldsSchema,
			}),
		)
		.min(1, "At least one line item is required"),
});

// Occurrence schemas
export const generateOccurrencesSchema = z.object({
	days_ahead: z.number().int().min(1).max(365).optional().default(30),
});

export const skipOccurrenceSchema = z.object({
	skip_reason: z.string().min(1, "Skip reason is required"),
});

export const rescheduleOccurrenceSchema = z.object({
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

export const bulkSkipOccurrencesSchema = z.object({
	occurrence_ids: z
		.array(z.string().uuid())
		.min(1, "At least one occurrence ID required"),
	skip_reason: z.string().min(1, "Skip reason is required"),
});

export const bulkRescheduleOccurrencesSchema = z.object({
	occurrence_ids: z
		.array(z.string().uuid())
		.min(1, "At least one occurrence ID required"),
	offset_days: z.number().int().min(-365).max(365),
});

export const createRecurringPlanNoteSchema = z.object({
	content: z.string().min(1, "Content is required"),
});

export const updateRecurringPlanNoteSchema = z
	.object({
		content: z.string().min(1, "Content is required").optional(),
	})
	.transform((data) => ({
		...data,
		content: data.content || undefined,
	}));

export type CreateRecurringPlanInput = z.infer<
	typeof createRecurringPlanSchema
>;
export type UpdateRecurringPlanInput = z.infer<
	typeof updateRecurringPlanSchema
>;
export type UpdateRecurringPlanLineItemsInput = z.infer<
	typeof updateRecurringPlanLineItemsSchema
>;
export type GenerateOccurrencesInput = z.infer<
	typeof generateOccurrencesSchema
>;
export type SkipOccurrenceInput = z.infer<typeof skipOccurrenceSchema>;
export type RescheduleOccurrenceInput = z.infer<
	typeof rescheduleOccurrenceSchema
>;
export type BulkSkipOccurrencesInput = z.infer<
	typeof bulkSkipOccurrencesSchema
>;
export type BulkRescheduleOccurrencesInput = z.infer<
	typeof bulkRescheduleOccurrencesSchema
>;
export type CreateRecurringPlanNoteInput = z.infer<
	typeof createRecurringPlanNoteSchema
>;
export type UpdateRecurringPlanNoteInput = z.infer<
	typeof updateRecurringPlanNoteSchema
>;
