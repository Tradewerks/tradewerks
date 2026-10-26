import { z } from "zod";
import { stateCode } from "../../services/tax/address.js";

export const createTaxRateSchema = z.object({
	name: z.string().min(1, "Name is required").max(100, "Name must be at most 100 characters"),
	rate: z
		.number()
		.min(0, "Rate must be at least 0")
		.max(1, "Rate must be at most 1"),
	description: z.string().optional().nullable(),
	jurisdiction: z.string().optional().nullable(),
	is_default: z.boolean().optional().default(false),
});

export const updateTaxRateSchema = z.object({
	name: z.string().min(1, "Name is required").max(100, "Name must be at most 100 characters").optional(),
	rate: z.number().min(0, "Rate must be at least 0").max(1, "Rate must be at most 1").optional(),
	description: z.string().optional().nullable(),
	jurisdiction: z.string().optional().nullable(),
	is_default: z.boolean().optional(),
	is_active: z.boolean().optional(),
});

const uniqueRateIds = (ids: string[]) => new Set(ids).size === ids.length;

export const createTaxGroupSchema = z.object({
	name: z.string().min(1, "Name is required").max(100, "Name must be at most 100 characters"),
	description: z.string().optional().nullable(),
	is_default: z.boolean().optional().default(false),
	rate_ids: z
		.array(z.string().uuid("Invalid tax rate ID"))
		.optional()
		.default([])
		.refine(uniqueRateIds, { message: "Duplicate tax rate IDs are not allowed" }),
});

export const updateTaxGroupSchema = z.object({
	name: z.string().min(1, "Name is required").max(100, "Name must be at most 100 characters").optional(),
	description: z.string().optional().nullable(),
	is_default: z.boolean().optional(),
	is_active: z.boolean().optional(),
	rate_ids: z
		.array(z.string().uuid("Invalid tax rate ID"))
		.optional()
		.refine((ids) => ids === undefined || uniqueRateIds(ids), {
			message: "Duplicate tax rate IDs are not allowed",
		}),
});

export type CreateTaxRateInput = z.infer<typeof createTaxRateSchema>;
export type UpdateTaxRateInput = z.infer<typeof updateTaxRateSchema>;
export type CreateTaxGroupInput = z.infer<typeof createTaxGroupSchema>;
export type UpdateTaxGroupInput = z.infer<typeof updateTaxGroupSchema>;

const usStateCode = z
	.string()
	.trim()
	.toUpperCase()
	.refine((s) => /^[A-Z]{2}$/.test(s) && stateCode(s) === s, "Unknown US state code");

export const updateTaxSettingsSchema = z
	.object({
		tax_mode: z.enum(["auto", "manual"]).optional(),
		tax_registered_states: z
			.array(usStateCode)
			.max(60)
			.transform((a) => [...new Set(a)].sort())
			.optional(),
	})
	.refine(
		(v) => v.tax_mode !== undefined || v.tax_registered_states !== undefined,
		{ message: "Nothing to update" },
	);
