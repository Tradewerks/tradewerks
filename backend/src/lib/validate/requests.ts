import { z } from "zod";
import { coordsSchema } from "./shared.js";

export const createRequestSchema = z.object({
	client_id: z.string().uuid("Invalid client ID"),
	title: z.string().min(1, "Title is required"),
	description: z.string().min(1, "Description is required"),
	priority: z
		.enum(["Low", "Medium", "High", "Urgent", "Emergency"])
		.default("Medium"),
	address: z
		.string()
		.min(1)
		.optional()
		.or(z.literal(""))
		.transform((val) => (val === "" ? undefined : val)),
	coords: coordsSchema.optional(),
	requires_quote: z.boolean().default(false),
	estimated_value: z.number().min(0).optional().nullable(),
	status: z
		.enum([
			"New",
			"Reviewing",
			"Quoted",
			"QuoteApproved",
			"QuoteRejected",
			"ConvertedToJob",
			"Cancelled",
		])
		.optional(),
	source: z
		.string()
		.optional()
		.nullable()
		.or(z.literal(""))
		.transform((val) => (val === "" || val === null ? null : val)),
	source_reference: z
		.string()
		.optional()
		.nullable()
		.or(z.literal(""))
		.transform((val) => (val === "" || val === null ? null : val)),
});

export const updateRequestSchema = z
	.object({
		title: z.string().min(1, "Title is required").optional(),
		description: z.string().min(1, "Description is required").optional(),
		priority: z
			.enum(["Low", "Medium", "High", "Urgent", "Emergency"])
			.optional(),
		address: z
			.string()
			.min(1)
			.optional()
			.or(z.literal(""))
			.transform((val) => (val === "" ? undefined : val)),
		coords: coordsSchema.optional(),
		status: z
			.enum([
				"New",
				"Reviewing",
				"Quoted",
				"QuoteApproved",
				"QuoteRejected",
				"ConvertedToJob",
				"Cancelled",
			])
			.optional(),
		requires_quote: z.boolean().optional(),
		estimated_value: z.number().min(0).optional().nullable(),
		source: z
			.string()
			.optional()
			.nullable()
			.or(z.literal(""))
			.transform((val) => (val === "" || val === null ? null : val)),
		source_reference: z
			.string()
			.optional()
			.nullable()
			.or(z.literal(""))
			.transform((val) => (val === "" || val === null ? null : val)),
		cancellation_reason: z
			.string()
			.optional()
			.nullable()
			.or(z.literal(""))
			.transform((val) => (val === "" || val === null ? null : val)),
	})
	.refine(
		(data) =>
			data.title !== undefined ||
			data.description !== undefined ||
			data.priority !== undefined ||
			data.address !== undefined ||
			data.coords !== undefined ||
			data.status !== undefined ||
			data.requires_quote !== undefined ||
			data.estimated_value !== undefined ||
			data.source !== undefined ||
			data.source_reference !== undefined ||
			data.cancellation_reason !== undefined,
		{ message: "At least one field must be provided for update" },
	);

export const createRequestNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

export const updateRequestNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type UpdateRequestInput = z.infer<typeof updateRequestSchema>;
export type CreateRequestNoteInput = z.infer<typeof createRequestNoteSchema>;
export type UpdateRequestNoteInput = z.infer<typeof updateRequestNoteSchema>;
