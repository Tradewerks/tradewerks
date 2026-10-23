import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import type { TaxRate, TaxGroup } from "../types/tax";
import type {
	CreateTaxRateInput,
	UpdateTaxRateInput,
	CreateTaxGroupInput,
	UpdateTaxGroupInput,
} from "../api/tax";
import * as taxApi from "../api/tax";

// ============================================================================
// TAX RATE QUERIES
// ============================================================================

export const useTaxRates = (includeInactive?: boolean): UseQueryResult<TaxRate[], Error> => {
	return useQuery({
		queryKey: ["tax-rates", { includeInactive: includeInactive ?? false }],
		queryFn: () => taxApi.getTaxRates(includeInactive),
	});
};

// ============================================================================
// TAX GROUP QUERIES
// ============================================================================

export const useTaxGroups = (includeInactive?: boolean): UseQueryResult<TaxGroup[], Error> => {
	return useQuery({
		queryKey: ["tax-groups", { includeInactive: includeInactive ?? false }],
		queryFn: () => taxApi.getTaxGroups(includeInactive),
	});
};

export const useDefaultTaxGroup = (): UseQueryResult<TaxGroup | null, Error> => {
	return useQuery({
		queryKey: ["tax-groups", "default"],
		queryFn: taxApi.getDefaultTaxGroup,
	});
};

// ============================================================================
// TAX RATE MUTATIONS
// ============================================================================

export const useCreateTaxRate = (): UseMutationResult<TaxRate, Error, CreateTaxRateInput> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: taxApi.createTaxRate,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["tax-rates"] });
		},
		onError: (error: Error) => {
			console.error("Failed to create tax rate:", error);
		},
	});
};

export const useUpdateTaxRate = (): UseMutationResult<
	TaxRate,
	Error,
	{ id: string; data: UpdateTaxRateInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateTaxRateInput }) =>
			taxApi.updateTaxRate(id, data),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["tax-rates"] });
			// A rate change can affect the combined_rate on any group containing it
			queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
		},
		onError: (error: Error) => {
			console.error("Failed to update tax rate:", error);
		},
	});
};

export const useDeleteTaxRate = (): UseMutationResult<{ id: string }, Error, string> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: taxApi.deleteTaxRate,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["tax-rates"] });
			queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
		},
		onError: (error: Error) => {
			console.error("Failed to delete tax rate:", error);
		},
	});
};

// ============================================================================
// TAX GROUP MUTATIONS
// ============================================================================

export const useCreateTaxGroup = (): UseMutationResult<
	TaxGroup,
	Error,
	CreateTaxGroupInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: taxApi.createTaxGroup,
		onSuccess: (newGroup) => {
			queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
			if (newGroup.is_default) {
				queryClient.invalidateQueries({ queryKey: ["tax-groups", "default"] });
			}
		},
		onError: (error: Error) => {
			console.error("Failed to create tax group:", error);
		},
	});
};

export const useUpdateTaxGroup = (): UseMutationResult<
	TaxGroup,
	Error,
	{ id: string; data: UpdateTaxGroupInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateTaxGroupInput }) =>
			taxApi.updateTaxGroup(id, data),
		// Returned so mutateAsync waits for the refetch; callers that close on success
		// would otherwise flash the old default. The prefix also covers ["tax-groups", "default"].
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tax-groups"] }),
		onError: (error: Error) => {
			console.error("Failed to update tax group:", error);
		},
	});
};

export const useDeleteTaxGroup = (): UseMutationResult<{ id: string }, Error, string> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: taxApi.deleteTaxGroup,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["tax-groups"] });
			// invalidate also covers the default — re-fetches if deleted group was default
			queryClient.invalidateQueries({ queryKey: ["tax-groups", "default"] });
		},
		onError: (error: Error) => {
			console.error("Failed to delete tax group:", error);
		},
	});
};
