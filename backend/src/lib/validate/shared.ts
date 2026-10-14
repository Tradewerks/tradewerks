/**
 * Shared validation schemas and predicates reused across validators — line-item
 * shapes for invoices/quotes, and the stock-quantity precision rule below.
 */
import { ZodError, z } from "zod";

// ---------------------------------------------------------------------------
// Coordinates
// ---------------------------------------------------------------------------

/**
 * Canonical coordinate pair for every entity that carries an address.
 *
 * Seed data and legacy rows persisted longitude as `lng`. Loading one of those
 * records into an edit form and saving it back unchanged used to 400, because
 * the payload carried `lng` while the schema demanded `lon`. Accept either on
 * the way in and store `lon`, so a round-trip can never reject its own data.
 */
export const coordsSchema = z.preprocess((raw) => {
	if (raw == null || typeof raw !== "object") return raw;
	const c = raw as { lat?: unknown; lon?: unknown; lng?: unknown };
	if (c.lon === undefined && typeof c.lng === "number") {
		return { lat: c.lat, lon: c.lng };
	}
	return raw;
}, z.object({ lat: z.number(), lon: z.number() }));

// ---------------------------------------------------------------------------
// Validation error formatting
// ---------------------------------------------------------------------------

/**
 * Renders a ZodError for the API's `error.message`. Includes the field path —
 * the message alone collapses to a bare "Invalid input" for a nested shape,
 * which tells the caller nothing about which field was rejected.
 */
export function formatZodError(e: ZodError): string {
	const issues = e.issues.map((issue) => {
		const path = issue.path.join(".");
		return path ? `${path} — ${issue.message}` : issue.message;
	});
	return `Validation failed: ${issues.join(", ")}`;
}


// ---------------------------------------------------------------------------
// Stock quantity precision
// ---------------------------------------------------------------------------

/**
 * Every quantity column in the stock ledger is `numeric(10, 2)`. Postgres
 * won't complain about either failure mode this guards against:
 * 1. A third decimal is silently ROUNDED on write, desyncing cached on-hand
 *    from the movements it's derived from.
 * 2. A value past 8 integer digits OVERFLOWS the column, surfacing as a 500
 *    instead of a clean 4xx.
 * Applies to stock quantities only — not pagination ints, not money fields
 * (their own `Decimal(10, 2)` columns, validated where declared).
 */
export const STOCK_QTY_SCALE = 2;

/** Largest value `numeric(10, 2)` can hold: 8 integer digits plus 2 decimals. */
export const MAX_STOCK_QTY = 99_999_999.99;

export const STOCK_QTY_MESSAGE = `Quantity must have at most ${STOCK_QTY_SCALE} decimal places and be at most ${MAX_STOCK_QTY}`;

/**
 * Decimal places in a number's shortest round-trip representation. String-based,
 * not arithmetic — `Math.round(v * 100) === v * 100` false-positives on values
 * like `0.07` (`7.000000000000001` in IEEE-754). Exponent notation returns
 * Infinity, rejecting it rather than mis-measuring it.
 */
function decimalPlaces(v: number): number {
	const s = String(v);
	if (s.includes("e") || s.includes("E")) return Infinity;
	const dot = s.indexOf(".");
	return dot === -1 ? 0 : s.length - dot - 1;
}

/** True when `v` survives a round trip through a `numeric(10, 2)` column unchanged. */
export function isStorableStockQty(v: number): boolean {
	return Number.isFinite(v) && Math.abs(v) <= MAX_STOCK_QTY && decimalPlaces(v) <= STOCK_QTY_SCALE;
}

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const lineItemTypeEnum = z.enum(["labor", "material", "equipment", "other"]);

export const discountTypeEnum = z.enum(["percent", "amount"]);

// ---------------------------------------------------------------------------
// Stock intent (disposition)
// ---------------------------------------------------------------------------

/**
 * Carried by visit lines and the plan lines they generate from. Quote, job and
 * invoice lines move no stock, so they have none.
 */
export const dispositionFieldsSchema = {
	// Absent means `consume`. Dropped on a freetext line.
	disposition: z.enum(["consume", "receive", "non_stock"]).nullable().optional(),
	// `receive` only; absent means the warehouse.
	disposition_vehicle_id: z.string().uuid().nullable().optional(),
} as const;

// ---------------------------------------------------------------------------
// Base line item schema — common fields for both invoices and quotes
// ---------------------------------------------------------------------------

/**
 * Base line item fields shared between invoice and quote line items.
 * Callers extend this for model-specific fields (e.g. source traceability on invoices).
 */
export const baseLineItemSchema = z.object({
	name: z.string().min(1, "Item name is required"),
	description: z.string().optional().nullable(),
	quantity: z.number().positive("Quantity must be positive"),
	unit_price: z.number().min(0, "Unit price must be non-negative"),
	total: z.number().min(0, "Total must be non-negative").optional(),
	item_type: lineItemTypeEnum.optional().nullable(),
	sort_order: z.number().int().optional().default(0),
	tax_group_id: z.string().uuid().nullable().optional(),
	taxable: z.boolean().optional(),
	// Catalog link. Reference only on quotes and invoices — neither moves stock.
	// Ownership is NOT checked here; controllers run assertInventoryItemsInOrg
	// before persisting, because a Zod schema has no organization in scope.
	inventory_item_id: z.string().uuid().nullable().optional(),
});

// ---------------------------------------------------------------------------
// Shared discount cross-field validation
// ---------------------------------------------------------------------------

/**
 * Refine callback that rejects percent discounts above 100.
 * Apply to any schema object that has discount_type + discount_value.
 */
export function validateDiscountRange<T extends { discount_type?: string | null; discount_value?: number | null }>(
	data: T,
	ctx: z.RefinementCtx,
): void {
	if (data.discount_type === "percent" && (data.discount_value ?? 0) > 100) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["discount_value"],
			message: "Percent discount cannot exceed 100",
		});
	}
}
