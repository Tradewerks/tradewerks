import z from "zod";
import type { ClientWithPrimaryContact } from "./clients";
import type { Coordinates } from "./location";
import type { DocumentLineage } from "./lineage";
import type {
	Priority,
	BaseNote,
	RequestReference,
	JobReference,
	DispatcherReference,
	LineItemType,
	DiscountType,
} from "./common";
import { PriorityValues } from "./common";
import type { TaxSnapshot } from "./tax";

// ============================================================================
// QUOTE-SPECIFIC TYPES
// ============================================================================

export const QuoteStatusValues = [
	"Draft",
	"Issued",
	"Sent",
	"Viewed",
	"Approved",
	"Disputed",
	"Rejected",
	"Revised",
	"Expired",
	"Cancelled",
] as const;

export type QuoteStatus = (typeof QuoteStatusValues)[number];

// Enum values are DB-frozen; these are the display strings. Issued reads
// "Created", matching the invoice badge of the same name.
export const QuoteStatusLabels: Record<QuoteStatus, string> = {
	Draft: "Draft",
	Issued: "Created",
	Sent: "Sent",
	Viewed: "Viewed",
	Approved: "Approved",
	Disputed: "Disputed",
	Rejected: "Rejected",
	Revised: "Revised",
	Expired: "Expired",
	Cancelled: "Cancelled",
};

export const QuoteStatusColors: Record<QuoteStatus, string> = {
	Draft:     "bg-neutral/20 text-text-tertiary border-border-strong/30",
	Issued:    "bg-primary/20 text-primary-text border-primary/30",
	Sent:      "bg-info/20 text-info-text border-info/30",
	Viewed:    "bg-info/20 text-info-text border-info/30",
	Approved:  "bg-success/20 text-success-text border-success/30",
	Disputed:  "bg-warning/20 text-warning-text border-warning/30",
	Rejected:  "bg-error/20 text-error-text border-error/30",
	// Superseded is not a warning: a revised quote did its job and handed off.
	Revised:   "bg-neutral/20 text-text-tertiary border-border-strong/30",
	Expired:   "bg-orange/20 text-orange-text border-orange/30",
	Cancelled: "bg-error/20 text-error-text border-error/30",
};

// Revised is absent deliberately: quotesController refuses every edit to a
// Cancelled, Rejected or Revised quote, so offering one only earns a 422.
// Approved, Disputed and Expired the server would allow, but Create Revision is
// the intended door for all three — editing a quote the client has already seen
// decided is a rewrite of history, not an edit.
export function isQuoteEditable(status: QuoteStatus): boolean {
	return ["Draft", "Issued", "Sent", "Viewed"].includes(status);
}

// ============================================================================
// QUOTE SUMMARY TYPES (for listings and references)
// ============================================================================

export interface QuoteSummary {
	id: string;
	quote_number: string;
	title: string;
	status: QuoteStatus;
	total: number;
	created_at: Date;
	is_active: boolean;
}

export interface QuoteVersionReference {
	id: string;
	quote_number: string;
	version: number;
	status: QuoteStatus;
}

// ============================================================================
// QUOTE TYPES
// ============================================================================

export interface Quote {
	id: string;
	quote_number: string;
	client_id: string;
	request_id: string | null;
	title: string;
	description: string;
	status: QuoteStatus;
	address: string;
	coords: Coordinates | null;
	priority: Priority;
	is_active: boolean;
	version: number;
	previous_quote_id: string | null;

	subtotal: number;
	tax_rate: number;
	tax_amount: number;
	discount_type?: DiscountType | null;
	discount_value?: number | null;
	discount_amount: number;
	tax_snapshot?: TaxSnapshot | null;
	total: number;

	created_at: Date;
	updated_at: Date;
	issued_at: Date | null;
	sent_at: Date | null;
	viewed_at: Date | null;
	approved_at: Date | null;
	rejected_at: Date | null;
	valid_until: Date | null;
	expires_at: Date | null;

	rejection_reason: string | null;
	created_by_dispatcher_id: string | null;

	client?: ClientWithPrimaryContact;
	request?: RequestReference | null;
	line_items?: QuoteLineItem[];
	notes?: QuoteNote[];
	job?: JobReference | null;
	previous_quote?: QuoteVersionReference | null;
	revised_quote?: QuoteVersionReference | null;
	/** Resolved chain, attached by getQuoteById. Absent on list payloads. */
	lineage?: DocumentLineage | null;
	created_by_dispatcher?: DispatcherReference | null;
}

export interface CreateQuoteInput {
	client_id: string;
	request_id?: string;
	title?: string;
	description?: string;
	address?: string;
	coords?: Coordinates;
	priority: Priority;
	status?: QuoteStatus;
	subtotal?: number;
	tax_rate?: number;
	tax_amount?: number;
	discount_type?: DiscountType;
	discount_value?: number;
	discount_amount?: number;
	total?: number;
	valid_until?: Date | string;
	expires_at?: Date | string;
	created_by_dispatcher_id?: string;
	line_items?: CreateQuoteLineItemInput[];
}

export interface UpdateQuoteInput {
	title?: string;
	description?: string;
	address?: string;
	coords?: Coordinates;
	priority?: Priority;
	status?: QuoteStatus;
	subtotal?: number;
	tax_rate?: number;
	tax_amount?: number;
	discount_type?: DiscountType;
	discount_value?: number;
	discount_amount?: number;
	total?: number;
	valid_until?: Date | string | null;
	expires_at?: Date | string | null;
	rejection_reason?: string | null;
	is_active?: boolean;
}

export const CreateQuoteSchema = z.object({
	client_id: z.string().uuid("Invalid client ID"),
	request_id: z.string().uuid().optional(),
	title: z.string().min(1, "Title is required"),
	description: z.string().min(1, "Description is required"),
	address: z.string().min(1, "Address is required"),
	priority: z.enum(PriorityValues).default("Medium"),
	status: z.enum(QuoteStatusValues).default("Draft"),
	subtotal: z.number().min(0, "Subtotal must be positive"),
	tax_rate: z.number().min(0).max(1).optional(),
	tax_amount: z.number().min(0).optional(),
	discount_amount: z.number().min(0).optional(),
	total: z.number().min(0, "Total must be positive"),
	valid_until: z.coerce.date().optional(),
	expires_at: z.coerce.date().optional(),
	created_by_dispatcher_id: z.string().uuid().optional(),
});

export const UpdateQuoteSchema = z.object({
	title: z.string().min(1).optional(),
	description: z.string().min(1).optional(),
	address: z.string().min(1).optional(),
	priority: z.enum(PriorityValues).optional(),
	status: z.enum(QuoteStatusValues).optional(),
	subtotal: z.number().min(0).optional(),
	tax_rate: z.number().min(0).max(1).optional(),
	tax_amount: z.number().min(0).optional(),
	discount_amount: z.number().min(0).optional(),
	total: z.number().min(0).optional(),
	valid_until: z.coerce.date().optional().nullable(),
	expires_at: z.coerce.date().optional().nullable(),
	rejection_reason: z.string().optional().nullable(),
	is_active: z.boolean().optional(),
});

// ============================================================================
// LINE ITEM TYPES
// ============================================================================

export interface QuoteLineItem {
	id: string;
	quote_id: string;
	name: string;
	description: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	item_type: LineItemType | null;
	sort_order: number;
	taxable: boolean;
	tax_group_id: string | null;
	tax_amount: number | null;
	tax_group?: { id: string; name: string; rates?: { tax_rate: { id: string; name: string; rate: number } }[] } | null;
	/** Catalog link, when the line was picked from inventory rather than typed. */
	inventory_item_id?: string | null;
}

export interface CreateQuoteLineItemInput {
	name: string;
	description?: string;
	quantity: number;
	unit_price: number;
	total: number;
	item_type?: LineItemType;
	sort_order?: number;
	taxable?: boolean;
	tax_group_id?: string | null;
	/** Catalog link. Reference only except on visits, where it plans and deducts stock. */
	inventory_item_id?: string | null;
}

export interface UpdateQuoteLineItemInput {
	name?: string;
	description?: string | null;
	quantity?: number;
	unit_price?: number;
	total?: number;
	item_type?: LineItemType | null;
	sort_order?: number;
	taxable?: boolean;
	tax_group_id?: string | null;
	/** Catalog link. Reference only except on visits, where it plans and deducts stock. */
	inventory_item_id?: string | null;
}

// ============================================================================
// QUOTE NOTES
// ============================================================================

export interface QuoteNote extends BaseNote {
	quote_id: string;
}

export interface CreateQuoteNoteInput {
	content: string;
}

export interface UpdateQuoteNoteInput {
	content: string;
}

export const CreateQuoteNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

export const UpdateQuoteNoteSchema = z.object({
	content: z.string().min(1, "Note content is required"),
});

// ============================================================================
// QUOTE STATISTICS
// ============================================================================

export interface QuoteStatistics {
	total_quotes: number;
	draft_quotes: number;
	pending_quotes: number;
	sent_quotes: number;
	approved_quotes: number;
	rejected_quotes: number;
	expired_quotes: number;
	total_value: number;
	approved_value: number;
	pending_value: number;
}
