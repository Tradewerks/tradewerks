import z from "zod";
import { isStorableStockQty, STOCK_QTY_MESSAGE } from "./shared.js";

/**
 * Emergency field procurement request bodies. Money is validated to two decimals
 * here rather than left to Postgres, which would round a third silently and desync
 * a receipt from its own lines.
 */

const money = (label: string) =>
	z
		.number()
		.min(0, `${label} must be non-negative`)
		.refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE });

/**
 * Line money, which a receipt prints below zero: a trade discount, a coupon, an
 * item returned on the same ticket. Only lines get this — every other caller of
 * `money` means non-negative, and a negative receipt total is a misread.
 */
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

export const NOTE_MAX = 2000;
export const DESCRIPTION_MAX = 200;
export const VENDOR_NAME_MAX = 120;

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export const upsertGrantSchema = z
	.object({
		technician_id: z.string().uuid(),
		per_transaction_limit: positiveMoney("Per-transaction limit"),
		daily_limit: positiveMoney("Daily limit").nullable().optional(),
		weekly_limit: positiveMoney("Weekly limit").nullable().optional(),
		per_job_limit: positiveMoney("Per-job limit").nullable().optional(),
		notes: nullableText(NOTE_MAX),
	})
	.superRefine((d, ctx) => {
		// A daily ceiling under the per-transaction one makes every single legal
		// purchase breach it, so everything needs pre-auth and the per-transaction
		// limit means nothing.
		if (d.daily_limit != null && d.daily_limit < d.per_transaction_limit) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["daily_limit"],
				message: "Daily limit cannot be below the per-transaction limit",
			});
		}
		if (d.weekly_limit != null && d.daily_limit != null && d.weekly_limit < d.daily_limit) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["weekly_limit"],
				message: "Weekly limit cannot be below the daily limit",
			});
		}
	});

export const revokeGrantSchema = z.object({
	reason: nullableText(NOTE_MAX),
});

// ---------------------------------------------------------------------------
// Purchases
// ---------------------------------------------------------------------------

/**
 * Which jobs a receipt covers — not what each one owes. The share is derived from
 * the lines assigned to the job, so there is nothing here to type: a typed share
 * is a second answer to a question the lines already answer.
 */
const allocationSchema = z.object({
	job_id: z.string().uuid(),
	// The visit the purchase is billed against. Absent when the flow was started
	// from somewhere with no visit in context, which costs the job its billing.
	job_visit_id: z.string().uuid().nullable().optional(),
});

/**
 * Optional per line, and `receive` is the only value that takes a destination.
 * `consume` is rejected: it would deduct our own stock for a part never in it.
 */
const lineSchema = z.object({
	description: z.string().trim().min(1, "Description is required").max(DESCRIPTION_MAX),
	// Quantity stays strictly positive: minus two of something is a misread, and a
	// discount is a negative price on one line, not a negative count.
	quantity: positiveMoney("Quantity"),
	unit_price: signedMoney("Unit price"),
	line_total: signedMoney("Line total").optional(),
	inventory_item_id: z.string().uuid().nullable().optional(),
	disposition: z.enum(["receive", "non_stock"]).nullable().optional(),
	disposition_vehicle_id: z.string().uuid().nullable().optional(),
	// Which job this line served, and so which job's share it counts towards.
	// Only sent when the receipt covers more than one: with a single job the
	// answer is not in doubt and the server assigns it.
	job_id: z.string().uuid().nullable().optional(),
	sort_order: z.number().int().min(0).optional(),
	// The technician's confirmation of THIS line, carried with the line itself.
	// Mandatory verification is unchanged; what goes is the round trip that made
	// saving and confirming two separate errands.
	acknowledged: z.boolean().optional(),
	// What the reader scored this line, carried back so a reopened purchase can
	// tell a line OCR produced from one somebody typed. Without it the sheet
	// re-offers every extracted line and the receipt doubles.
	ocr_confidence: z.number().min(0).max(1).nullable().optional(),
}).superRefine((l, ctx) => {
	// A discount is not a part. Received into a truck it would move stock at a
	// negative cost and value the shelf below zero.
	const negative = l.unit_price < 0 || (l.line_total != null && l.line_total < 0);
	if (negative && l.disposition === "receive") {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["disposition"],
			message: "A negative line cannot be received into stock",
		});
	}
});

export const createPurchaseSchema = z.object({
	reason: nullableText(NOTE_MAX),
	estimated_amount: positiveMoney("Estimated amount").nullable().optional(),
	allocations: z.array(allocationSchema).min(1, "At least one job allocation is required"),
});

export const RECEIPT_NUMBER_MAX = 64;

export const updatePurchaseSchema = z.object({
	reason: nullableText(NOTE_MAX),
	vendor_name: nullableText(VENDOR_NAME_MAX),
	supplier_id: z.string().uuid().nullable().optional(),
	// OCR's proposal, same as supplier_id: visible and correctable, never a refusal
	// nobody can see or fix.
	receipt_number: nullableText(RECEIPT_NUMBER_MAX),
	purchased_at: z.coerce.date().optional(),
	tax_amount: money("Tax amount").optional(),
	total: money("Total").optional(),
	allocations: z.array(allocationSchema).optional(),
});

/**
 * Replaces the whole line set, so editing a line drops its verified stamp by
 * construction - which is what the mandatory-verification rule wants anyway.
 */
export const replaceLinesSchema = z.object({
	lines: z.array(lineSchema).max(100),
});

/**
 * Everything the sheet holds, sent with the one submit that ends it. Separate "save
 * details", "save lines" and "confirm lines" calls were three chances to lose work
 * at a counter, and saving lines dropped the confirmations it had just been given.
 * Every field is optional: a purchase saved piecemeal submits with an empty body.
 */
export const submitPurchaseSchema = z.object({
	vendor_name: nullableText(VENDOR_NAME_MAX),
	purchased_at: z.coerce.date().optional(),
	tax_amount: money("Tax amount").optional(),
	total: money("Total").optional(),
	// Which jobs the receipt covers. Shares follow from the lines, so removing a
	// job here is the whole of what this changes.
	allocations: z.array(allocationSchema).optional(),
	lines: z.array(lineSchema).max(100).optional(),
});

/** A reviewer correcting which job a line served. One line, one job, nothing else. */
export const assignLineJobSchema = z.object({
	job_id: z.string().uuid(),
});

export const linkSupplierSchema = z.object({
	supplier_id: z.string().uuid(),
});

export const captureMetaSchema = z.object({
	// Device clock at capture. Distinct from purchased_at, which is what the
	// receipt claims, so the two can disagree and be flagged.
	captured_at: z.coerce.date().optional(),
	capture_lat: z.coerce.number().min(-90).max(90).optional(),
	capture_lng: z.coerce.number().min(-180).max(180).optional(),
	capture_accuracy_m: z.coerce.number().int().min(0).max(100_000).optional(),
});

export const preauthRequestSchema = z.object({
	estimated_amount: positiveMoney("Estimated amount"),
	reason: nullableText(NOTE_MAX),
	// Whatever is on the sheet when the technician switches flows. Same shape as
	// submit, applied the same way: asking for permission must not be the one
	// button that throws away what they typed to ask.
	sheet: submitPurchaseSchema.optional(),
});

export const preauthDecisionSchema = z.object({
	approve: z.boolean(),
	note: nullableText(NOTE_MAX),
});

export const reviewDecisionSchema = z.object({
	decision: z.enum(["approve", "query", "reject"]),
	note: nullableText(NOTE_MAX),
});

export const secondSignoffSchema = z.object({
	approve: z.boolean(),
	note: nullableText(NOTE_MAX),
});

/**
 * A refund carries its own credit slip and lines, so it is created against the
 * parent and then filled in like any other purchase.
 */
export const createRefundSchema = z.object({
	parent_purchase_id: z.string().uuid(),
	reason: nullableText(NOTE_MAX),
});

/**
 * The groups a reviewer thinks in: what I owe an answer on, what I have answered and
 * handed back, and history. Before `decided` existed the queue asked for every
 * status and trimmed client-side, so a page of pending receipts could hide the whole
 * decided history behind the row cap.
 */
export const listPurchasesQuerySchema = z.object({
	status: z
		.enum([
			"draft",
			"pending_preauth",
			"preauth_denied",
			"preauth_approved",
			"pending_review",
			"queried",
			"pending_second_signoff",
			"approved",
			"rejected",
			"open",
			"with_tech",
			"decided",
			"all",
		])
		.default("all"),
	technician_id: z.string().uuid().optional(),
	job_id: z.string().uuid().optional(),
	flagged: z.enum(["true", "false"]).optional(),
	kind: z.enum(["purchase", "refund", "all"]).default("all"),
	/** Matches the technician, the vendor, or any line description. */
	search: z.string().trim().min(1).max(120).optional(),
	date_from: z.coerce.date().optional(),
	date_to: z.coerce.date().optional(),
	sort: z.enum(["newest", "oldest", "amount_desc", "amount_asc"]).default("newest"),
	offset: z.coerce.number().int().min(0).default(0),
	limit: z.coerce.number().int().min(1).max(200).default(50),
});

/**
 * The whole receipt and every job's share, in one question. Asked per job it used
 * to take one request per allocation, and the windowed ceilings came back computed
 * against whichever share happened to be asked first.
 */
export const limitCheckSchema = z.object({
	amount: z.coerce.number().min(0).refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE }),
	jobs: z
		.array(
			z.object({
				job_id: z.string().uuid(),
				amount: money("Job share"),
			}),
		)
		.max(50)
		.optional(),
	/**
	 * The purchase this check is for, so its own counted spend is not measured
	 * against the ceiling twice. Resolved against the caller before it is trusted.
	 */
	purchase_id: z.string().uuid().optional(),
});
