import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as inventoryImportsApi from "../api/inventoryImports";
import { invalidate, qk } from "../lib/queryKeys";
import type { CandidateFilters, InventoryImportStatus } from "../types/inventoryImport";

const ACTIVE_STATUSES = new Set<InventoryImportStatus>(["uploaded", "processing", "committing", "undoing"]);

export function useInventoryImports(params: { page?: number; page_size?: number; status?: InventoryImportStatus } = {}) {
	return useQuery({
		queryKey: qk.inventoryImports.list(params),
		queryFn: () => inventoryImportsApi.getInventoryImports(params),
		refetchInterval: (query) => query.state.data?.items.some((item) => ACTIVE_STATUSES.has(item.status)) ? 2_000 : false,
	});
}

export function useInventoryImport(id: string | undefined) {
	return useQuery({
		queryKey: qk.inventoryImports.detail(id ?? ""),
		queryFn: () => inventoryImportsApi.getInventoryImport(id!),
		enabled: Boolean(id),
		refetchInterval: (query) => query.state.data && ACTIVE_STATUSES.has(query.state.data.status) ? 1_500 : false,
	});
}

export function useInventoryImportCandidates(id: string | undefined, filters: CandidateFilters) {
	return useQuery({
		queryKey: qk.inventoryImports.candidates(id ?? "", { ...filters }),
		queryFn: () => inventoryImportsApi.getInventoryImportCandidates(id!, filters),
		enabled: Boolean(id),
		placeholderData: (previous) => previous,
	});
}

export function useCreateInventoryImport() {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: inventoryImportsApi.createInventoryImport,
		onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.inventoryImports.all }),
	});
}

export function usePatchInventoryImportCandidate(importId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ candidateId, input }: { candidateId: string; input: inventoryImportsApi.PatchCandidateInput }) =>
			inventoryImportsApi.patchInventoryImportCandidate(importId, candidateId, input),
		onSuccess: () => Promise.all([
			queryClient.invalidateQueries({ queryKey: qk.inventoryImports.detail(importId) }),
			queryClient.invalidateQueries({ queryKey: qk.inventoryImports.candidates(importId) }),
		]),
	});
}

export function useApproveInventoryImportFinancials(importId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ revision, candidateIds }: { revision: number; candidateIds?: string[] }) =>
			inventoryImportsApi.approveInventoryImportFinancials(importId, revision, candidateIds),
		onSuccess: () => Promise.all([
			queryClient.invalidateQueries({ queryKey: qk.inventoryImports.detail(importId) }),
			queryClient.invalidateQueries({ queryKey: qk.inventoryImports.candidates(importId) }),
		]),
	});
}

export function useCommitInventoryImport(importId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (revision: number) => inventoryImportsApi.commitInventoryImport(importId, revision),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: qk.inventoryImports.all }),
				invalidate.warehouse(queryClient),
			]);
		},
	});
}

export function useUndoInventoryImport(importId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => inventoryImportsApi.undoInventoryImport(importId),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: qk.inventoryImports.all }),
				invalidate.warehouse(queryClient),
			]);
		},
	});
}

export function useRetryInventoryImport(importId: string) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (revision: number) => inventoryImportsApi.retryInventoryImport(importId, revision),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.inventoryImports.all }),
	});
}
