import type { InventoryItem } from "./inventory";

export type InventoryImportStatus =
	| "uploaded"
	| "processing"
	| "ready_for_review"
	| "committing"
	| "committed"
	| "undoing"
	| "undone"
	| "failed"
	| "cancelled";

export type InventoryImportAction = "create" | "update" | "skip" | "conflict";

export interface InventoryImportSource {
	id: string;
	original_filename: string;
	mime_type?: string;
	size_bytes?: number;
	sha256?: string;
	source_type: "spreadsheet" | "csv" | "pdf" | "invoice_image" | "product_photo";
	extraction_status: "pending" | "processing" | "extracted" | "failed" | "unsupported";
	extraction_metadata?: Record<string, unknown>;
	error_message?: string | null;
}

export interface InventoryImport {
	id: string;
	status: InventoryImportStatus;
	revision: number;
	total_count: number;
	create_count: number;
	update_count: number;
	skip_count: number;
	conflict_count: number;
	low_confidence_count: number;
	blocking_count?: number;
	actionable_count?: number;
	financial_summary?: {
		row_count: number;
		unapproved_count: number;
		quantity_total: number;
		cost_total: number;
		unit_price_total: number;
		cost_at_receipt_total: number;
	};
	error_code?: string | null;
	error_message?: string | null;
	retryable: boolean;
	created_at: string;
	ready_at?: string | null;
	committed_at?: string | null;
	undo_expires_at?: string | null;
	undone_at?: string | null;
	sources: InventoryImportSource[];
}

export interface InventoryImportIssue {
	field: string;
	code: string;
	message: string;
}

export interface InventoryImportCandidate {
	id: string;
	import_id: string;
	revision: number;
	sheet_name?: string | null;
	row_number?: number | null;
	page_number?: number | null;
	image_index?: number | null;
	raw_values: Record<string, unknown>;
	normalized_proposal: Record<string, unknown>;
	user_overrides: Record<string, unknown>;
	field_confidence: Record<string, number>;
	field_evidence: Record<string, { source: string; value: unknown; method: string }>;
	matching_evidence: Record<string, unknown>;
	proposed_action: InventoryImportAction;
	existing_item_id?: string | null;
	existing_item?: Pick<InventoryItem, "id" | "name" | "sku" | "barcode" | "quantity" | "unit" | "location" | "cost" | "unit_price"> | null;
	duplicate_group?: string | null;
	variant_group_suggestion?: Record<string, unknown> | null;
	validation_issues: InventoryImportIssue[];
	selected: boolean;
	low_confidence: boolean;
	financial_fields: string[];
	requires_financial_approval: boolean;
	financial_approved_at?: string | null;
	source: InventoryImportSource;
}

export interface InventoryImportPage<T> {
	items: T[];
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
}

export interface CandidateFilters {
	page?: number;
	page_size?: number;
	action?: InventoryImportAction;
	low_confidence?: boolean;
	selected?: boolean;
	search?: string;
}
