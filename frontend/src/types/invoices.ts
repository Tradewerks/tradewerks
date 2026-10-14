import type { ClientDetailsProps } from "../components/clients/ClientDetailsCard";
import type { BaseNote, PricingBreakdown } from "./common";
import type { DocumentLineage } from "./lineage";

// ============================================================================
// INVOICE STATUS
// ============================================================================

export const InvoiceStatusValues = [
	"Draft",
	"Issued",
	"Sent",
	"Viewed",
	"PartiallyPaid",
	"Paid",
	"Disputed",
	"Void",
] as const;

export type InvoiceStatus = (typeof InvoiceStatusValues)[number];

// Enum values are DB-frozen; these are the display strings. Issued reads
// "Created" and Paid reads "Fully Paid" (pairing with "Partially Paid").
export const InvoiceStatusLabels: Record<InvoiceStatus, string> = {
	Draft: "Draft",
	Issued: "Created",
	Sent: "Sent",
	Viewed: "Viewed",
	PartiallyPaid: "Partially Paid",
	Paid: "Fully Paid",
	Disputed: "Disputed",
	Void: "Void",
};

export const InvoiceStatusColors: Record<InvoiceStatus, string> = {
	Draft:        "bg-neutral/20 text-text-tertiary border-border-strong/30",
	Issued:       "bg-primary/20 text-primary-text border-primary/30",
	Sent:         "bg-success/20 text-success-text border-success/30",
	Viewed:       "bg-info/20 text-info-text border-info/30",
	PartiallyPaid:"bg-warning/20 text-warning-text border-warning/30",
	Paid:         "bg-success/20 text-success-text border-success/30",
	Disputed:     "bg-orange/20 text-orange-text border-orange/30",
	Void:         "bg-error/20 text-error-text border-error/30",
};

// Which statuses are auto-set by the system vs manually set by staff
export const AutoSetStatuses: InvoiceStatus[] = ["Issued", "PartiallyPaid", "Paid"];
export const ManualOnlyStatuses: InvoiceStatus[] = ["Disputed", "Void"];

// ============================================================================
// PAYMENT METHOD
// ============================================================================

export const PaymentMethodValues = ["cash", "check", "card", "bank_transfer", "other"] as const;

export type PaymentMethod = (typeof PaymentMethodValues)[number];

export const PaymentMethodLabels: Record<PaymentMethod, string> = {
	cash: "Cash",
	check: "Check",
	card: "Card",
	bank_transfer: "Bank Transfer",
	other: "Other",
};

// ============================================================================
// LIGHTWEIGHT REFERENCE TYPES
// ============================================================================

export interface InvoiceReference {
	id: string;
	invoice_number: string;
	status: InvoiceStatus;
	total: number;
	balance_due: number;
	issue_date: Date | string | null;
}

/** Minimal shape of a neighbouring invoice in the revision/adjustment chain. */
export interface InvoiceChainRef {
	id: string;
	invoice_number: string;
}

/** The documents a job came from — how an invoice is backtracked past the work. */
export interface JobQuoteReference {
	id: string;
	quote_number: string;
	title: string;
	status: string;
	total: number;
	created_at: Date | string;
}

export interface JobRequestReference {
	id: string;
	title: string;
	status: string;
	created_at: Date | string;
}

export interface JobReference {
	id: string;
	job_number: string;
	name: string;
	status: string;
	/** Resolved on the invoice detail GET; list endpoints leave these absent. */
	quote?: JobQuoteReference | null;
	request?: JobRequestReference | null;
}

export interface VisitReference {
	id: string;
	scheduled_start_at: Date | string;
	scheduled_end_at: Date | string;
	status: string;
	job: JobReference;
}

export interface RecurringPlanReference {
	id: string;
	name: string;
	status: string;
}

// ============================================================================
// LINE ITEMS
// ============================================================================

export interface InvoiceLineItem {
	id: string;
	invoice_id: string;
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	item_type?: string | null;
	sort_order: number;
	// Soft traceability
	source_job_id?: string | null;
	source_visit_id?: string | null;
	taxable: boolean;
	tax_group_id: string | null;
	tax_amount: number | null;
	tax_group?: { id: string; name: string; rates?: { tax_rate: { id: string; name: string; rate: number } }[] } | null;
	/** Catalog link, when the line was picked from inventory rather than typed. */
	inventory_item_id?: string | null;
}

export interface CreateInvoiceLineItemInput {
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	total?: number;
	item_type?: string | null;
	sort_order?: number;
	source_job_id?: string | null;
	source_visit_id?: string | null;
	taxable?: boolean;
	tax_group_id?: string | null;
	/** Catalog link. Reference only except on visits, where it plans and deducts stock. */
	inventory_item_id?: string | null;
}

export interface UpdateInvoiceLineItemInput extends CreateInvoiceLineItemInput {
	id?: string; // undefined = create new
}

// ============================================================================
// PAYMENT
// ============================================================================

export interface InvoicePayment {
	id: string;
	invoice_id: string;
	amount: number;
	paid_at: Date | string;
	method?: PaymentMethod | null;
	note?: string | null;
	created_at: Date | string;
	recorded_by_dispatcher_id?: string | null;
	recorded_by_tech_id?: string | null;
	recorded_by_dispatcher?: { id: string; name: string } | null;
	recorded_by_tech?: { id: string; name: string } | null;
}

export interface CreateInvoicePaymentInput {
	amount: number;
	paid_at?: Date | string;
	method?: PaymentMethod | null;
	note?: string | null;
}

/**
 * A refund is stored as a negative invoice_payment row, but the API is
 * positive — a dispatcher never types a minus sign to give money back.
 * The reason is required; the backend caps `amount` at what was actually paid.
 */
export interface RecordRefundInput {
	amount: number;
	reason: string;
	method?: PaymentMethod | null;
}

// ============================================================================
// NOTE
// ============================================================================

export interface InvoiceNote extends BaseNote {
	invoice_id: string;
}

export interface CreateInvoiceNoteInput {
	content: string;
}

export interface UpdateInvoiceNoteInput {
	content: string;
}

// ============================================================================
// JOB / VISIT BILLING LINKAGE
// ============================================================================

/** Job linked to an invoice. billed_amount null = traceability only. */
export interface InvoiceJob {
	invoice_id: string;
	job_id: string;
	billed_amount?: number | null;
	job: JobReference;
}

/** Visit linked to an invoice with explicit billed amount. */
export interface InvoiceVisit {
	invoice_id: string;
	visit_id: string;
	billed_amount: number;
	visit: VisitReference;
}

// ============================================================================
// MAIN INVOICE TYPE
// ============================================================================

export interface Invoice extends PricingBreakdown {
	id: string;
	invoice_number: string;
	client_id: string;
	status: InvoiceStatus;

	// Dates
	issue_date: Date | string | null;
	due_date?: Date | string | null;
	payment_terms_days?: number | null;
	issued_at?: Date | string | null;
	sent_at?: Date | string | null;
	viewed_at?: Date | string | null;
	paid_at?: Date | string | null;
	voided_at?: Date | string | null;

	// Payment totals (cached, backend-managed)
	amount_paid: number;
	balance_due: number;

	// Revision / adjustment chain. Both directions are carried: a cross-reference
	// has to name the neighbouring document, and "adjusted by" has no scalar to
	// derive it from.
	version?: number;
	previous_invoice_id?: string | null;
	previous_invoice?: InvoiceChainRef | null;
	revised_invoice?: InvoiceChainRef | null;
	adjusts_invoice_id?: string | null;
	adjusts_invoice?: InvoiceChainRef | null;
	adjustments?: InvoiceChainRef[];
	/** Resolved chain, attached by getInvoiceById. Absent on list payloads. */
	lineage?: DocumentLineage | null;

	// Content
	memo?: string | null;
	internal_notes?: string | null;
	void_reason?: string | null;

	created_at: Date | string;
	updated_at: Date | string;
	created_by_dispatcher_id?: string | null;

	// QuickBooks
	qb_sync_status?: "not_synced" | "synced" | "failed";
	qb_invoice_id?: string | null;
	account_id?: string | null;

	// Relations
	client?: (ClientDetailsProps["client"] & { id: string; is_tax_exempt?: boolean; tax_group_id?: string | null }) | null;
	created_by_dispatcher?: { id: string; name: string; email: string } | null;
	recurring_plan?: RecurringPlanReference | null;
	recurring_plan_id?: string | null;
	line_items?: InvoiceLineItem[];
	jobs?: InvoiceJob[];
	visits?: InvoiceVisit[];
	payments?: InvoicePayment[];
	notes?: InvoiceNote[];
	/**
	 * Jobs and visits a line names that `jobs` / `visits` do not — an adjustment
	 * carries its root's attribution without the root's billing links. Detail
	 * GET only, and kept separate because these bill nothing.
	 */
	unlinked_sources?: {
		jobs: JobReference[];
		visits: VisitReference[];
	} | null;
}

// ============================================================================
// CREATE / UPDATE INPUTS
// ============================================================================

export interface CreateInvoiceInput extends PricingBreakdown {
	client_id: string;
	recurring_plan_id?: string | null;

	issue_date?: Date | string;
	due_date?: Date | string | null;
	payment_terms_days?: number | null;

	memo?: string | null;
	internal_notes?: string | null;

	line_items?: CreateInvoiceLineItemInput[];

	// Job linkage
	job_ids?: string[];
	job_billings?: Array<{ job_id: string; billed_amount: number }>;
	visit_billings?: Array<{ visit_id: string; billed_amount: number }>;
}

export interface UpdateInvoiceInput extends Partial<PricingBreakdown> {
	status?: InvoiceStatus;
	issue_date?: Date | string;
	due_date?: Date | string | null;
	payment_terms_days?: number | null;
	sent_at?: Date | string | null;
	viewed_at?: Date | string | null;
	memo?: string | null;
	internal_notes?: string | null;
	void_reason?: string | null;
	line_items?: UpdateInvoiceLineItemInput[];
}

// ============================================================================
// DERIVED / UTILITY TYPES
// ============================================================================

/** Summary shape used in lists / references — subset of full Invoice */
export interface InvoiceSummary {
	id: string;
	invoice_number: string;
	client_id: string;
	status: InvoiceStatus;
	total: number | null;
	amount_paid: number;
	balance_due: number;
	issue_date: Date | string | null;
	due_date?: Date | string | null;
}

export function isOverdue(invoice: Pick<Invoice, "status" | "due_date">): boolean {
	if (invoice.status === "Paid" || invoice.status === "Void") return false;
	if (!invoice.due_date) return false;
	return new Date(invoice.due_date) < new Date();
}

export function isEditable(status: InvoiceStatus): boolean {
	// Only Draft is editable; Issued and beyond are finalized
	return status === "Draft";
}

export function isDeletable(status: InvoiceStatus): boolean {
	return status === "Draft";
}

export function canRecordPayment(status: InvoiceStatus): boolean {
	return status !== "Void" && status !== "Paid";
}

export function getPaymentProgress(invoice: Pick<Invoice, "total" | "amount_paid">): number {
	const total = invoice.total ?? 0;
	if (total <= 0) return 0;
	return Math.min(1, invoice.amount_paid / total);
}

// ============================================================================
// PIPELINE TYPES
// ============================================================================

export interface OverlapWarning {
	visit_id: string;
	scheduled_start_at: string;
	existing_invoices: Array<{
		invoice_id: string;
		invoice_number: string;
		status: string;
		billed_amount: number | null;
	}>;
}

export interface BillingRef {
	billed_amount: number | null;
	invoice: {
		id: string;
		invoice_number: string;
		status: InvoiceStatus;
		issue_date: string | null;
	};
}

export interface GenerateInvoiceInput {
	source: "recurring_plan";
	plan_id: string;
	memo?: string;
	payment_terms_days?: number;
}

export interface GenerateInvoiceResponse {
	invoice: Invoice;
	warnings: OverlapWarning[];
	note?: string;
}
