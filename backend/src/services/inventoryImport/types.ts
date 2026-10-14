export const FINANCIAL_FIELDS = ["quantity", "cost", "unit_price", "cost_at_receipt"] as const;
export type FinancialField = (typeof FINANCIAL_FIELDS)[number];

export interface ExtractedInventoryRow {
	sheetName?: string;
	rowNumber?: number;
	pageNumber?: number;
	imageIndex?: number;
	ocrBounds?: Record<string, unknown>;
	raw: Record<string, unknown>;
	originalHeaders: string[];
}

export interface InventoryProposal {
	name?: string;
	description?: string;
	location?: string;
	quantity?: number;
	unit?: string;
	unit_price?: number | null;
	cost?: number | null;
	cost_at_receipt?: number | null;
	sku?: string | null;
	barcode?: string | null;
	category?: string | null;
	manufacturer?: string | null;
	model?: string | null;
	low_stock_threshold?: number | null;
	alt_ids?: string[];
	tags?: string[];
	image_urls?: string[];
	is_serialized?: boolean;
	is_batch_tracked?: boolean;
	serial_numbers?: string[];
	lot_number?: string | null;
	external_id?: string | null;
	source_namespace?: string | null;
	variant_group_id?: string | null;
	variant_group_name?: string | null;
	variant_attributes?: Record<string, unknown> | null;
}

export interface MappedInventoryRow {
	proposal: Record<string, unknown>;
	fieldConfidence: Record<string, number>;
	fieldEvidence: Record<string, { source: string; value: unknown; method: "alias" | "ai" }>;
}

export interface NormalizedInventoryRow {
	proposal: InventoryProposal;
	issues: Array<{ field: string; code: string; message: string }>;
	financialFields: FinancialField[];
	lowConfidence: boolean;
}

export interface MatchDecision {
	action: "create" | "update" | "skip" | "conflict";
	existingItemId?: string;
	existingQuantity?: number;
	duplicateGroup?: string;
	evidence: Record<string, unknown>;
}

export class InventoryImportError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly statusCode = 400,
		public readonly retryable = false,
	) {
		super(message);
		this.name = "InventoryImportError";
	}
}
