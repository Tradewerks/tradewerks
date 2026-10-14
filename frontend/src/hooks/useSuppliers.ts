import { useInfiniteQuery, useMutation, useQueryClient, keepPreviousData, type InfiniteData, type UseInfiniteQueryResult, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import { qk } from "../lib/queryKeys";
import * as suppliersApi from "../api/suppliers";
import type {
	CreateSupplierInput,
	ListSuppliersParams,
	UpdateSupplierInput,
} from "../api/suppliers";
import type {
	Supplier,
	SupplierBatch,
	SupplierDetail,
	SupplierMergeResult,
	SupplierMovementsPage,
} from "../types/suppliers";

const useQuery = moduleQuery("inventory");

export const useSuppliers = (
	params: ListSuppliersParams = {},
	enabled = true,
): UseQueryResult<Supplier[], Error> => {
	return useQuery({
		queryKey: qk.suppliers.list({
			search: params.search,
			active: params.active ?? "true",
			includeUsage: params.include_usage ?? false,
		}),
		queryFn: () => suppliersApi.getSuppliers(params),
		enabled,
		// The capture typeahead re-mounts on every intake form; the vendor list
		// changes far more slowly than that.
		staleTime: 60_000,
	});
};

export const useCreateSupplier = (): UseMutationResult<Supplier, Error, CreateSupplierInput> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: suppliersApi.createSupplier,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
		},
	});
};

export const useUpdateSupplier = (): UseMutationResult<
	Supplier,
	Error,
	{ id: string; data: UpdateSupplierInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateSupplierInput }) =>
			suppliersApi.updateSupplier(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
			// A rename shows up in the cost-origin strip on every item detail page.
			queryClient.invalidateQueries({ queryKey: qk.inventory.all });
		},
	});
};

// Single-vendor fetch for the detail page (GET /suppliers/:id).
export const useSupplierQuery = (
	id: string | undefined,
): UseQueryResult<SupplierDetail, Error> => {
	return useQuery({
		queryKey: qk.suppliers.detail(id ?? ""),
		queryFn: () => suppliersApi.getSupplier(id!),
		enabled: !!id,
	});
};

// Cursor-paginated purchase ledger — an infinite query, not one query per
// cursor, so pages live in the cache instead of component state. Same fix as
// useInventoryMovementsQuery (useInventory.ts): a per-cursor query + accumulate-
// in-state pattern can append a page twice or pair a stale result set's cursor
// with a reset filter. keepPreviousData keeps the list visible while a new
// vendor's first page loads.
export const useSupplierMovementsQuery = (
	id: string | undefined,
): UseInfiniteQueryResult<InfiniteData<SupplierMovementsPage, string | undefined>, Error> => {
	return useInfiniteQuery({
		queryKey: qk.suppliers.movements(id ?? ""),
		queryFn: ({ pageParam }) => suppliersApi.getSupplierMovements(id!, pageParam),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled: !!id,
		placeholderData: keepPreviousData,
	});
};

export const useSupplierBatchesQuery = (
	id: string | undefined,
): UseQueryResult<SupplierBatch[], Error> => {
	return useQuery({
		queryKey: qk.suppliers.batches(id ?? ""),
		queryFn: () => suppliersApi.getSupplierBatches(id!),
		enabled: !!id,
	});
};

export const useMergeSuppliers = (): UseMutationResult<
	SupplierMergeResult,
	Error,
	{ sourceId: string; targetId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ sourceId, targetId }: { sourceId: string; targetId: string }) =>
			suppliersApi.mergeSuppliers(sourceId, targetId),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: qk.suppliers.all });
			// Repointed movements regroup the whole bySupplier rollup, so every
			// cached price-history response is now stale.
			queryClient.invalidateQueries({ queryKey: qk.inventory.all });
		},
	});
};
