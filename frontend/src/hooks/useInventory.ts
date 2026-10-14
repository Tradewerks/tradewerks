import { useInfiniteQuery, useMutation, useQueryClient, keepPreviousData, type InfiniteData, type UseInfiniteQueryResult, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";

import type {
	InventoryItem,
	InventoryTag,
	InventorySortOption,
	CreateInventoryItemInput,
	UpdateInventoryItemInput,
	ProvisionalItem,
	MovementsPage,
	ItemUsage,
	ItemForecastResult,
	ValueHistory,
	PriceHistory,
	ItemConsumptionTrend,
} from "../types/inventory";

import * as inventoryApi from "../api/inventory";
import type { ItemOrigin, ReconcileSort } from "../api/inventory";
import * as orgApi from "../api/org";
import { qk, invalidate } from "../lib/queryKeys";
import { useScanDispatcher } from "./useScanDispatcher";

const useQuery = moduleQuery("inventory");

// ============================================================================
// INVENTORY QUERIES
// ============================================================================

export const useAllInventoryQuery = (
	sort?: InventorySortOption,
): UseQueryResult<InventoryItem[], Error> => {
	return useQuery({
		queryKey: qk.inventory.list(sort ? { sort } : undefined),
		queryFn: () => inventoryApi.getAllInventory(false, sort),
	});
};

export const useLowStockInventoryQuery = (): UseQueryResult<InventoryItem[], Error> => {
	return useQuery({
		queryKey: qk.inventory.list({ lowStock: true }),
		queryFn: () => inventoryApi.getAllInventory(true),
	});
};

// Single-item fetch for the item product/detail page (GET /inventory/:id).
export const useInventoryItemQuery = (
	itemId: string | undefined,
): UseQueryResult<InventoryItem, Error> => {
	return useQuery({
		queryKey: qk.inventory.detail(itemId ?? ""),
		queryFn: () => inventoryApi.getInventoryItem(itemId!),
		enabled: !!itemId,
	});
};

// Cursor-paginated stock-movement ledger for the detail page's history section.
// An infinite query, not one query per cursor: the pages are owned by the
// cache, so "Load more" can't append a page twice and a range change can't
// pair the old result set's cursor with the new filter (the old per-cursor
// query + accumulate-in-state pattern did both — review U1). keepPreviousData
// keeps the current pages visible while a new range's first page loads, so
// the range control doesn't flash the list back to a spinner.
export const useInventoryMovementsQuery = (
	itemId: string | undefined,
	opts?: { createdAfter?: string },
): UseInfiniteQueryResult<InfiniteData<MovementsPage, string | undefined>, Error> => {
	return useInfiniteQuery({
		queryKey: qk.inventory.movements(itemId ?? "", opts),
		queryFn: ({ pageParam }) =>
			inventoryApi.getInventoryMovements(itemId!, pageParam, undefined, opts?.createdAfter),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: !!itemId,
		placeholderData: keepPreviousData,
	});
};

// ── History & Reports tab (item detail page) ─────────────────────────────────

// Offset-paginated usage report — jobs/clients this item was consumed on. Same
// infinite-query shape as the movements ledger, keyed on offset instead of a
// cursor (these are GROUP BY aggregate rows with no stable row id).
export const useItemUsageQuery = (
	itemId: string | undefined,
	opts?: { limit?: number; createdAfter?: string },
): UseInfiniteQueryResult<InfiniteData<ItemUsage, number>, Error> => {
	const limit = opts?.limit;
	return useInfiniteQuery({
		queryKey: qk.inventory.usage(itemId ?? "", opts),
		queryFn: ({ pageParam }) =>
			inventoryApi.getItemUsage(itemId!, {
				limit,
				offset: pageParam,
				createdAfter: opts?.createdAfter,
			}),
		initialPageParam: 0,
		getNextPageParam: (last, pages) =>
			last.hasMore ? pages.reduce((n, p) => n + p.usage.length, 0) : undefined,
		enabled: !!itemId,
		placeholderData: keepPreviousData,
	});
};

// `forecast` in the resolved data can legitimately be `null` — that's a valid
// result, not a query error — and `reason` says which cause it was (inactive
// item vs active item with no forecastable row). See ItemForecastResult in
// types/inventory.
export const useItemForecastQuery = (
	itemId: string | undefined,
): UseQueryResult<ItemForecastResult, Error> => {
	return useQuery({
		queryKey: qk.inventory.forecast(itemId ?? ""),
		queryFn: () => inventoryApi.getItemForecast(itemId!),
		enabled: !!itemId,
	});
};

// keepPreviousData keeps the current series on screen while a new range loads,
// so switching the tab's range control doesn't flash the chart to a spinner
// (same reason useItemConsumptionTrendQuery does it).
export const useItemValueHistoryQuery = (
	itemId: string | undefined,
	opts?: { createdAfter?: string },
): UseQueryResult<ValueHistory, Error> => {
	return useQuery({
		queryKey: qk.inventory.valueHistory(itemId ?? "", opts),
		queryFn: () => inventoryApi.getItemValueHistory(itemId!, opts?.createdAfter),
		enabled: !!itemId,
		placeholderData: keepPreviousData,
	});
};

// Cost/price history for the History-tab trend chart. keepPreviousData for the
// same reason as the value-history query: the tab's range control changes the
// server-side window, and the chart shouldn't flash to a spinner to show it.
export const useItemPriceHistoryQuery = (
	itemId: string | undefined,
	opts?: { createdAfter?: string; bucket?: "week" | "month"; range?: number },
): UseQueryResult<PriceHistory, Error> => {
	return useQuery({
		queryKey: qk.inventory.priceHistory(itemId ?? "", opts),
		queryFn: () => inventoryApi.getItemPriceHistory(itemId!, opts),
		enabled: !!itemId,
		placeholderData: keepPreviousData,
	});
};

// Bucketed consumption totals for the History-tab trend chart. keepPreviousData
// keeps the current series visible while the next bucket/range loads, so the
// week/month toggle transitions smoothly instead of flashing a spinner.
export const useItemConsumptionTrendQuery = (
	itemId: string | undefined,
	opts?: { bucket?: "week" | "month"; range?: number },
): UseQueryResult<ItemConsumptionTrend, Error> => {
	return useQuery({
		queryKey: qk.inventory.consumptionTrend(itemId ?? "", opts),
		queryFn: () => inventoryApi.getItemConsumptionTrend(itemId!, opts),
		enabled: !!itemId,
		placeholderData: keepPreviousData,
	});
};

// ============================================================================
// INVENTORY MUTATIONS
// ============================================================================

// low_stock_threshold is edited through the full item form
// (useUpdateInventoryItemMutation) — the threshold-only modal and its dedicated
// mutation are gone, since every field it held already lives in that form.

export const useCreateInventoryItemMutation = (): UseMutationResult<
	InventoryItem,
	Error,
	CreateInventoryItemInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateInventoryItemInput) =>
			inventoryApi.createInventoryItem(data),
		onSuccess: () => {
			invalidate.warehouse(queryClient);
		},
	});
};

export const useUpdateInventoryItemMutation = (): UseMutationResult<
	InventoryItem,
	Error,
	{ itemId: string; data: UpdateInventoryItemInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ itemId, data }: { itemId: string; data: UpdateInventoryItemInput }) =>
			inventoryApi.updateInventoryItem(itemId, data),
		onSuccess: () => {
			invalidate.warehouse(queryClient);
			invalidate.vehicleStock(queryClient);
		},
	});
};

export const useDeleteInventoryItemMutation = (): UseMutationResult<
	void,
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (itemId: string) => inventoryApi.deleteInventoryItem(itemId),
		onSuccess: () => {
			invalidate.warehouse(queryClient);
		},
	});
};

export const useAdjustStockMutation = (): UseMutationResult<
	InventoryItem,
	Error,
	{ itemId: string; delta: number }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ itemId, delta }: { itemId: string; delta: number }) =>
			inventoryApi.adjustStock(itemId, delta),
		onSuccess: () => {
			invalidate.warehouse(queryClient);
			invalidate.vehicleStock(queryClient);
		},
	});
};

export const useUploadInventoryImageMutation = (): UseMutationResult<
	string,
	Error,
	File
> => {
	return useMutation({
		mutationFn: (file: File) => inventoryApi.uploadInventoryImage(file),
	});
};

export const useScanInventoryItem = (): UseMutationResult<
	InventoryItem,
	Error,
	string
> => {
	return useMutation({
		mutationFn: (code: string) => inventoryApi.scanInventoryItem(code),
	});
};

// Thin wrapper over useScanDispatcher — every call site (dispatch inventory,
// vehicle stock, supplier-purchase catalog) only cares about found/not-found,
// so this keeps their signature unchanged while routing through the
// scan-anything resolver (item today; serial/batch once Workstream B lands).
export const useBarcodeScanHandler = (
	onFound: (item: InventoryItem) => void,
	onNotFound: (code: string) => void,
): { handleScan: (code: string) => Promise<void>; isScanning: boolean } => {
	return useScanDispatcher({ onItem: onFound, onNotFound });
};

// ============================================================================
// TAG QUERIES + MUTATIONS
// ============================================================================

export const useInventoryTagsQuery = (): UseQueryResult<InventoryTag[], Error> => {
	return useQuery({
		queryKey: qk.inventory.tags,
		queryFn: () => inventoryApi.getInventoryTags(),
	});
};

export const useCreateInventoryTagMutation = (): UseMutationResult<InventoryTag, Error, string> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (label: string) => inventoryApi.createInventoryTag(label),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: qk.inventory.tags });
		},
	});
};

export const useUpdateInventoryTagMutation = (): UseMutationResult<
	InventoryTag,
	Error,
	{ tagId: string; label: string }
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ tagId, label }) => inventoryApi.updateInventoryTag(tagId, label),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: qk.inventory.tags });
			// Item lists/details cache each tag's label at fetch time (item.tags[].label),
			// not a live join against the tags query — a rename left those showing the old
			// label until an unrelated refetch, same gap delete already closes below.
			invalidate.warehouse(queryClient);
		},
	});
};

export const useDeleteInventoryTagMutation = (): UseMutationResult<void, Error, string> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (tagId: string) => inventoryApi.deleteInventoryTag(tagId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: qk.inventory.tags });
			invalidate.warehouse(queryClient);
		},
	});
};

export const useSetItemTagsMutation = (): UseMutationResult<
	InventoryItem,
	Error,
	{ itemId: string; tagIds: string[] }
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ itemId, tagIds }) => inventoryApi.setItemTags(itemId, tagIds),
		onSuccess: () => {
			invalidate.warehouse(queryClient);
		},
	});
};

// ============================================================================
// PROVISIONAL ITEM QUERIES + MUTATIONS
// ============================================================================

export const useProvisionalItemsQuery = (enabled = true) =>
	useQuery<ProvisionalItem[]>({
		queryKey: qk.inventory.provisional,
		queryFn: () => orgApi.getProvisionalItems(),
		staleTime: 30_000,
		enabled,
	});

export const useLinkageAuditQuery = (enabled = true) =>
	useQuery({
		queryKey: [...qk.inventory.all, "linkage-audit"],
		queryFn: inventoryApi.getLinkageAudit,
		staleTime: 60_000,
		enabled,
	});

/**
 * Invalidates broadly: linking historical lines changes what the item's
 * usage, forecast and charged-price reads return, not just the audit.
 */
export const useApplyLinkageMatchMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: inventoryApi.applyLinkageMatch,
		onSuccess: async (_data, variables) => {
			await qc.invalidateQueries({ queryKey: qk.inventory.reconcile() });
			await qc.invalidateQueries({ queryKey: qk.inventory.list() });
			await qc.invalidateQueries({
				queryKey: qk.inventory.detail(variables.inventory_item_id),
			});
		},
	});
};

/** Invalidates the catalog list too — the picker has to find the new item. */
export const useCreateProvisionalItemMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: inventoryApi.createProvisionalItem,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.inventory.provisional });
			await qc.invalidateQueries({ queryKey: qk.inventory.all });
		},
	});
};

export interface ReconcileQueueOpts {
	includeDismissed?: boolean;
	origin?: ItemOrigin;
	search?: string;
	sort?: ReconcileSort;
	offset?: number;
	limit?: number;
}

/** Filters live in the key because the server applies them. */
export const useReconcileQueueQuery = (opts?: ReconcileQueueOpts, enabled = true) =>
	useQuery({
		queryKey: qk.inventory.reconcile(opts),
		queryFn: () =>
			inventoryApi.getReconcileQueue({
				include_dismissed: opts?.includeDismissed,
				origin: opts?.origin,
				search: opts?.search,
				sort: opts?.sort,
				offset: opts?.offset,
				limit: opts?.limit,
			}),
		staleTime: 60_000,
		// Every control on the page is a server filter, so without this the whole
		// surface — strip, toolbar, selection — unmounts on each keystroke.
		placeholderData: keepPreviousData,
		enabled,
	});

/** The documents behind one row. Only fetched once a row is actually selected. */
export const useReconcileLinesQuery = (key: {
	name?: string;
	foldedName?: string;
	itemId?: string;
}) =>
	useQuery({
		queryKey: qk.inventory.reconcileLines(key),
		queryFn: () =>
			inventoryApi.getReconcileLines({
				name: key.name,
				folded_name: key.foldedName,
				item_id: key.itemId,
			}),
		staleTime: 60_000,
		enabled: Boolean(key.name || key.foldedName || key.itemId),
	});

/** Search runs on the server, so the catalog never has to reach the client whole. */
export const useReconcileTargetsQuery = (
	opts: { q?: string; excludeId?: string },
	enabled = true
) =>
	useQuery({
		queryKey: qk.inventory.reconcileTargets(opts),
		queryFn: () => inventoryApi.getReconcileTargets({ q: opts.q, exclude_id: opts.excludeId }),
		enabled,
		staleTime: 30_000,
		placeholderData: keepPreviousData,
	});

/**
 * The same search from the field. A separate hook rather than a widened guard: the
 * reconcile queue's route stays at `manage_inventory`, which a technician lacks.
 */
export const useCatalogSearchQuery = (opts: { q?: string }, enabled = true) =>
	useQuery({
		queryKey: ["inventory", "search", opts.q ?? ""],
		queryFn: () => inventoryApi.searchCatalog({ q: opts.q }),
		enabled,
		staleTime: 30_000,
		placeholderData: keepPreviousData,
		// A technician without inventory access gets a 403 every time; retrying it
		// three times per keystroke helps nobody.
		retry: false,
	});

/**
 * Accepting a screenful of suggestions at once. Invalidates the whole tree
 * rather than a list of ids: a bulk run touches many items' usage and cost reads.
 */
export const useApplyLinkageMatchBulkMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: inventoryApi.applyLinkageMatchBulk,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.inventory.all });
		},
	});
};

/** Both change what coverage counts, and nothing outside the queue. */
export const useDismissUnmappedMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: inventoryApi.dismissUnmappedName,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.inventory.reconcile() });
		},
	});
};

export const useRestoreUnmappedMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: inventoryApi.restoreUnmappedName,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.inventory.reconcile() });
		},
	});
};

/** Cost is required unless the row already has one. */
export const useApproveItemMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			itemId,
			...body
		}: {
			itemId: string;
			initial_warehouse_qty?: number;
			cost?: number;
			unit?: string;
			low_stock_threshold?: number | null;
			location?: string | null;
		}) => orgApi.approveItem(itemId, body),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.inventory.provisional });
			// The catalog list and the provisional queue are separate cache entries.
			await qc.invalidateQueries({ queryKey: qk.inventory.all });
			await invalidate.warehouse(qc);
		},
	});
};

export const useMergeItemMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ itemId, targetId }: { itemId: string; targetId: string }) =>
			orgApi.mergeItem(itemId, targetId),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.inventory.provisional });
			await invalidate.warehouse(qc);
		},
	});
};

export const useRejectItemMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (itemId: string) => orgApi.rejectItem(itemId),
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: qk.inventory.provisional });
		},
	});
};
