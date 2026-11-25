import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { ListParams, PagedResult } from "../types/paging";
import { pagedResultFrom } from "../hooks/usePagedList";
import type {
	Request,
	CreateRequestInput,
	UpdateRequestInput,
	RequestNote,
	CreateRequestNoteInput,
	UpdateRequestNoteInput,
} from "../types/requests";


// ============================================================================
// REQUEST API
// ============================================================================

export interface RequestListExtras {
	priority?: string[];
	client_id?: string;
}

// The server's slim list row: no description, coords, quote or job bodies, notes.
export type RequestListRow = Pick<
	Request,
	"id" | "client_id" | "title" | "status" | "priority" | "address" | "created_at" | "updated_at"
> & { client?: { id: string; name: string }; _count?: { quotes: number } };

export const getRequestsPage = async (
	params: ListParams,
	extras: RequestListExtras = {}
): Promise<PagedResult<RequestListRow>> => {
	const response = await api.get<ApiResponse<RequestListRow[]>>("/requests", {
		params: {
			...params,
			status: params.status?.join(","),
			priority: extras.priority?.join(","),
			client_id: extras.client_id,
		},
	});
	return pagedResultFrom(response.data, params);
};

export const getRequestById = async (id: string): Promise<Request> => {
	const response = await api.get<ApiResponse<Request>>(`/requests/${id}`);

	if (!response.data.data) {
		throw new Error("Request not found");
	}

	return response.data.data;
};

export const getRequestsByClientId = async (clientId: string): Promise<Request[]> => {
	const response = await api.get<ApiResponse<Request[]>>(`/clients/${clientId}/requests`);
	return response.data.data || [];
};

export const createRequest = async (input: CreateRequestInput): Promise<Request> => {
	const response = await api.post<ApiResponse<Request>>("/requests", input);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create request");
	}

	return response.data.data!;
};

export const updateRequest = async (id: string, data: UpdateRequestInput): Promise<Request> => {
	const response = await api.put<ApiResponse<Request>>(`/requests/${id}`, data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update request");
	}

	return response.data.data!;
};

export const deleteRequest = async (id: string): Promise<{ id: string }> => {
	const response = await api.delete<ApiResponse<{ id: string }>>(`/requests/${id}`);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete request");
	}

	return response.data.data || { id };
};

// ============================================================================
// REQUEST NOTE API
// ============================================================================

export const getRequestNotes = async (requestId: string): Promise<RequestNote[]> => {
	const response = await api.get<ApiResponse<RequestNote[]>>(`/requests/${requestId}/notes`);
	return response.data.data || [];
};

export const getRequestNoteById = async (
	requestId: string,
	noteId: string
): Promise<RequestNote> => {
	const response = await api.get<ApiResponse<RequestNote>>(
		`/requests/${requestId}/notes/${noteId}`
	);

	if (!response.data.data) {
		throw new Error("Request note not found");
	}

	return response.data.data;
};

export const createRequestNote = async (
	requestId: string,
	data: CreateRequestNoteInput
): Promise<RequestNote> => {
	const response = await api.post<ApiResponse<RequestNote>>(
		`/requests/${requestId}/notes`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create request note");
	}

	return response.data.data!;
};

export const updateRequestNote = async (
	requestId: string,
	noteId: string,
	data: UpdateRequestNoteInput
): Promise<RequestNote> => {
	const response = await api.put<ApiResponse<RequestNote>>(
		`/requests/${requestId}/notes/${noteId}`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update request note");
	}

	return response.data.data!;
};

export const deleteRequestNote = async (
	requestId: string,
	noteId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/requests/${requestId}/notes/${noteId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete request note");
	}

	return response.data.data || { message: "Request note deleted successfully" };
};
