import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import { qk } from "../lib/queryKeys";
import * as supplierItemsApi from "../api/supplierItems";
import type {
	ListSupplierItemsParams,
	UpdateSupplierItemInput,
	UpsertSupplierItemInput,
} from "../api/supplierItems";
import type { SupplierItem } from "../types/supplierItems";

const useQuery = moduleQuery("inventory");

export const useSupplierItems = (
	params: ListSupplierItemsParams = {},
	enabled = true,
): UseQueryResult<SupplierItem[], Error> => {
	return useQuery({
		queryKey: qk.supplierItems.list({
			supplierId: params.supplier_id,
			inventoryItemId: params.inventory_item_id,
		}),
		queryFn: () => supplierItemsApi.getSupplierItems(params),
		enabled,
	});
};

/**
 * Every mutation here also invalidates the inventory tree: a contract price or a
 * preferred flag changes what the reorder forecast reports for that item, and a
 * forecast still naming yesterday's vendor is the failure this feature exists to fix.
 */
function useSupplierItemMutation<TArgs>(
	mutationFn: (args: TArgs) => Promise<unknown>,
): UseMutationResult<unknown, Error, TArgs> {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: qk.supplierItems.all });
			queryClient.invalidateQueries({ queryKey: qk.inventory.all });
		},
	});
}

export const useUpsertSupplierItem = () =>
	useSupplierItemMutation<UpsertSupplierItemInput>(supplierItemsApi.upsertSupplierItem);

export const useUpdateSupplierItem = () =>
	useSupplierItemMutation<{ id: string; data: UpdateSupplierItemInput }>(({ id, data }) =>
		supplierItemsApi.updateSupplierItem(id, data),
	);

export const usePreferSupplierItem = () =>
	useSupplierItemMutation<string>(supplierItemsApi.preferSupplierItem);

export const useDeleteSupplierItem = () =>
	useSupplierItemMutation<string>(supplierItemsApi.deleteSupplierItem);
