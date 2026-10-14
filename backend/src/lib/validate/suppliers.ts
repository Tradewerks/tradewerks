import z from "zod";
import { SUPPLIER_NAME_MAX } from "../../services/suppliers.js";

// Empty/whitespace-only optional metadata collapses to null so "" never
// occupies a field that reads as "not recorded" everywhere else.
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
 * Supplier capture for the intake paths. Spread into each intake schema rather
 * than repeated, so all four doors accept the same pair: an id for a vendor the
 * picker already resolved, or a raw name to create-on-write.
 *
 * Both optional on every path — a receive blocked over missing vendor metadata
 * is worse than an unattributed one.
 */
export const supplierCaptureFields = {
	supplier_id: z.string().uuid().optional(),
	supplier_name: z.string().trim().max(SUPPLIER_NAME_MAX).optional(),
};

export const listSuppliersQuerySchema = z.object({
	search: z.string().max(SUPPLIER_NAME_MAX).optional(),
	active: z.enum(["true", "false", "all"]).default("true"),
	// Receipt/lot counts cost an aggregate per supplier — the admin page needs
	// them to decide what to merge, the capture typeahead does not.
	include_usage: z.enum(["true", "false"]).default("false"),
});

export const createSupplierSchema = z.object({
	// Trimmed BEFORE the length check: a whitespace-only name passes min(1) but
	// collapses to "" downstream, creating a vendor with a blank name and a blank
	// dedupe key that every later blank would then adopt.
	name: z.string().trim().min(1, "Supplier name is required").max(SUPPLIER_NAME_MAX),
	account_number: nullableText(100),
	contact_name: nullableText(200),
	phone: nullableText(50),
	email: z.preprocess(
		(v) => (typeof v === "string" && v.trim() === "" ? null : v),
		z.string().email().max(255).nullable().optional(),
	),
	notes: nullableText(5000),
	is_active: z.boolean().optional(),
});

export const updateSupplierSchema = createSupplierSchema.partial();

export const mergeSupplierSchema = z.object({
	target_id: z.string().min(1, "target_id is required"),
});

export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>;
