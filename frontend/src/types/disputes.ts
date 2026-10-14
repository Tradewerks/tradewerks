export type DisputeKind = "quote" | "invoice";
export type DisputeResolution = "ReviseAndResend" | "IssueAdjustment" | "Repeal";

/**
 * One outcome as the server judges it for the signed-in caller: the document's
 * rules, their grants and separation of duties, in the order a submit is
 * refused. `reason` is that refusal, verbatim (Ruling P11).
 */
export interface DisputeOutcomeState {
	id: DisputeResolution;
	disabled: boolean;
	reason: string | null;
}

/**
 * A contested line as stored on the dispute — a snapshot taken when the
 * dispute opened, not a live id. The line itself can be deleted later (a
 * quote line has no lock against it, unlike an invoice's once issued), so a
 * bare id would resolve to nothing once that happens (DW-69).
 */
export interface ContestedLine {
	id: string;
	name: string;
	total: number;
}

export interface Dispute {
	id: string;
	document_kind: DisputeKind;
	quote_id: string | null;
	invoice_id: string | null;
	status: "Open" | "Resolved";
	reason: string;
	contested_line_item_ids: ContestedLine[] | null;
	status_at_open: string;
	opened_at: string;
	opened_by_dispatcher: { id: string; name: string } | null;
	resolution: DisputeResolution | null;
	resolution_note: string | null;
	resolved_at: string | null;
	resolved_by_dispatcher: { id: string; name: string } | null;
	replacement_quote_id: string | null;
	replacement_invoice_id: string | null;
	adjustment_invoice_id: string | null;
	/** Open disputes only: every outcome in display order. Null once resolved. */
	outcomes: DisputeOutcomeState[] | null;
}

export interface DisputeList {
	disputes: Dispute[];
	/** Why a dispute can't be opened on this document right now, or null. */
	open_refusal: string | null;
	/**
	 * The write-path refusals the lifecycle bar needs but no outcome carries,
	 * both produced server-side from the same functions the writes refuse with:
	 *  - `sold_refusal` (quote): why Convert to Job is shut — a job already
	 *    exists off this quote or a sibling was sold.
	 *  - `void_refusal` (invoice): why the kebab's Void is shut — a payment is
	 *    applied, or a live adjustment names this invoice.
	 * Null when the action is allowed, or on the other document kind.
	 */
	sold_refusal: string | null;
	void_refusal: string | null;
}

export interface OpenDisputeInput {
	reason: string;
	contested_line_item_ids?: string[];
}

/**
 * One delta line on an adjustment document. Mirrors adjustmentLineSchema in
 * backend/src/lib/validate/invoices.ts — negatives are the point (a credit),
 * but a zero quantity or a zero total is rejected server-side.
 */
export interface AdjustmentLineInput {
	name: string;
	description?: string | null;
	quantity: number;
	unit_price: number;
	total: number;
	source_job_id?: string | null;
	source_visit_id?: string | null;
	tax_group_id?: string | null;
	taxable?: boolean;
	inventory_item_id?: string | null;
}

export interface ResolveDisputeInput {
	resolution: DisputeResolution;
	note?: string;
	/** Required by the backend for IssueAdjustment, rejected for every other outcome. */
	adjustment_lines?: AdjustmentLineInput[];
}

/** One row of GET /disputes/open, judged for the signed-in caller. */
export interface OpenDisputeSummary {
	dispute_id: string;
	kind: DisputeKind;
	document_id: string;
	document_number: string;
	client: { id: string; name: string } | null;
	/** Quote total, or invoice balance due. */
	amount: number;
	contested_amount: number | null;
	reason: string;
	opened_at: string;
	opened_by: { id: string; name: string } | null;
	/** The detail page would offer this caller at least one enabled outcome. */
	can_resolve: boolean;
}

export interface OpenDisputeList {
	items: OpenDisputeSummary[];
	/** A kind the caller can't view reads 0. */
	counts: Record<DisputeKind, number>;
	total: number;
}
