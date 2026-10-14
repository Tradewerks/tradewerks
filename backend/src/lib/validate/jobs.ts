import z from "zod";
import { coordsSchema } from "./shared.js";
import { isOwnBucketUrl } from "../../services/wasabiService.js";

// Note photos must live in our own storage bucket: the URL is signed blindly on
// read, so an arbitrary URL would let a caller mint signed links for any key.
const notePhotoUrl = z
	.string()
	.url()
	.refine(isOwnBucketUrl, { message: "photo_url must point to the configured storage bucket" });

export const createJobSchema = z
	.object({
		name: z.string().min(1, "Job name is required").optional(),
		description: z.string().optional(),
		priority: z
			.enum(["Low", "Medium", "High", "Urgent", "Emergency"])
			.optional()
			.default("Medium"),
		client_id: z.string().uuid("Invalid client ID"),
		tech_ids: z.array(z.string().uuid("Invalid technician ID")).optional(),
		address: z.string().min(1, "Address is required").optional(),
		coords: coordsSchema.optional(),
		status: z
			.enum([
				"Unscheduled",
				"Scheduled",
				"InProgress",
				"Completed",
				"Cancelled",
			])
			.optional()
			.default("Unscheduled"),
		request_id: z.string().uuid().optional().nullable(),
		quote_id: z.string().uuid().optional().nullable(),
		recurring_plan_id: z.string().uuid().optional().nullable(),

		subtotal: z.number().min(0).optional(),
		tax_rate: z.number().min(0).max(1).optional(),
		tax_amount: z.number().min(0).optional(),
		discount_type: z.enum(["percent", "amount"]).optional().nullable(),
		discount_value: z.number().min(0).optional().nullable(),
		discount_amount: z.number().min(0).optional(),
		estimated_total: z.number().min(0).optional(),
		actual_total: z.number().min(0).optional(),
		cancellation_reason: z.string().optional(),

		line_items: z
			.array(
				z.object({
					name: z.string().min(1, "Item name is required"),
					description: z.string().optional().nullable(),
					quantity: z.number().positive("Quantity must be positive"),
					unit_price: z
						.number()
						.min(0, "Unit price must be non-negative"),
					total: z.number().min(0, "Total must be non-negative").optional(),
					item_type: z
						.enum(["labor", "material", "equipment", "other"])
						.optional()
						.nullable(),
					tax_group_id: z.string().uuid().nullable().optional(),
					taxable: z.boolean().optional(),
					// Reference only — job-level lines are billing containers.
					// Consumption is visit-scoped (deductInventoryForVisit).
					inventory_item_id: z.string().uuid().nullable().optional(),
				}),
			)
			.optional(),
	})
	.transform((data) => ({
		...data,
		name: data.name || undefined,
		description: data.description || undefined,
		address: data.address || undefined,
		coords: data.coords ?? undefined,
		request_id: data.request_id ?? undefined,
		quote_id: data.quote_id ?? undefined,
		recurring_plan_id: data.recurring_plan_id ?? undefined,
		subtotal: data.subtotal ?? undefined,
		tax_rate: data.tax_rate ?? undefined,
		tax_amount: data.tax_amount ?? undefined,
		discount_type: data.discount_type ?? undefined,
		discount_value: data.discount_value ?? undefined,
		discount_amount: data.discount_amount ?? undefined,
		estimated_total: data.estimated_total ?? undefined,
		actual_total: data.actual_total ?? undefined,
		cancellation_reason: data.cancellation_reason || undefined,
		line_items: data.line_items ?? undefined,
	}));

export const updateJobSchema = z
	.object({
		name: z.string().min(1).optional(),
		description: z.string().optional(),
		priority: z
			.enum(["Low", "Medium", "High", "Urgent", "Emergency"])
			.optional(),
		address: z.string().optional(),
		coords: coordsSchema.optional(),
		status: z
			.enum([
				"Unscheduled",
				"Scheduled",
				"InProgress",
				"Completed",
				"Cancelled",
			])
			.optional(),
		line_items: z
			.array(
				z.object({
					id: z.string().uuid().optional(), // undefined = create new
					name: z.string().min(1, "Item name is required"),
					description: z.string().optional().nullable(),
					quantity: z.number().positive("Quantity must be positive"),
					unit_price: z
						.number()
						.min(0, "Unit price must be non-negative"),
					total: z.number().min(0, "Total must be non-negative").optional(),
					item_type: z
						.enum(["labor", "material", "equipment", "other"])
						.optional()
						.nullable(),
					source: z
						.enum([
							"quote",
							"recurring_plan",
							"manual",
							"field_addition",
						])
						.optional(),
					tax_group_id: z.string().uuid().nullable().optional(),
					taxable: z.boolean().optional(),
					inventory_item_id: z.string().uuid().nullable().optional(),
				}),
			)
			.optional(),
		subtotal: z.number().min(0).optional(),
		tax_rate: z.number().min(0).max(1).optional(),
		tax_amount: z.number().min(0).optional(),
		discount_type: z.enum(["percent", "amount"]).optional().nullable(),
		discount_value: z.number().min(0).optional().nullable(),
		discount_amount: z.number().min(0).optional(),
		estimated_total: z.number().min(0).optional(),
		actual_total: z.number().min(0).optional(),
		cancellation_reason: z.string().optional(),
	})
	.transform((data) => ({
		...data,
		name: data.name || undefined,
		description: data.description || undefined,
		address: data.address || undefined,
		coords: data.coords ?? undefined,
		line_items: data.line_items ?? undefined,
		subtotal: data.subtotal ?? undefined,
		tax_rate: data.tax_rate ?? undefined,
		tax_amount: data.tax_amount ?? undefined,
		discount_type: data.discount_type ?? undefined,
		discount_value: data.discount_value ?? undefined,
		discount_amount: data.discount_amount ?? undefined,
		estimated_total: data.estimated_total ?? undefined,
		actual_total: data.actual_total ?? undefined,
		cancellation_reason: data.cancellation_reason || undefined,
	}));

export const createJobLineItemSchema = z
	.object({
		name: z.string().min(1, "Item name is required"),
		description: z.string().optional(),
		quantity: z.number().positive("Quantity must be positive"),
		unit_price: z.number().min(0, "Unit price must be non-negative"),
		total: z.number().min(0, "Total must be non-negative").optional(),
		source: z
			.enum(["quote", "recurring_plan", "manual", "field_addition"])
			.optional(),
		item_type: z
			.enum(["labor", "material", "equipment", "other"])
			.optional(),
		tax_group_id: z.string().uuid().nullable().optional(),
		taxable: z.boolean().optional(),
		inventory_item_id: z.string().uuid().nullable().optional(),
	})
	.transform((data) => ({
		...data,
		description: data.description || undefined,
		total:
			data.total !== undefined
				? data.total
				: data.quantity * data.unit_price,
		source: data.source || undefined,
		item_type: data.item_type || undefined,
	}));

export const updateJobLineItemSchema = z
	.object({
		name: z.string().min(1, "Item name is required").optional(),
		description: z.string().optional(),
		quantity: z.number().positive("Quantity must be positive").optional(),
		unit_price: z
			.number()
			.min(0, "Unit price must be non-negative")
			.optional(),
		total: z.number().min(0, "Total must be non-negative").optional(),
		source: z
			.enum(["quote", "recurring_plan", "manual", "field_addition"])
			.optional(),
		item_type: z
			.enum(["labor", "material", "equipment", "other"])
			.optional(),
		tax_group_id: z.string().uuid().nullable().optional(),
		taxable: z.boolean().optional(),
		inventory_item_id: z.string().uuid().nullable().optional(),
	})
	.transform((data) => ({
		...data,
		name: data.name || undefined,
		description: data.description || undefined,
		quantity: data.quantity ?? undefined,
		unit_price: data.unit_price ?? undefined,
		total: data.total ?? undefined,
		source: data.source || undefined,
		item_type: data.item_type || undefined,
	}));

export const createJobNoteSchema = z
	.object({
		content:           z.string(),
		visit_id:          z.string().uuid("Invalid visit ID").optional().nullable(),
		notify_technician: z.boolean().default(false),
		photos: z
			.array(
				z.object({
					photo_url:   notePhotoUrl,
					photo_label: z.enum(["Before", "After", "Other"]),
				}),
			)
			.optional()
			.default([]),
	})
	.refine(
		(data) => data.content.trim().length > 0 || (data.photos ?? []).length > 0,
		{ message: "Content or at least one photo is required", path: ["content"] },
	)
	.transform((data) => ({
		content:           data.content,
		visit_id:          data.visit_id || null,
		notify_technician: data.notify_technician ?? false,
		photos:            data.photos ?? [],
	}));

export const updateJobNoteSchema = z.object({
	content: z.string().min(1, "Content is required").optional(),
	visit_id: z.string().uuid("Invalid visit ID").optional().nullable(),
	photos: z.array(
		z.object({
			id: z.string().uuid().optional(),
			photo_url: notePhotoUrl,
			photo_label: z.enum(["Before", "After", "Other"]),
		}),
	).optional(),
});
export type CreateJobInput = z.infer<typeof createJobSchema>;
export type UpdateJobInput = z.infer<typeof updateJobSchema>;
export type CreateJobLineItemInput = z.infer<typeof createJobLineItemSchema>;
export type UpdateJobLineItemInput = z.infer<typeof updateJobLineItemSchema>;
export type CreateJobNoteInput = z.infer<typeof createJobNoteSchema>;
export type UpdateJobNoteInput = z.infer<typeof updateJobNoteSchema>;
