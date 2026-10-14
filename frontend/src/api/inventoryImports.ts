import { api, queryParams } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	CandidateFilters,
	InventoryImport,
	InventoryImportCandidate,
	InventoryImportPage,
	InventoryImportStatus,
} from "../types/inventoryImport";

function unwrap<T>(response: { data: ApiResponse<T> }, fallback: string): T {
	if (!response.data.success || response.data.data == null) {
		throw new Error(response.data.error?.message || fallback);
	}
	return response.data.data;
}

async function checkedResponse<T extends { data: ApiResponse<unknown> }>(
	request: Promise<T>,
	fallback: string,
): Promise<T> {
	try {
		return await request;
	} catch (error) {
		const response = (error as { response?: { data?: ApiResponse<unknown> } })?.response;
		throw new Error(response?.data?.error?.message || fallback);
	}
}

export async function createInventoryImport(files: File[]): Promise<{ id: string; status: InventoryImportStatus; revision: number }> {
	const form = new FormData();
	for (const file of files) form.append("files[]", file);
	const response = await checkedResponse(api.post<ApiResponse<{ id: string; status: InventoryImportStatus; revision: number }>>(
		"/inventory/imports",
		form,
		{ headers: { "Content-Type": "multipart/form-data" } },
	), "Failed to create inventory import");
	return unwrap(response, "Failed to create inventory import");
}

export async function getInventoryImports(params: { page?: number; page_size?: number; status?: InventoryImportStatus } = {}): Promise<InventoryImportPage<InventoryImport>> {
	const response = await checkedResponse(api.get<ApiResponse<InventoryImport[]>>("/inventory/imports", { params: queryParams(params) }), "Failed to load inventory imports");
	const items = unwrap(response, "Failed to load inventory imports");
	return {
		items,
		total: response.data.meta?.total ?? items.length,
		page: response.data.meta?.page ?? 1,
		pageSize: response.data.meta?.pageSize ?? items.length,
		hasMore: response.data.meta?.hasMore ?? false,
	};
}

export async function getInventoryImport(id: string): Promise<InventoryImport> {
	return unwrap(await checkedResponse(api.get<ApiResponse<InventoryImport>>(`/inventory/imports/${id}`), "Failed to load inventory import"), "Failed to load inventory import");
}

export async function getInventoryImportCandidates(id: string, filters: CandidateFilters = {}): Promise<InventoryImportPage<InventoryImportCandidate>> {
	const response = await checkedResponse(api.get<ApiResponse<InventoryImportCandidate[]>>(`/inventory/imports/${id}/candidates`, { params: queryParams({ ...filters }) }), "Failed to load import candidates");
	const items = unwrap(response, "Failed to load import candidates");
	return {
		items,
		total: response.data.meta?.total ?? items.length,
		page: response.data.meta?.page ?? 1,
		pageSize: response.data.meta?.pageSize ?? items.length,
		hasMore: response.data.meta?.hasMore ?? false,
	};
}

export interface PatchCandidateInput {
	revision: number;
	proposed_action?: "create" | "update" | "skip" | "conflict";
	existing_item_id?: string | null;
	selected?: boolean;
	accept_non_financial?: boolean;
	values?: Record<string, unknown>;
}

export async function patchInventoryImportCandidate(importId: string, candidateId: string, input: PatchCandidateInput): Promise<InventoryImportCandidate> {
	return unwrap(
		await checkedResponse(api.patch<ApiResponse<InventoryImportCandidate>>(`/inventory/imports/${importId}/candidates/${candidateId}`, input), "Failed to update import candidate"),
		"Failed to update import candidate",
	);
}

export async function approveInventoryImportFinancials(importId: string, revision: number, candidateIds?: string[]) {
	return unwrap(
		await checkedResponse(api.post<ApiResponse<{ approved_count: number; revision: number; approved_at: string }>>(`/inventory/imports/${importId}/financial-approval`, { revision, candidate_ids: candidateIds }), "Failed to approve financial fields"),
		"Failed to approve financial fields",
	);
}

export async function retryInventoryImport(importId: string, revision: number) {
	return unwrap(await checkedResponse(api.post<ApiResponse<{ id: string; status: InventoryImportStatus }>>(`/inventory/imports/${importId}/retry`, { revision }), "Failed to retry import"), "Failed to retry import");
}

export async function commitInventoryImport(importId: string, revision: number) {
	return unwrap(await checkedResponse(api.post<ApiResponse<{ id: string; status: InventoryImportStatus; undo_expires_at: string; item_ids: string[] }>>(`/inventory/imports/${importId}/commit`, { revision }), "Failed to commit import"), "Failed to commit import");
}

export async function undoInventoryImport(importId: string) {
	return unwrap(await checkedResponse(api.post<ApiResponse<{ id: string; status: InventoryImportStatus }>>(`/inventory/imports/${importId}/undo`), "Failed to undo import"), "Failed to undo import");
}

export async function cancelInventoryImport(importId: string) {
	return unwrap(await checkedResponse(api.post<ApiResponse<{ id: string; status: InventoryImportStatus }>>(`/inventory/imports/${importId}/cancel`), "Failed to cancel import"), "Failed to cancel import");
}
