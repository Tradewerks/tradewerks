import z from "zod";
import { baseLineItemSchema, discountTypeEnum, validateDiscountRange } from "./shared.js";
import { qb_sync_status } from "../../../generated/prisma/enums.js";

// ============================================================================
// ENUMS
// ============================================================================

const invoiceStatusEnum = z.enum([
	"Draft",
	"Issued",
	"Sent",
	"Viewed",
	"PartiallyPaid",
	"Paid",
	"Disputed",
	"Void",
]);

const invoiceQBSyncStatus = z.enum([
	"not_synced",
	"synced",
	"failed",
]);

// ============================================================================
// LINE ITEM (reusable sub-schema)
// ============================================================================

// Invoice line items extend the base with soft traceability fields.
const invoiceLineItemInputSchema = baseLineItemSchema.extend({
	// Tax fields — server resolves tax group if omitted (already in base)
	// Soft traceability — informational only
	source_job_id: z.string().uuid().optional().nullable(),
	source_visit_id: z.string().uuid().optional().nullable(),
	// inventory_item_id comes from baseLineItemSchema — it drives QB ItemRef
	// resolution on sync and feeds the charged-price series.
});

// ============================================================================
// CREATE INVOICE
// ============================================================================

export const createInvoiceSchema = z
	.object({
		client_id: z.string().uuid("Invalid client ID"),

		// Optional linkage
		recurring_plan_id: z.string().uuid().optional().nullable(),

		// Dates
		issue_date: z.coerce.date().optional(),
		due_date: z.coerce.date().optional().nullable(),
		payment_terms_days: z.number().int().min(0).optional().nullable(),

		// Financials
		subtotal: z.number().min(0).optional(),
		tax_rate: z.number().min(0).max(1).optional(),
		tax_amount: z.number().min(0).optional(),
		discount_type: discountTypeEnum.optional().nullable(),
		discount_value: z.number().min(0).optional().nullable(),
		discount_amount: z.number().min(0).optional().nullable(),
		total: z.number().min(0).optional(),

		// Content
		memo: z.string().optional().nullable(),
		internal_notes: z.string().optional().nullable(),

		// Line items (snapshot at creation time)
		line_items: z.array(invoiceLineItemInputSchema).optional(),

		// Job / visit linkage
		// job_ids: jobs linked to this invoice for traceability
		// visit_billings: visits with explicit billed_amount for per-visit billing
		// job_billings: jobs with explicit billed_amount for flat-rate job billing
		job_ids: z.array(z.string().uuid()).optional(),
		visit_billings: z
			.array(
				z.object({
					visit_id: z.string().uuid("Invalid visit ID"),
					billed_amount: z
						.number()
						.min(0, "Billed amount must be non-negative"),
				}),
			)
			.optional(),
		job_billings: z
			.array(
				z.object({
					job_id: z.string().uuid("Invalid job ID"),
					billed_amount: z
						.number()
						.min(0, "Billed amount must be non-negative"),
				}),
			)
			.optional(),
	})
	.superRefine(validateDiscountRange)
	.transform((data) => ({
		...data,
		recurring_plan_id: data.recurring_plan_id ?? undefined,
		due_date: data.due_date ?? undefined,
		payment_terms_days: data.payment_terms_days ?? undefined,
		subtotal: data.subtotal ?? undefined,
		tax_rate: data.tax_rate ?? undefined,
		tax_amount: data.tax_amount ?? undefined,
		discount_type: data.discount_type ?? undefined,
		discount_value: data.discount_value ?? undefined,
		discount_amount: data.discount_amount ?? undefined,
		total: data.total ?? undefined,
		memo: data.memo ?? undefined,
		internal_notes: data.internal_notes ?? undefined,
		line_items: data.line_items ?? undefined,
		job_ids: data.job_ids ?? undefined,
		visit_billings: data.visit_billings ?? undefined,
		job_billings: data.job_billings ?? undefined,
	}));

// ============================================================================
// UPDATE INVOICE
// ============================================================================

export const updateInvoiceSchema = z
	.object({
		status: invoiceStatusEnum.optional(),

		// Dates
		issue_date: z.coerce.date().optional(),
		due_date: z.coerce.date().optional().nullable(),
		payment_terms_days: z.number().int().min(0).optional().nullable(),
		sent_at: z.coerce.date().optional().nullable(),
		viewed_at: z.coerce.date().optional().nullable(),

		// Financials
		subtotal: z.number().min(0).optional(),
		tax_rate: z.number().min(0).max(1).optional(),
		tax_amount: z.number().min(0).optional(),
		discount_type: discountTypeEnum.optional().nullable(),
		discount_value: z.number().min(0).optional().nullable(),
		discount_amount: z.number().min(0).optional().nullable(),
		total: z.number().min(0).optional(),

		// Content
		memo: z.string().optional().nullable(),
		internal_notes: z.string().optional().nullable(),
		void_reason: z.string().optional().nullable(),

		// Line items — full replacement array (same pattern as job update)
		line_items: z
			.array(
				invoiceLineItemInputSchema.extend({
					id: z.string().uuid().optional(), // undefined = create new
				}),
			)
			.optional(),

		//QuickBooks sync status
		qb_sync_status: invoiceQBSyncStatus.optional(),
	})
	.superRefine(validateDiscountRange);

// ============================================================================
// PAYMENT
// ============================================================================

export const createInvoicePaymentSchema = z
	.object({
		amount: z.number().positive("Payment amount must be positive"),
		paid_at: z.coerce.date().optional(),
		method: z
			.enum(["cash", "check", "card", "bank_transfer", "other"])
			.optional()
			.nullable(),
		note: z.string().optional().nullable(),
	})
	.transform((data) => ({
		...data,
		paid_at: data.paid_at ?? undefined,
		method: data.method ?? undefined,
		note: data.note ?? undefined,
	}));

// ============================================================================
// NOTE
// ============================================================================

export const createInvoiceNoteSchema = z.object({
	content: z.string().min(1, "Content is required"),
});

export const updateInvoiceNoteSchema = z.object({
	content: z.string().min(1, "Content is required").optional(),
});

// ============================================================================
// TYPES
// ============================================================================

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type CreateInvoicePaymentInput = z.infer<
	typeof createInvoicePaymentSchema
>;
export type CreateInvoiceNoteInput = z.infer<typeof createInvoiceNoteSchema>;
export type UpdateInvoiceNoteInput = z.infer<typeof updateInvoiceNoteSchema>;

// ============================================================================
// OVERLAP CHECK
// ============================================================================

export const overlapCheckSchema = z.object({
	visit_ids: z.array(z.string().uuid()).min(1),
});

// ============================================================================
// GENERATE INVOICE (recurring plan)
// ============================================================================

export const generateInvoiceSchema = z.object({
	source: z.literal("recurring_plan"),
	plan_id: z.string().uuid(),
	memo: z.string().optional(),
	payment_terms_days: z.number().int().min(0).optional(),
});

// ============================================================================
// ADJUSTMENT LINES
// ============================================================================

/**
 * Adjustment lines carry a delta, so quantity and totals may be negative.
 * The relaxation is scoped to this path; the ordinary invoice schemas above
 * still reject negatives, because an ordinary invoice for a negative amount
 * is a data-entry error.
 */
// The line columns are Decimal(10,2). Past that, Postgres raises 22003 inside
// resolveDispute: an unexplained 500 with the dispute left Open. Positive
// adjustments stay uncapped by policy; this is the column's limit, not a cap.
const LINE_AMOUNT_LIMIT = 99_999_999.99;
const lineAmount = z
	.number()
	.min(-LINE_AMOUNT_LIMIT, "Amounts must be between -99,999,999.99 and 99,999,999.99")
	.max(LINE_AMOUNT_LIMIT, "Amounts must be between -99,999,999.99 and 99,999,999.99");

export const adjustmentLineSchema = z
	.object({
		name: z.string().trim().min(1).max(255),
		description: z.string().trim().max(2000).optional().nullable(),
		quantity: lineAmount.refine((n) => n !== 0, "Quantity cannot be zero"),
		unit_price: lineAmount,
		total: lineAmount.refine((n) => n !== 0, "Total cannot be zero"),
		source_job_id: z.string().uuid().optional().nullable(),
		source_visit_id: z.string().uuid().optional().nullable(),
		tax_group_id: z.string().uuid().optional().nullable(),
		taxable: z.boolean().optional(),
		inventory_item_id: z.string().uuid().optional().nullable(),
	})
	// `total` is what recomputeDocumentTotals taxes and what the invoice
	// subtotal sums; quantity and unit_price are what the client-facing
	// document prints. Unchecked, `{ quantity: 1, unit_price: 10, total: -5000 }`
	// is accepted and renders as "1 × $10.00" on a $5,000 credit. Compared in
	// cents so float representation cannot reject an honest line.
	.refine(
		(li) =>
			Math.round(li.quantity * li.unit_price * 100) ===
			Math.round(li.total * 100),
		{
			message: "Line total must equal quantity × unit price",
			path: ["total"],
		},
	);

export type AdjustmentLineInput = z.infer<typeof adjustmentLineSchema>;

// ============================================================================
// REFUND
// ============================================================================

/**
 * Amount is the positive size of the refund; the stored payment row is
 * negative. Keeping the API positive means a dispatcher never types a minus
 * sign to give money back. `method` reuses createInvoicePaymentSchema's enum
 * because both write the same invoice_payment.method column.
 */
export const createRefundSchema = z.object({
	amount: z.number().positive("Refund amount must be greater than zero"),
	reason: z.string().trim().min(1, "A reason is required").max(2000),
	method: z
		.enum(["cash", "check", "card", "bank_transfer", "other"])
		.optional()
		.nullable(),
});

export type CreateRefundInput = z.infer<typeof createRefundSchema>;
