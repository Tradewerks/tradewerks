import type { StockLocationType } from "./inventory";

/**
 * Emergency field procurement. Mirrors the selects in
 * backend/src/controllers/fieldPurchasesController.ts.
 *
 * Money arrives as a string: every amount is a Postgres numeric(10,2), and
 * JSON-parsing it into a float is how cents go missing.
 */

export type FieldPurchaseStatus =
	| "draft"
	| "pending_preauth"
	| "preauth_denied"
	| "preauth_approved"
	| "pending_review"
	| "queried"
	| "pending_second_signoff"
	| "approved"
	| "rejected";

/** Mirrors TECH_EDITABLE_STATUSES in backend/src/lib/fieldPurchase.ts. */
export const TECH_EDITABLE_STATUSES: readonly FieldPurchaseStatus[] = [
	"draft",
	"preauth_approved",
	"preauth_denied",
	"queried",
];

export const isTechEditable = (status: FieldPurchaseStatus): boolean =>
	TECH_EDITABLE_STATUSES.includes(status);

/**
 * Nothing has been bought in any of these, so vendor, receipt, purchase date and
 * lines cannot hold a value yet. A surface printing a "not recorded" fallback for
 * them invents a gap rather than reporting one.
 */
export const PRE_PURCHASE_STATUSES: readonly FieldPurchaseStatus[] = [
	"draft",
	"pending_preauth",
	"preauth_denied",
	"preauth_approved",
];

export const isPrePurchase = (status: FieldPurchaseStatus): boolean =>
	PRE_PURCHASE_STATUSES.includes(status);

/** A refund is the same shape pointing back at the purchase it reverses. */
export type FieldPurchaseKind = "purchase" | "refund";

/**
 * `consume` is absent on purpose: a part bought at a counter was never on our
 * shelf to deduct. `receive` is the spec's "Added to stock", `non_stock` its
 * "Consumed on job (job cost, no stock change)".
 */
export type FieldPurchaseDisposition = "receive" | "non_stock";

/** `skipped` is a success: no provider is configured, so the lines are typed in. */
export type FieldPurchaseOcrStatus = "not_run" | "skipped" | "pending" | "succeeded" | "failed";

/** Mirrors OCR_LOW_CONFIDENCE in backend/src/services/receiptOcr/index.ts. */
export const OCR_LOW_CONFIDENCE = 0.75;

export interface FieldPurchaseGrant {
	id: string;
	technician_id: string;
	per_transaction_limit: string;
	daily_limit: string | null;
	weekly_limit: string | null;
	per_job_limit: string | null;
	is_active: boolean;
	granted_at: string;
	revoked_at: string | null;
	notes: string | null;
	technician: { id: string; name: string; email: string };
	granted_by: { id: string; name: string } | null;
	revoked_by: { id: string; name: string } | null;
}

export interface FieldPurchaseLine {
	id: string;
	description: string;
	quantity: string;
	unit_price: string;
	line_total: string;
	inventory_item_id: string | null;
	disposition: FieldPurchaseDisposition | null;
	disposition_location: StockLocationType | null;
	disposition_vehicle_id: string | null;
	/** Which job's share this line is. Null on a line nobody has claimed yet. */
	allocation_id: string | null;
	/** Null until the technician confirms the line; submit refuses while any is null. */
	verified_at: string | null;
	/** Null on any line the technician typed or edited. */
	ocr_confidence: string | null;
	sort_order: number;
	/** The billable visit row this line raised at submit; null until then. */
	visit_line_item_id: string | null;
	/** `provisional` is why a mapped line can still owe the reconcile queue a decision. */
	inventory_item: {
		id: string;
		name: string;
		sku: string | null;
		unit: string;
		provisional: boolean;
	} | null;
	disposition_vehicle: { id: string; name: string } | null;
}

export interface FieldPurchaseAllocation {
	id: string;
	job_id: string;
	/** The visit the charge lands on. Without one the purchase cannot bill. */
	job_visit_id: string | null;
	/** Derived from the lines assigned to this job — never typed, never sent. */
	amount: string;
	job: { id: string; job_number: string | null; name: string | null } | null;
	job_visit: { id: string; name: string | null; scheduled_start_at: string | null } | null;
}

/** Advisory only — a flag routes a dispatcher's attention, it never blocks. */
export interface FieldPurchaseFlag {
	code:
		| "total_mismatch"
		| "outside_job_window"
		| "over_estimate"
		| "limit_breach"
		| "geo_missing"
		| "duplicate_suspected"
		| "velocity"
		| "split_transaction"
		| "refund_unsettled"
		| "not_billed";
	message: string;
}

export interface FieldPurchase {
	id: string;
	status: FieldPurchaseStatus;
	kind: FieldPurchaseKind;
	parent_purchase_id: string | null;
	/** Null while the credit is still owed, whatever the paperwork says. */
	refund_settled_at: string | null;
	technician_id: string;
	reason: string | null;
	estimated_amount: string | null;
	vendor_name: string | null;
	supplier_id: string | null;
	purchased_at: string | null;
	subtotal: string;
	tax_amount: string;
	total: string;
	receipt_image_url: string | null;
	captured_at: string | null;
	/**
	 * Whether the device supplied a position, which is all any screen asks. The
	 * coordinates themselves are sensitive personal information and come only from
	 * `getCaptureLocation`, behind `view_field_purchase_location`.
	 */
	has_geo: boolean;
	submitted_at: string | null;
	preauth_requested_at: string | null;
	preauth_decided_at: string | null;
	preauth_note: string | null;
	reviewed_at: string | null;
	review_note: string | null;
	second_signoff_at: string | null;
	second_signoff_note: string | null;
	second_signoff_by: { id: string; name: string } | null;
	flags: FieldPurchaseFlag[];
	ocr_status: FieldPurchaseOcrStatus;
	ocr_provider: string | null;
	/** `{ field: 0..1 }` for the header fields the provider reported on. */
	ocr_field_confidence: Record<string, number>;
	ocr_completed_at: string | null;
	ocr_error: string | null;
	ocr_line_count: number | null;
	ocr_corrections: number | null;
	created_at: string;
	updated_at: string;
	qb_purchase_id: string | null;
	qb_sync_status: "not_synced" | "synced" | "failed";
	technician: { id: string; name: string };
	supplier: { id: string; name: string } | null;
	preauth_by: { id: string; name: string } | null;
	reviewed_by: { id: string; name: string } | null;
	lines: FieldPurchaseLine[];
	allocations: FieldPurchaseAllocation[];
	/** Detail read only, and only on an approved purchase. */
	refund_summary?: FieldPurchaseRefundSummary;
	/** Detail read only, and only on a refund. */
	parent?: FieldPurchaseRefundParent | null;
}

/** The refunds raised against one approved purchase. Money is claim-sized. */
export interface FieldPurchaseRefundSummary {
	/** A refund already started and not yet sent — "Return a part" resumes it. */
	draft_id: string | null;
	/** Sent and not yet decided. */
	in_progress_count: number;
	in_progress_value: string;
	/** Approved, credit not in yet. */
	approved_value: string;
	settled_value: string;
	/** What can still be refunded against this purchase. */
	remaining: string;
	refunds: {
		id: string;
		status: FieldPurchaseStatus;
		amount: string;
		refund_settled_at: string | null;
		created_at: string;
		/** When the part went back — the credit slip's date, once there is one. */
		returned_at?: string | null;
		/** Absent from a server older than this client, so read with a fallback. */
		parts?: { description: string; quantity: string }[];
	}[];
}

/** One line of the purchase a refund reverses. */
export interface FieldPurchaseRefundParentLine {
	id: string;
	description: string;
	inventory_item_id: string | null;
	unit_price: string;
	quantity: string;
	/** Net of every other refund's claim on the same item. */
	returnable_qty: string;
	/** Where stock comes back off on approval: the parent's destination, not the refund's. */
	disposition: FieldPurchaseDisposition | null;
	vehicle_name: string | null;
}

export interface FieldPurchaseRefundParent {
	id: string;
	vendor_name: string | null;
	total: string;
	purchased_at: string | null;
	/** Left to refund, not counting this refund itself. */
	remaining: string;
	lines: FieldPurchaseRefundParentLine[];
}

/**
 * What the receipt itself read, which is not what the purchase now holds:
 * extraction never overwrites a technician's own value, and never applies lines
 * onto a purchase that already has some. Fetched apart from the purchase because
 * the snapshot is only ever needed by the one screen editing it.
 */
/**
 * Where the photo was taken. Its own request, and its own permission, because it
 * is the only part of a purchase that is sensitive personal information about the
 * technician rather than a record of the spend.
 */
export interface FieldPurchaseCaptureLocation {
	capture_lat: string | null;
	capture_lng: string | null;
	capture_accuracy_m: number | null;
	captured_at: string | null;
}

export interface FieldPurchaseExtraction {
	status: FieldPurchaseOcrStatus;
	provider: string | null;
	completed_at: string | null;
	field_confidence: Record<string, number>;
	lines: {
		description: string;
		quantity: number;
		unit_price: number;
		line_total: number;
		confidence: number | null;
		/** Whether the server wrote this line onto the purchase. */
		applied: boolean;
	}[];
	/** Null where the payload came from a provider the server cannot re-map. */
	header: {
		vendor_name: string | null;
		purchased_at: string | null;
		subtotal: number | null;
		tax_amount: number | null;
		total: number | null;
	} | null;
}

/** Append-only trail. A correction is another row, never an edit. */
export interface FieldPurchaseEvent {
	id: string;
	type: string;
	actor_type: string;
	actor_id: string | null;
	detail: Record<string, unknown>;
	at: string;
}

export interface FieldPurchaseDetail {
	purchase: FieldPurchase;
	events: FieldPurchaseEvent[];
}

export interface LimitBreach {
	code: "per_transaction" | "daily" | "weekly" | "per_job";
	limit: string;
	would_be: string;
	job_id?: string;
}

export interface LimitVerdict {
	/** False only when the grant is missing or revoked. */
	authorized: boolean;
	/** True when a ceiling would be crossed, so the pre-authorization path applies. */
	requires_preauth: boolean;
	breaches: LimitBreach[];
}

export interface SpentSoFar {
	today: string;
	week: string;
}

export interface MyFieldPurchaseAuthority {
	grant: FieldPurchaseGrant | null;
	spent: SpentSoFar;
}

export interface LimitCheckResult {
	verdict: LimitVerdict;
	spent: SpentSoFar;
}

export interface SubmitResult {
	purchase: FieldPurchase;
	flags: FieldPurchaseFlag[];
}

export const FIELD_PURCHASE_STATUS_LABELS: Record<FieldPurchaseStatus, string> = {
	draft: "Draft",
	pending_preauth: "Awaiting pre-approval",
	preauth_denied: "Pre-approval denied",
	preauth_approved: "Pre-approved",
	pending_review: "Pending review",
	queried: "Needs a change",
	pending_second_signoff: "Awaiting second sign-off",
	approved: "Approved",
	rejected: "Rejected",
};

export const DISPOSITION_LABELS: Record<FieldPurchaseDisposition, string> = {
	receive: "Added to stock",
	non_stock: "Consumed on job",
};

/**
 * A flag count is not triage: a suspected duplicate and a missing GPS fix are
 * both "1". Severity is what orders the queue's attention, and the short label
 * is what fits in a row.
 */
export const FLAG_META: Record<
	FieldPurchaseFlag["code"],
	{ label: string; severity: "high" | "medium" | "low" }
> = {
	duplicate_suspected: { label: "Possible duplicate", severity: "high" },
	split_transaction: { label: "Split transaction", severity: "high" },
	velocity: { label: "Unusual frequency", severity: "high" },
	limit_breach: { label: "Over limit", severity: "high" },
	over_estimate: { label: "Over estimate", severity: "medium" },
	total_mismatch: { label: "Total mismatch", severity: "medium" },
	outside_job_window: { label: "Outside job window", severity: "medium" },
	refund_unsettled: { label: "Refund owed", severity: "medium" },
	not_billed: { label: "Not billed", severity: "medium" },
	geo_missing: { label: "No location", severity: "low" },
};

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

/**
 * Worst first. A row names only the head and counts the tail, so anything reading
 * the whole set aloud must use the same order or contradict the "+2" beside it.
 * Replaces a `worstFlag` that returned the head alone; keeping both meant two sorts
 * that could disagree.
 */
export function flagsBySeverity(flags: FieldPurchaseFlag[]): FieldPurchaseFlag[] {
	return [...flags].sort(
		(a, b) =>
			SEVERITY_RANK[FLAG_META[a.code]?.severity ?? "low"] -
			SEVERITY_RANK[FLAG_META[b.code]?.severity ?? "low"]
	);
}

/** Money arrives as a numeric string here too — see the note at the top. */
export interface FieldPurchaseSummary {
	open_count: number;
	open_value: string;
	/** Per stage, so the queue rail can show where work is piling up. */
	pending_preauth_count: number;
	pending_review_count: number;
	pending_signoff_count: number;
	/** Answered and handed back — counted apart, since it is not awaiting us. */
	with_tech_count: number;
	/** Null when nothing is waiting, which is not the same as "waiting zero hours". */
	oldest_open_at: string | null;
	flagged_count: number;
	unsettled_refund_count: number;
	unsettled_refund_value: string;
}
