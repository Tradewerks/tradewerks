import z from "zod";
import { isStorableStockQty, STOCK_QTY_MESSAGE } from "./shared.js";
import { locationField } from "./inventory.js";

/**
 * Planned vendor procurement request bodies. Distinct from lib/validate/fieldPurchases.ts
 * on purpose - a purchase is dispatcher-ordered ahead of time, not a technician's
 * counter receipt, so there is no OCR/capture/limit/preauth shape to carry here.
 */

const money = (label: string) =>
	z
		.number()
		.min(0, `${label} must be non-negative`)
		.refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE });

const signedMoney = (label: string) =>
	z
		.number()
		.refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE })
		.describe(label);

const positiveMoney = (label: string) =>
	z
		.number()
		.positive(`${label} must be positive`)
		.refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE });

// Matches item name cap
export const DESCRIPTION_MAX = 255;
export const VENDOR_NAME_MAX = 120;
export const NOTE_MAX = 2000;

/**
 * Which jobs this purchase is earmarked for. Optional and usually empty - most
 * purchases restock general/vehicle stock ahead of any job, per purchase_line's
 * own rule that only a non_stock line can carry a job allocation at all.
 */
const allocationSchema = z.object({
	job_id: z.string().uuid(),
	job_visit_id: z.string().uuid().nullable().optional(),
});

/**
 * `job_id` is only meaningful on a non_stock line - a receive line lands in
 * general/vehicle stock and gets job-costed later, when it's actually consumed,
 * never at purchase time. Enforced here, not just documented in the schema.
 */
const lineSchema = z
	.object({
		description: z.string().trim().min(1, "Item is required").max(DESCRIPTION_MAX),
		quantity: positiveMoney("Quantity"),
		unit_price: signedMoney("Unit price"),
		line_total: signedMoney("Line total").optional(),
		inventory_item_id: z.string().uuid().nullable().optional(),
		disposition: z.enum(["receive", "non_stock"]).nullable().optional(),
		disposition_vehicle_id: z.string().uuid().nullable().optional(),
		// Which of the request's `allocations` this line's cost belongs to.
		job_id: z.string().uuid().nullable().optional(),
		sort_order: z.number().int().min(0).optional(),
	})
	.superRefine((l, ctx) => {
		const negative = l.unit_price < 0 || (l.line_total != null && l.line_total < 0);
		if (negative && l.disposition === "receive") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["disposition"],
				message: "A negative line cannot be received into stock",
			});
		}
		if (l.job_id != null && l.disposition !== "non_stock") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["job_id"],
				message: "A job allocation is only valid on a non_stock line",
			});
		}
	});

export const createPurchaseSchema = z.object({
	vendor_name: z.string().trim().min(1, "Vendor name is required").max(VENDOR_NAME_MAX),
	supplier_id: z.string().uuid("Supplier is required"),
	purchased_at: z.coerce.date().optional(),
	tax_group_id: z.string().uuid().nullable().optional(),
	tax_amount: money("Tax amount").optional(),
	allocations: z.array(allocationSchema).max(50).optional(),
	lines: z.array(lineSchema).min(1, "At least one line is required").max(200),
});

/** Draft-only header edit. Lines are replaced separately, via replaceLinesSchema. */
export const updatePurchaseSchema = z.object({
	vendor_name: z.string().trim().min(1, "Vendor name is required").max(VENDOR_NAME_MAX),
	supplier_id: z.string().uuid("Supplier is required"),
	purchased_at: z.coerce.date().optional(),
	tax_group_id: z.string().uuid().nullable().optional(),
	tax_amount: money("Tax amount").optional(),
	allocations: z.array(allocationSchema).max(50).optional(),
});

/** Replaces the whole line set - editing a line drops any stale downstream state. */
export const replaceLinesSchema = z.object({
	lines: z.array(lineSchema).min(1, "At least one line is required").max(200),
});

export const cancelPurchaseSchema = z.object({
	cancellation_reason: z.string().optional(),
});

export const listPurchasesQuerySchema = z.object({
	status: z
		.enum(["draft", "ordered", "partially_received", "received", "cancelled", "open", "all"])
		.default("all"),
	kind: z.enum(["purchase", "refund", "all"]).default("all"),
	supplier_id: z.string().uuid().optional(),
	job_id: z.string().uuid().optional(),
	/** Matches the vendor name or any line description. */
	search: z.string().trim().min(1).max(120).optional(),
	sort: z.enum(["newest", "oldest", "amount_desc", "amount_asc"]).default("newest"),
	offset: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	date_from: z.coerce.date().optional(),
	date_to: z.coerce.date().optional(),
});

export const receivePurchaseSchema = z.object({
  lines: z.array(z.object({
    id: z.string().uuid(),
    quantity_received: positiveMoney("Quantity received"),
    disposition_vehicle_id: z.string().uuid().nullable().optional(),
    location: locationField,
  })).min(1, "At least one line must be received"),
});
