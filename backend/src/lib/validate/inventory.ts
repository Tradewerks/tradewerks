import z from "zod";
import { UNIT_CODES, normalizeUnitCode } from "../units.js";
import { STOCK_QTY_MESSAGE, isStorableStockQty } from "./shared.js";
import { supplierCaptureFields } from "./suppliers.js";

// Quantities are fractional (12.5 ft of line set is ordinary), bounded to
// numeric(10,2) via isStorableStockQty rather than left to Postgres — see
// validate/shared.ts. A serialized item's whole-number rule is NOT enforced
// here (this schema can't see is_serialized on the adjust path); it's enforced
// in services/inventoryTracking.ts and by rejecting opening stock on create.
//
// Takes the base number schema rather than being one because .refine() yields
// a ZodEffects, which loses .min() — each field states its bound first, then wraps.
const stockQty = (base: z.ZodNumber) => base.refine(isStorableStockQty, STOCK_QTY_MESSAGE);

// Aliases/casing normalize BEFORE the enum runs, so "EACH" / "lbs" from an
// older client still stores canonically. A genuinely unrecognized value is
// rejected, not coerced, to a bug upstream visible instead of hidden — except
// CSV import, which coerces and warns rather than failing the whole row.
//
// No .max(50) — the enum bounds the value far more tightly than a length cap.
const unitField = z.preprocess(
	(v) => (typeof v === "string" ? (normalizeUnitCode(v) ?? v) : v),
	z.enum(UNIT_CODES, { error: `unit must be one of: ${UNIT_CODES.join(", ")}` }),
);

// Trim and collapse empty/whitespace-only barcodes to null so "" never occupies
// a slot in the per-org (organization_id, barcode) unique index.
const barcodeField = z
	.string()
	.max(200)
	.nullable()
	.optional()
	.transform((v) => {
		if (v == null) return v;
		const trimmed = v.trim();
		return trimmed === "" ? null : trimmed;
	});

// Optional, and "" / whitespace collapse to null so there is exactly one
// representation of "no location". Three creation paths wrote "" to satisfy the
// old NOT NULL constraint; the migration cleared those and this keeps them gone.
export const locationField = z
	.string()
	.max(255)
	.nullable()
	.optional()
	.transform((v) => {
		if (v == null) return v;
		const trimmed = v.trim();
		return trimmed === "" ? null : trimmed;
	});

export const updateThresholdSchema = z.object({
    low_stock_threshold: stockQty(z.number().min(0, "Threshold must not be negative")).nullable().optional(),
});

export type UpdateThresholdInput = z.infer<typeof updateThresholdSchema>;

export const createInventoryItemSchema = z
	.object({
		name: z.string().min(1, "Name is required").max(255),
		description: z.string().max(5000).default(""),
		location: locationField,
		quantity: stockQty(z.number().min(0, "Quantity must not be negative")).default(0),
		unit: unitField.default("each"),
		unit_price: z.number().min(0).nullable().optional(),
		cost: z.number().min(0).nullable().optional(),
		sku: z.string().max(100).nullable().optional(),
		// Freetext, org-defined, single-valued on purpose — it's the grouping
		// axis (vehicle-stock ordering, report column); tags can't serve that
		// since one item could land in multiple buckets.
		category: z.string().max(100).nullable().optional(),
		barcode: barcodeField,
		low_stock_threshold: stockQty(z.number().min(0)).nullable().optional(),
		image_urls: z.array(z.string().url()).default([]),
		alert_emails_enabled: z.boolean().default(false),
		alert_email: z.string().email().nullable().optional(),
		alt_ids: z.array(z.string()).default([]),
		is_serialized: z.boolean().default(false),
		is_batch_tracked: z.boolean().default(false),
		// Per-unit cost PAID for the opening quantity. Separate from `cost` (the
		// configured standard cost) — deriving one from the other would invent
		// purchase history that was never stated.
		cost_at_receipt: z.number().min(0).nullable().optional(),
		// Only consulted when quantity > 0 — an opening count of zero is not a
		// purchase, so there's no vendor to attribute it to.
		...supplierCaptureFields,
	})
	// Plain create doesn't accept serial/batch capture data — a tracked item's
	// initial stock must go through POST /inventory/:id/receive instead, which
	// is the only place serial numbers / a lot get recorded alongside the qty.
	.refine((d) => !((d.is_serialized || d.is_batch_tracked) && d.quantity > 0), {
		message: "A serialized or batch-tracked item must be created with quantity 0 — add initial stock via POST /inventory/:id/receive",
		path: ["quantity"],
	});

export type CreateInventoryItemInput = z.infer<typeof createInventoryItemSchema>;

export const updateInventoryItemSchema = z.object({
	name: z.string().min(1).max(255).optional(),
	description: z.string().max(5000).optional(),
	location: locationField,
	// quantity intentionally omitted — stock changes go through adjustInventoryStock → recordMovements
	unit: unitField.optional(),
	// Changing `unit` while stock is on hand re-denominates that stock (250 each
	// silently becomes 250 box — nothing is converted). The controller refuses
	// such a change unless the caller explicitly acknowledges it with this flag.
	// Not persisted; stripped before the row is written.
	acknowledge_unit_change: z.boolean().optional(),
	unit_price: z.number().min(0).nullable().optional(),
	cost: z.number().min(0).nullable().optional(),
	sku: z.string().max(100).nullable().optional(),
	category: z.string().max(100).nullable().optional(),
	barcode: barcodeField,
	low_stock_threshold: stockQty(z.number().min(0)).nullable().optional(),
	image_urls: z.array(z.string().url()).optional(),
	alert_emails_enabled: z.boolean().optional(),
	alert_email: z.string().email().nullable().optional(),
	alt_ids: z.array(z.string()).optional(),
});

export type UpdateInventoryItemInput = z.infer<typeof updateInventoryItemSchema>;

// Loss (negative delta) on a tracked item must name which units/batches leave —
// serial_unit_ids for serialized items (length must equal abs(delta), enforced
// in the controller once is_serialized is known), batch_picks for batch-tracked
// (non-serialized) items (omit entirely to let the ledger's FIFO auto-allocate).
// Both are ignored for non-tracked items — existing callers are unaffected.
export const adjustStockSchema = z.object({
	delta: stockQty(z.number()).refine((v) => v !== 0, "Delta must not be zero"),
	serial_unit_ids: z.array(z.string().uuid()).optional(),
	batch_picks: z
		.array(z.object({ batch_id: z.string().uuid(), qty: stockQty(z.number().positive()) }))
		.optional(),
});

export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

export const scanQuerySchema = z.object({
	code: z.string().trim().min(1, "Code is required").max(200),
});

export type ScanQueryInput = z.infer<typeof scanQuerySchema>;

// GET /inventory/:id/usage — offset pagination (not cursor) because rows are a
// GROUP BY aggregate per job+client, not raw ledger rows with a stable id to
// cursor on. limit default 20, clamped to 100 in the controller (same clamp
// convention as getInventoryMovements/listItemSerials).
export const usageQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
	created_after: z.coerce.date().optional(),
});

export type UsageQueryInput = z.infer<typeof usageQuerySchema>;

// The date_trunc grain shared by every bucketed item series (consumption trend,
// charged-price trend). Declared once and exported so the controller's
// per-bucket default/cap table is keyed by the same union the API accepts —
// restating "week" | "month" in both places let the two drift independently.
export const trendBucketSchema = z.enum(["week", "month"]);

export type TrendBucket = z.infer<typeof trendBucketSchema>;

// GET /inventory/:id/consumption-trend — bucket picks the date_trunc grain;
// range is buckets back from now. Default/cap differ per bucket, so the
// schema stays a permissive int ceiling and the controller applies the
// per-bucket default + clamp.
export const consumptionTrendQuerySchema = z.object({
	bucket: trendBucketSchema.optional(),
	range: z.coerce.number().int().min(1).max(104).optional(),
});

export type ConsumptionTrendQueryInput = z.infer<typeof consumptionTrendQuerySchema>;

// GET /inventory/:id/forecast — lookbackDays is the consumption window the
// reorder forecast averages over. Bounded, because an unbounded or
// non-numeric value reaches `new Date(now - NaN)` — an absurd window and a
// 500 — if it isn't. 10 years is far past any useful average; default
// matches getItemForecast's own fallback.
export const forecastQuerySchema = z.object({
	lookbackDays: z.coerce.number().int().min(1).max(3650).default(90),
});

export type ForecastQueryInput = z.infer<typeof forecastQuerySchema>;

// GET /inventory/:id/value-history — created_after narrows the ledger window
// but does NOT replace the controller's newest-N row cap + computed opening
// balance, so a narrowed range still starts from real on-hand stock, not zero.
export const valueHistoryQuerySchema = z.object({
	created_after: z.coerce.date().optional(),
});

export type ValueHistoryQueryInput = z.infer<typeof valueHistoryQuerySchema>;

// GET /inventory/:id/price-history — carries both range shapes on purpose:
// `created_after` windows the event-driven step series (like value-history),
// while bucket/range drive the period-driven charged-price aggregate (like
// consumption-trend).
export const priceHistoryQuerySchema = z.object({
	created_after: z.coerce.date().optional(),
	bucket: trendBucketSchema.optional(),
	range: z.coerce.number().int().min(1).max(104).optional(),
});

export type PriceHistoryQueryInput = z.infer<typeof priceHistoryQuerySchema>;

// GET /inventory/:id/movements — created_after narrows the ledger SERVER-side
// and composes with cursor pagination: it narrows the result set, the cursor
// still walks it.
export const movementsQuerySchema = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
	created_after: z.coerce.date().optional(),
});

export type MovementsQueryInput = z.infer<typeof movementsQuerySchema>;

export const createTagSchema = z.object({
	label: z.string().min(1, "Label is required").max(100),
});

export const updateTagSchema = z.object({
	label: z.string().min(1, "Label is required").max(100),
});

export const setItemTagsSchema = z.object({
	tag_ids: z.array(z.string()),
});
