import { api, queryParams } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { FieldPurchaseStatus } from "../types/fieldPurchases";
import { triggerDownload } from "../util/download";
import type {
	InventoryItem,
	InventoryTag,
	InventorySortOption,
	CreateInventoryItemInput,
	UpdateInventoryItemInput,
	MovementsPage,
	ItemUsage,
	ItemForecastResult,
	ValueHistory,
	PriceHistory,
	ItemConsumptionTrend,
} from "../types/inventory";

// ============================================
// INVENTORY API
// ============================================

export const getAllInventory = async (
	lowStock?: boolean,
	sort?: InventorySortOption,
): Promise<InventoryItem[]> => {
	const params = queryParams({ low_stock: lowStock ? "true" : undefined, sort });
	const response = await api.get<ApiResponse<InventoryItem[]>>("/inventory", { params });

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch inventory");
	}

	return response.data.data || [];
};

export type LinkageEntity = "quote" | "job" | "job_visit" | "recurring_plan" | "invoice";

/** How confident a name -> catalog guess is: exact beats fold beats code. */
export type LinkageMatchTier = "exact" | "case_insensitive" | "code";

export interface LinkageCandidate {
	name: string;
	/** Every line table holding this name unmapped — one Map fixes all of them. */
	entities: LinkageEntity[];
	lines: number;
	/** Summed line value. What the queue ranks on — money, not line count. */
	value: number;
	match: {
		inventory_item_id: string;
		name: string;
		sku: string | null;
		tier: LinkageMatchTier;
	} | null;
	/** Only the reconcile queue fills this; the bare audit endpoint does not. */
	field_purchases?: ReconcilePurchaseOrigin[];
}

/**
 * The field purchase a queue row came off. A receipt line mints a provisional item
 * and bills an unmapped name onto a visit, so it usually explains the row.
 */
export interface ReconcilePurchaseOrigin {
	id: string;
	status: FieldPurchaseStatus;
	vendor_name: string | null;
	technician_name: string;
	purchased_at: string | null;
}

export interface LinkageAudit {
	counts: { entity: LinkageEntity; linked: number; unmapped: number; total: number }[];
	candidates: LinkageCandidate[];
	/** Distinct unmapped names in total — `candidates` is capped server-side. */
	candidate_total: number;
	/** Value of EVERY unmapped name, including the ones past the cap. */
	candidate_value_total: number;
}

/** Backfilled from a null tech id before 2026-08-20, so old rows are approximate. */
export type ItemOrigin = "tech_submission" | "dispatch_quick_add" | "field_purchase" | "import";

export const ITEM_ORIGIN_LABELS: Record<ItemOrigin, string> = {
	tech_submission: "Tech submission",
	dispatch_quick_add: "Dispatch quick-add",
	field_purchase: "Field purchase",
	import: "Import",
};

export interface ReconcileProvisionalRow {
	item_id: string;
	name: string;
	origin: ItemOrigin;
	cost: number | null;
	unit_price: number | null;
	unit: string;
	low_stock_threshold: number | null;
	created_at: string;
	submitted_by: { id: string; name: string } | null;
	vehicle_stocks: { qty_on_hand: number; vehicle: { id: string; name: string } }[];
	lines: number;
	value: number;
	/** Only the reconcile queue fills this; the bare audit endpoint does not. */
	field_purchases?: ReconcilePurchaseOrigin[];
}

export interface ReconcileDismissedRow {
	folded_name: string;
	decided_at: string;
	decided_by: { id: string; name: string } | null;
	reason: string | null;
}

/** An under-specified item row, and a billable line pointing nowhere. */
export interface ReconcileQueue {
	counts: LinkageAudit["counts"];
	coverage: { linked: number; unmapped: number; total: number; pct: number };
	unmapped: LinkageCandidate[];
	unmapped_total: number;
	unmapped_value: number;
	provisional: ReconcileProvisionalRow[];
	/** The whole provisional backlog, not the page. Both are what the strip reads. */
	provisional_total: number;
	provisional_value: number;
	dismissed: ReconcileDismissedRow[];
}

/** Named for the question a dispatcher asks, not for a column and a direction. */
export type ReconcileSort = "value_desc" | "value_asc" | "lines_desc" | "name_asc";

export interface ReconcileQueueParams {
	include_dismissed?: boolean;
	origin?: ItemOrigin;
	search?: string;
	sort?: ReconcileSort;
	/** Both halves are filtered server-side, so paging is a param too. */
	offset?: number;
	limit?: number;
}

export const getReconcileQueue = async (params?: ReconcileQueueParams): Promise<ReconcileQueue> => {
	const response = await api.get<ApiResponse<ReconcileQueue>>("/inventory/reconcile", {
		params: queryParams({
			include_dismissed: params?.include_dismissed ? "true" : undefined,
			origin: params?.origin,
			search: params?.search || undefined,
			sort: params?.sort,
			offset: params?.offset ? String(params.offset) : undefined,
			limit: params?.limit ? String(params.limit) : undefined,
		}),
	});

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to load the reconcile queue");
	}

	return response.data.data;
};

/** The queue's terminal state. Name-scoped: one decision covers every line. */
export const dismissUnmappedName = async (input: {
	name: string;
	reason?: string;
}): Promise<void> => {
	await api.post("/inventory/reconcile/dismiss", input);
};

export const restoreUnmappedName = async (input: { name: string }): Promise<void> => {
	await api.post("/inventory/reconcile/restore", input);
};

export const getLinkageAudit = async (): Promise<LinkageAudit> => {
	const response = await api.get<ApiResponse<LinkageAudit>>("/inventory/linkage-audit");

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to load linkage audit");
	}

	return response.data.data;
};

export const applyLinkageMatch = async (input: {
	name: string;
	inventory_item_id: string;
}): Promise<Record<LinkageEntity, number>> => {
	const response = await api.post<ApiResponse<{ updated: Record<LinkageEntity, number> }>>(
		"/inventory/linkage-audit/apply",
		input,
	);

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to link line items");
	}

	return response.data.data.updated;
};

/**
 * The lines behind one queue row. `entities` says which kinds of document bill
 * the name; this says which documents, so the decision stops being a guess.
 */
export interface ReconcileLineRow {
	entity: LinkageEntity;
	line_id: string;
	document_id: string;
	/** Only the visit route nests, and only it fills this in. */
	parent_id: string | null;
	document_number: string | null;
	document_title: string | null;
	client_name: string | null;
	occurred_at: string | null;
	name: string;
	quantity: number;
	unit_price: number;
	value: number;
}

export const getReconcileLines = async (params: {
	name?: string;
	/** Case-folded, for a dismissal — one decision covers every spelling of the name. */
	folded_name?: string;
	item_id?: string;
}): Promise<{ lines: ReconcileLineRow[]; total: number }> => {
	const response = await api.get<ApiResponse<{ lines: ReconcileLineRow[]; total: number }>>(
		"/inventory/reconcile/lines",
		{
			params: queryParams({
				name: params.name,
				folded_name: params.folded_name,
				item_id: params.item_id,
			}),
		},
	);

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to load the lines for this part");
	}

	return response.data.data;
};

/** A catalog row an unmapped name can point at. Provisional rows included — see the server. */
export interface ReconcileTarget {
	id: string;
	name: string;
	sku: string | null;
	unit: string;
	cost: number | null;
	provisional: boolean;
}

/**
 * The same catalog search without `manage_inventory`: a technician mapping a receipt
 * line needs it and does not hold the reconcile queue's permission.
 */
export const searchCatalog = async (params?: {
	q?: string;
	limit?: number;
}): Promise<ReconcileTarget[]> => {
	const response = await api.get<ApiResponse<ReconcileTarget[]>>("/inventory/search", {
		params: queryParams({
			q: params?.q || undefined,
			limit: params?.limit ? String(params.limit) : undefined,
		}),
	});

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to search the catalog");
	}

	return response.data.data;
};

export const getReconcileTargets = async (params?: {
	q?: string;
	exclude_id?: string;
	limit?: number;
}): Promise<ReconcileTarget[]> => {
	const response = await api.get<ApiResponse<ReconcileTarget[]>>("/inventory/reconcile/targets", {
		params: queryParams({
			q: params?.q || undefined,
			exclude_id: params?.exclude_id,
			limit: params?.limit ? String(params.limit) : undefined,
		}),
	});

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to search the catalog");
	}

	return response.data.data;
};

export interface BulkLinkageResult {
	name: string;
	lines: number;
	/** Per-name: the call succeeds as a whole even when one pair could not land. */
	err?: string;
}

export const applyLinkageMatchBulk = async (input: {
	pairs: { name: string; inventory_item_id: string }[];
}): Promise<{ results: BulkLinkageResult[]; linked: number }> => {
	const response = await api.post<ApiResponse<{ results: BulkLinkageResult[]; linked: number }>>(
		"/inventory/reconcile/apply-bulk",
		input,
	);

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to link line items");
	}

	return response.data.data;
};

/**
 * Lands as provisional so the line can carry a real link immediately,
 * without the dispatcher inventing a cost basis and unit mid-quote.
 */
export const createProvisionalItem = async (input: {
	name: string;
	unit?: string;
	unit_price?: number;
	cost?: number;
}): Promise<InventoryItem> => {
	const response = await api.post<ApiResponse<InventoryItem>>(
		"/inventory/provisional",
		input,
	);

	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to add item");
	}

	return response.data.data;
};

export const getInventoryItem = async (itemId: string): Promise<InventoryItem> => {
	const response = await api.get<ApiResponse<InventoryItem>>(`/inventory/${itemId}`);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch inventory item");
	}

	return response.data.data!;
};

// created_after filters server-side (narrows the query itself), not a
// client-side slice of loaded pages — cursor pagination stays intact.
export const getInventoryMovements = async (
	itemId: string,
	cursor?: string,
	limit?: number,
	createdAfter?: string,
): Promise<MovementsPage> => {
	const params = queryParams({ cursor, limit, created_after: createdAfter });
	const response = await api.get<ApiResponse<MovementsPage>>(
		`/inventory/${itemId}/movements`,
		{ params },
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch stock history");
	}

	return response.data.data!;
};

// ── History & Reports tab (item detail page) ─────────────────────────────────

export const getItemUsage = async (
	itemId: string,
	opts?: { limit?: number; offset?: number; createdAfter?: string },
): Promise<ItemUsage> => {
	const params = queryParams({
		limit: opts?.limit,
		offset: opts?.offset,
		created_after: opts?.createdAfter,
	});
	const response = await api.get<ApiResponse<ItemUsage>>(`/inventory/${itemId}/usage`, {
		params,
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch item usage");
	}

	return response.data.data!;
};

// `forecast: null` is a valid 200 response, not an error; `reason` distinguishes
// an inactive item from an active one with no forecastable data.
export const getItemForecast = async (
	itemId: string,
	lookbackDays?: number,
): Promise<ItemForecastResult> => {
	const params = queryParams({ lookbackDays });
	const response = await api.get<ApiResponse<ItemForecastResult>>(
		`/inventory/${itemId}/forecast`,
		{ params },
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch item forecast");
	}

	return response.data.data ?? { forecast: null, reason: null };
};

// bucket/range mirror consumptionTrendQuerySchema on the backend; defaults
// and caps are resolved server-side.
export const getItemConsumptionTrend = async (
	itemId: string,
	opts?: { bucket?: "week" | "month"; range?: number },
): Promise<ItemConsumptionTrend> => {
	const params = queryParams({ bucket: opts?.bucket, range: opts?.range });
	const response = await api.get<ApiResponse<ItemConsumptionTrend>>(
		`/inventory/${itemId}/consumption-trend`,
		{ params },
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch consumption trend");
	}

	return response.data.data!;
};

export const getItemValueHistory = async (
	itemId: string,
	createdAfter?: string,
): Promise<ValueHistory> => {
	const params = queryParams({ created_after: createdAfter });
	const response = await api.get<ApiResponse<ValueHistory>>(
		`/inventory/${itemId}/value-history`,
		{ params },
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch value history");
	}

	return response.data.data!;
};

export const getItemPriceHistory = async (
	itemId: string,
	opts?: { createdAfter?: string; bucket?: "week" | "month"; range?: number },
): Promise<PriceHistory> => {
	const params = queryParams({
		created_after: opts?.createdAfter,
		bucket: opts?.bucket,
		range: opts?.range,
	});
	const response = await api.get<ApiResponse<PriceHistory>>(
		`/inventory/${itemId}/price-history`,
		{ params },
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch price history");
	}

	return response.data.data!;
};

export const createInventoryItem = async (
	data: CreateInventoryItemInput,
): Promise<InventoryItem> => {
	const response = await api.post<ApiResponse<InventoryItem>>("/inventory", data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create inventory item");
	}

	return response.data.data!;
};

export const updateInventoryItem = async (
	itemId: string,
	data: UpdateInventoryItemInput,
): Promise<InventoryItem> => {
	const response = await api.patch<ApiResponse<InventoryItem>>(`/inventory/${itemId}`, data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update inventory item");
	}

	return response.data.data!;
};

export const deleteInventoryItem = async (itemId: string): Promise<void> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(`/inventory/${itemId}`);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete inventory item");
	}
};

export const adjustStock = async (
	itemId: string,
	delta: number,
): Promise<InventoryItem> => {
	const response = await api.patch<ApiResponse<InventoryItem>>(
		`/inventory/${itemId}/stock`,
		{ delta },
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to adjust stock");
	}

	return response.data.data!;
};

export const scanInventoryItem = async (code: string): Promise<InventoryItem> => {
	const response = await api.get<ApiResponse<InventoryItem>>("/inventory/scan", {
		params: { code },
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "No item found");
	}

	return response.data.data!;
};

export const uploadInventoryImage = async (file: File): Promise<string> => {
	const formData = new FormData();
	formData.append("image", file);

	const response = await api.post<ApiResponse<{ url: string }>>(
		"/inventory/upload-image",
		formData,
		{ headers: { "Content-Type": "multipart/form-data" } },
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to upload image");
	}

	return response.data.data!.url;
};

export interface ImportResult {
	imported: number;
	skipped: { row: number; reason: string }[];
	// Rows that imported but got modified (e.g. unit coerced to default) —
	// distinct from `skipped`; dispatcher may want to review these.
	warnings?: { row: number; message: string }[];
}

export const importInventory = async (file: File): Promise<ImportResult> => {
	const formData = new FormData();
	formData.append("file", file);
	const response = await api.post<ApiResponse<ImportResult>>("/inventory/import", formData, {
		headers: { "Content-Type": "multipart/form-data" },
	});
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to import inventory");
	}
	return response.data.data!;
};

// ============================================
// TAG API
// ============================================

export const getInventoryTags = async (): Promise<InventoryTag[]> => {
	const response = await api.get<ApiResponse<InventoryTag[]>>("/inventory/tags");
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to fetch tags");
	return response.data.data || [];
};

export const createInventoryTag = async (label: string): Promise<InventoryTag> => {
	const response = await api.post<ApiResponse<InventoryTag>>("/inventory/tags", { label });
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to create tag");
	return response.data.data!;
};

export const updateInventoryTag = async (tagId: string, label: string): Promise<InventoryTag> => {
	const response = await api.patch<ApiResponse<InventoryTag>>(`/inventory/tags/${tagId}`, { label });
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to update tag");
	return response.data.data!;
};

export const deleteInventoryTag = async (tagId: string): Promise<void> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(`/inventory/tags/${tagId}`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to delete tag");
};

export const setItemTags = async (itemId: string, tagIds: string[]): Promise<InventoryItem> => {
	const response = await api.put<ApiResponse<InventoryItem>>(`/inventory/${itemId}/tags`, { tag_ids: tagIds });
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to set tags");
	return response.data.data!;
};

export const downloadInventoryTemplate = async (): Promise<void> => {
	const response = await api.get("/inventory/template", { responseType: "blob" });
	triggerDownload(response.data as Blob, "inventory-import-template.xlsx");
};

export const exportLowStockInventory = async (): Promise<void> => {
	const response = await api.get("/inventory/export/low-stock", { responseType: "blob" });
	const dateStr = new Date()
		.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
		.replace(",", "");
	triggerDownload(response.data as Blob, `low-stock-report ${dateStr}.xlsx`);
};
