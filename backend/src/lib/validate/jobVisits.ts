import z from "zod";
import { dispositionFieldsSchema } from "./shared.js";

export const ArrivalConstraintValues = [
	"anytime",
	"at",
	"between",
	"by",
] as const;
export const FinishConstraintValues = ["when_done", "at", "by"] as const;

// ── Line item sub-schema (reused in both create and update contexts) ──────────
const visitLineItemInputSchema = z.object({
	// Present on existing items being updated; absent on new items being created
	id: z.string().uuid().optional(),
	name: z.string().min(1, "Item name is required"),
	description: z.string().optional().nullable(),
	quantity: z.number().positive("Quantity must be positive"),
	unit_price: z.number().min(0, "Unit price must be non-negative"),
	total: z.number().min(0, "Total must be non-negative").optional(),
	item_type: z
		.enum(["labor", "material", "equipment", "other"])
		.optional()
		.nullable(),
	sort_order: z.number().int().min(0).optional(),
	tax_group_id: z.string().uuid().nullable().optional(),
	taxable: z.boolean().optional(),
	// Unlike quotes and jobs this link has teeth: it drives readiness and the
	// completion deduction.
	inventory_item_id: z.string().uuid().nullable().optional(),
	...dispositionFieldsSchema,
});

export const createJobVisitSchema = z
	.object({
		job_id: z.string().uuid("Invalid job ID"),

		name: z.string().min(1, "Visit name is required").max(255),
		description: z.string().optional().nullable(),

		arrival_constraint: z.enum(ArrivalConstraintValues),
		finish_constraint: z.enum(FinishConstraintValues),
		scheduled_start_at: z.preprocess(
			(arg) => (typeof arg === "string" ? new Date(arg) : arg),
			z.date({ message: "Scheduled start time is required" }),
		),
		scheduled_end_at: z.preprocess(
			(arg) => (typeof arg === "string" ? new Date(arg) : arg),
			z.date({ message: "Scheduled end time is required" }),
		),

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
		tech_ids: z.array(z.string().uuid("Invalid technician ID")).optional(),
		line_items: z.array(visitLineItemInputSchema).optional(),
	})
	.refine(
		(data) => {
			return data.scheduled_end_at > data.scheduled_start_at;
		},
		{
			message: "Scheduled end time must be after scheduled start time",
			path: ["scheduled_end_at"],
		},
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
		},
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
			message:
				"Arrival window start and end are required for 'between' constraint",
			path: ["arrival_window_start"],
		},
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
		},
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
		},
	)
	.refine(
		(data) => {
			if (
				data.arrival_constraint === "between" &&
				data.arrival_window_start &&
				data.arrival_window_end
			) {
				const [startHour, startMin] = data.arrival_window_start
					.split(":")
					.map(Number);
				const [endHour, endMin] = data.arrival_window_end
					.split(":")
					.map(Number);
				return endHour * 60 + endMin > startHour * 60 + startMin;
			}
			return true;
		},
		{
			message: "Arrival window end must be after arrival window start",
			path: ["arrival_window_end"],
		},
	);

export const updateJobVisitSchema = z
	.object({
		name: z.string().min(1).max(255).optional(),
		description: z.string().optional().nullable(),
		arrival_constraint: z.enum(ArrivalConstraintValues).optional(),
		finish_constraint: z.enum(FinishConstraintValues).optional(),

		scheduled_start_at: z
			.preprocess((arg) => {
				if (!arg) return undefined;
				return typeof arg === "string" ? new Date(arg) : arg;
			}, z.date().optional())
			.optional(),
		scheduled_end_at: z
			.preprocess((arg) => {
				if (!arg) return undefined;
				return typeof arg === "string" ? new Date(arg) : arg;
			}, z.date().optional())
			.optional(),

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

		actual_start_at: z
			.preprocess((arg) => {
				if (!arg) return null;
				return typeof arg === "string" ? new Date(arg) : arg;
			}, z.date().nullable())
			.optional(),
		actual_end_at: z
			.preprocess((arg) => {
				if (!arg) return null;
				return typeof arg === "string" ? new Date(arg) : arg;
			}, z.date().nullable())
			.optional(),

		status: z
			.enum([
				"Scheduled",
				"Driving",
				"OnSite",
				"InProgress",
				"Paused",
				"Delayed",
				"Completed",
				"Cancelled",
			])
			.optional(),

		// Full replacement array — undefined means "don't touch line items"
		line_items: z.array(visitLineItemInputSchema).optional(),

		reschedule_scope: z.enum(["this", "future"]).optional(),
	})
	.refine(
		(data) => {
			if (data.scheduled_start_at && data.scheduled_end_at) {
				return data.scheduled_end_at > data.scheduled_start_at;
			}
			return true;
		},
		{
			message: "Scheduled end time must be after scheduled start time",
			path: ["scheduled_end_at"],
		},
	)
	.refine(
		(data) => {
			if (
				data.actual_start_at &&
				data.actual_end_at &&
				data.actual_start_at instanceof Date &&
				data.actual_end_at instanceof Date
			) {
				return data.actual_end_at > data.actual_start_at;
			}
			return true;
		},
		{
			message: "Actual end time must be after actual start time",
			path: ["actual_end_at"],
		},
	)
	.refine(
		(data) => {
			if (!data.arrival_constraint) return true;
			if (
				data.arrival_constraint === "at" &&
				data.arrival_time === undefined
			) {
				return false;
			}
			return true;
		},
		{
			message: "Arrival time is required when constraint is 'at'",
			path: ["arrival_time"],
		},
	)
	.refine(
		(data) => {
			if (!data.arrival_constraint) return true;
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
			message:
				"Arrival window start and end are required for 'between' constraint",
			path: ["arrival_window_start"],
		},
	)
	.refine(
		(data) => {
			if (!data.arrival_constraint) return true;
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
		},
	)
	.refine(
		(data) => {
			if (!data.finish_constraint) return true;
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
		},
	)
	.refine(
		(data) => {
			if (data.arrival_window_start && data.arrival_window_end) {
				const [startHour, startMin] = data.arrival_window_start
					.split(":")
					.map(Number);
				const [endHour, endMin] = data.arrival_window_end
					.split(":")
					.map(Number);
				return endHour * 60 + endMin > startHour * 60 + startMin;
			}
			return true;
		},
		{
			message: "Arrival window end must be after arrival window start",
			path: ["arrival_window_end"],
		},
	);

export type CreateJobVisitInput = z.infer<typeof createJobVisitSchema>;
export type UpdateJobVisitInput = z.infer<typeof updateJobVisitSchema>;
