import z from "zod";
import { coordsSchema } from "./shared.js";

export const recurringTaxEstimateSchema = z.object({
	client_id: z.string().uuid(),
	address: z.string(),
	coords: coordsSchema.optional().nullable(),
	line_items: z.array(
		z.object({
			quantity: z.number().positive("Quantity must be positive"),
			unit_price: z.number().min(0, "Unit price must be non-negative"),
			taxable: z.boolean(),
			tax_group_id: z.string().uuid().nullable(),
		}),
	),
	plan_id: z.string().uuid().optional(),
});

export type RecurringTaxEstimateInput = z.infer<typeof recurringTaxEstimateSchema>;
