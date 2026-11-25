import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import type {
	Request,
	CreateRequestInput,
	UpdateRequestInput,
	RequestNote,
	CreateRequestNoteInput,
	UpdateRequestNoteInput,
} from "../types/requests";
import * as requestApi from "../api/requests";

// ============================================================================
// REQUEST QUERIES
// ============================================================================

export const useRequestByIdQuery = (
	id: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<Request, Error> => {
	return useQuery({
		queryKey: ["requests", id],
		queryFn: () => requestApi.getRequestById(id!),
		enabled: options?.enabled !== undefined ? options.enabled : !!id,
	});
};

export const useRequestsByClientIdQuery = (
	clientId: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<Request[], Error> => {
	return useQuery({
		queryKey: ["clients", clientId, "requests"],
		queryFn: () => requestApi.getRequestsByClientId(clientId!),
		enabled: options?.enabled !== undefined ? options.enabled : !!clientId,
	});
};

// ============================================================================
// REQUEST MUTATIONS
// ============================================================================

export const useCreateRequestMutation = (): UseMutationResult<
	Request,
	Error,
	CreateRequestInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: requestApi.createRequest,
		onSuccess: (newRequest: Request) => {
			queryClient.invalidateQueries({ queryKey: ["requests"] });

			queryClient.invalidateQueries({
				queryKey: ["clients", newRequest.client_id, "requests"],
			});

			queryClient.invalidateQueries({
				queryKey: ["clients", newRequest.client_id],
			});
			queryClient.invalidateQueries({ queryKey: ["clients"] });

			queryClient.setQueryData(["requests", newRequest.id], newRequest);
			queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
		onError: (error) => {
			console.error("Failed to create request:", error);
		},
	});
};

export const useUpdateRequestMutation = (): UseMutationResult<
	Request,
	Error,
	{ id: string; data: UpdateRequestInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateRequestInput }) =>
			requestApi.updateRequest(id, data),
		onSuccess: (updatedRequest: Request) => {
			queryClient.invalidateQueries({ queryKey: ["requests"] });

			queryClient.invalidateQueries({
				queryKey: ["clients", updatedRequest.client_id, "requests"],
			});

			queryClient.invalidateQueries({
				queryKey: ["clients", updatedRequest.client_id],
			});
			queryClient.invalidateQueries({ queryKey: ["clients"] });

			queryClient.setQueryData(["requests", updatedRequest.id], updatedRequest);
		},
		onError: (error: Error) => {
			console.error("Failed to update request:", error);
		},
	});
};

export const useDeleteRequestMutation = (): UseMutationResult<
	{ id: string },
	Error,
	{ id: string; clientId?: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id }: { id: string; clientId?: string }) =>
			requestApi.deleteRequest(id),
		onSuccess: (_, variables) => {
			const { id: deletedId, clientId } = variables;

			queryClient.invalidateQueries({ queryKey: ["requests"] });

			if (clientId) {
				queryClient.invalidateQueries({
					queryKey: ["clients", clientId, "requests"],
				});
				queryClient.invalidateQueries({
					queryKey: ["clients", clientId],
				});
			}

			queryClient.invalidateQueries({ queryKey: ["clients"] });

			queryClient.removeQueries({ queryKey: ["requests", deletedId] });
		},
		onError: (error: Error) => {
			console.error("Failed to delete request:", error);
		},
	});
};

// ============================================================================
// REQUEST NOTE QUERIES
// ============================================================================

export const useRequestNotesQuery = (
	requestId: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<RequestNote[], Error> => {
	return useQuery({
		queryKey: ["requests", requestId, "notes"],
		queryFn: () => requestApi.getRequestNotes(requestId!),
		enabled: options?.enabled !== undefined ? options.enabled : !!requestId,
	});
};

export const useRequestNoteByIdQuery = (
	requestId: string | null | undefined,
	noteId: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<RequestNote, Error> => {
	return useQuery({
		queryKey: ["requests", requestId, "notes", noteId],
		queryFn: () => requestApi.getRequestNoteById(requestId!, noteId!),
		enabled: options?.enabled !== undefined ? options.enabled : !!(requestId && noteId),
	});
};

// ============================================================================
// REQUEST NOTE MUTATIONS
// ============================================================================

export const useCreateRequestNoteMutation = (): UseMutationResult<
	RequestNote,
	Error,
	{ requestId: string; data: CreateRequestNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			requestId,
			data,
		}: {
			requestId: string;
			data: CreateRequestNoteInput;
		}) => requestApi.createRequestNote(requestId, data),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["requests", variables.requestId],
			});

			void queryClient.invalidateQueries({
				queryKey: ["requests", variables.requestId, "notes"],
			});
		},
		onError: (error: Error) => {
			console.error("Failed to create request note:", error);
		},
	});
};

export const useUpdateRequestNoteMutation = (): UseMutationResult<
	RequestNote,
	Error,
	{ requestId: string; noteId: string; data: UpdateRequestNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			requestId,
			noteId,
			data,
		}: {
			requestId: string;
			noteId: string;
			data: UpdateRequestNoteInput;
		}) => requestApi.updateRequestNote(requestId, noteId, data),
		onSuccess: (updatedNote, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["requests", variables.requestId],
			});

			void queryClient.invalidateQueries({
				queryKey: ["requests", variables.requestId, "notes"],
			});

			queryClient.setQueryData(
				["requests", variables.requestId, "notes", variables.noteId],
				updatedNote
			);
		},
		onError: (error: Error) => {
			console.error("Failed to update request note:", error);
		},
	});
};

export const useDeleteRequestNoteMutation = (): UseMutationResult<
	{ message: string },
	Error,
	{ requestId: string; noteId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ requestId, noteId }: { requestId: string; noteId: string }) =>
			requestApi.deleteRequestNote(requestId, noteId),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["requests", variables.requestId],
			});

			void queryClient.invalidateQueries({
				queryKey: ["requests", variables.requestId, "notes"],
			});

			queryClient.removeQueries({
				queryKey: [
					"requests",
					variables.requestId,
					"notes",
					variables.noteId,
				],
			});
		},
		onError: (error: Error) => {
			console.error("Failed to delete request note:", error);
		},
	});
};
