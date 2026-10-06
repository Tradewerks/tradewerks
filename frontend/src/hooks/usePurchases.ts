import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import * as purchaseApi from "../api/purchases";
import { qk } from "../lib/queryKeys";
import type { Purchase } from "../types/purchases";

const useQuery = moduleQuery("purchasing");


// ============================================================
// queries
// ============================================================
export const useGetPurchaseByIdQuery = (id: string, enabled = true) => {
    return useQuery({
        queryKey: qk.purchases.detail(id),
        queryFn: () => purchaseApi.getPurchase(id),
        enabled,
    })
}

export const useGetPurchasesQuery = (params: purchaseApi.ListPurchasesParams, enabled = true) => {
    return useQuery({
        queryKey: qk.purchases.list(params),
        queryFn: () => purchaseApi.getPurchases(params),
        enabled,
    })
}

// ================================================================
// Mutations 
// ================================================================

export const useCreatePurchaseMutation = (): UseMutationResult<
	Purchase,
	Error,
	purchaseApi.CreatePurchaseInput
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: purchaseApi.createPurchase,
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.purchases.all }),
	});
};

export const useUpdatePurchaseMutation = (): UseMutationResult<
	Purchase,
	Error,
	{ id: string; data: purchaseApi.UpdatePurchaseInput }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }) => purchaseApi.updatePurchase(id, data),
		onSuccess: (_purchase, { id }) => {
			qc.invalidateQueries({ queryKey: qk.purchases.detail(id) });
			qc.invalidateQueries({ queryKey: qk.purchases.all });
		},
	});
};

export const useReplacePurchaseLinesMutation = (): UseMutationResult<
	Purchase,
	Error,
	{ id: string; data: purchaseApi.ReplacePurchaseLinesInput }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }) => purchaseApi.replacePurchaseLines(id, data),
		onSuccess: (_purchase, { id }) => {
			qc.invalidateQueries({ queryKey: qk.purchases.detail(id) });
			qc.invalidateQueries({ queryKey: qk.purchases.all });
		},
	});
};

export const useOrderPurchaseMutation = (): UseMutationResult<Purchase, Error, string> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: purchaseApi.orderPurchase,
		onSuccess: (_purchase, id) => {
			qc.invalidateQueries({ queryKey: qk.purchases.detail(id) });
			qc.invalidateQueries({ queryKey: qk.purchases.all });
		},
	});
};

export const useCancelPurchaseMutation = (): UseMutationResult<
	Purchase,
	Error,
	{ id: string; data?: purchaseApi.CancelPurchaseInput }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }) => purchaseApi.cancelPurchase(id, data),
		onSuccess: (_purchase, { id }) => {
			qc.invalidateQueries({ queryKey: qk.purchases.detail(id) });
			qc.invalidateQueries({ queryKey: qk.purchases.all });
		},
	});
};

export const useReceivePurchaseMutation = (): UseMutationResult<
	{ purchase: Purchase; warnings: string[] },
	Error,
	{ id: string; data: purchaseApi.ReceivePurchaseInput }
> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({ id, data }) => purchaseApi.receivePurchase(id, data),
		onSuccess: (_result, { id }) => {
			qc.invalidateQueries({ queryKey: qk.purchases.detail(id) });
			qc.invalidateQueries({ queryKey: qk.purchases.all });
		},
	});
};

export const useDeletePurchaseMutation = (): UseMutationResult<boolean, Error, string> => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: purchaseApi.deletePurchase,
		onSuccess: (_deleted, id) => {
			qc.removeQueries({ queryKey: qk.purchases.detail(id) });
			void qc.invalidateQueries({ queryKey: qk.purchases.all });
		},
	});
};