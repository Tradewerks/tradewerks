import z from "zod";

// Matches the DECIMAL(10,2) money columns elsewhere in the ledger, and never
// negative: a vendor quoting a negative price is a typo, not a credit.
const money = z
	.number()
	.min(0, "Price cannot be negative")
	.max(99_999_999.99, "Price is too large")
	.nullable()
	.optional();

const nullableText = (max: number) =>
	z
		.string()
		.nullable()
		.optional()
		.transform((v) => {
			if (v == null) return v;
			const trimmed = v.trim();
			return trimmed === "" ? null : trimmed;
		})
		.refine((v) => v == null || v.length <= max, {
			message: `String must contain at most ${max} character(s)`,
		});

/**
 * What an operator can set by hand. `last_price` and `last_purchased_at` are
 * deliberately absent — they're observations written by recordMovements, and a
 * hand-edited "last paid" would be a claim about history rather than a record of it.
 */
const editableFields = {
	vendor_sku: nullableText(100),
	contract_price: money,
	lead_time_days: z.number().int().min(0).max(365).nullable().optional(),
	min_order_qty: z.number().min(0).max(9_999_999.99).nullable().optional(),
	notes: nullableText(2000),
	is_preferred: z.boolean().optional(),
};

export const listSupplierItemsQuerySchema = z.object({
	supplier_id: z.string().uuid().optional(),
	inventory_item_id: z.string().uuid().optional(),
});

export const upsertSupplierItemSchema = z.object({
	supplier_id: z.string().uuid(),
	inventory_item_id: z.string().uuid(),
	...editableFields,
});

export const updateSupplierItemSchema = z.object(editableFields);

export type UpsertSupplierItemInput = z.infer<typeof upsertSupplierItemSchema>;
export type UpdateSupplierItemInput = z.infer<typeof updateSupplierItemSchema>;
