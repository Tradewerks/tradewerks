import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import type {
	FollowupSequence,
	CreateSequenceInput,
	UpdateSequenceInput,
	FollowupEnrollment,
	EnrollInput,
} from "../types/followups";
import * as followupsApi from "../api/followups";
import type { EnrollmentFilters } from "../api/followups";

const useQuery = moduleQuery("followups");

// ============================================================================
// SEQUENCE QUERIES & MUTATIONS
// ============================================================================

export const useSequencesQuery = (): UseQueryResult<FollowupSequence[], Error> => {
	return useQuery({
		queryKey: ["followups", "sequences"],
		queryFn: followupsApi.getSequences,
	});
};

export const useSequenceByIdQuery = (
	id: string | null | undefined,
	options?: { enabled?: boolean }
): UseQueryResult<FollowupSequence, Error> => {
	return useQuery({
		queryKey: ["followups", "sequences", id],
		queryFn: () => followupsApi.getSequenceById(id!),
		enabled: options?.enabled !== undefined ? options.enabled : !!id,
	});
};

export const useCreateSequenceMutation = (): UseMutationResult<
	FollowupSequence,
	Error,
	CreateSequenceInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: followupsApi.createSequence,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["followups", "sequences"] });
		},
		onError: (error) => {
			console.error("Failed to create sequence:", error);
		},
	});
};

export const useUpdateSequenceMutation = (): UseMutationResult<
	FollowupSequence,
	Error,
	{ id: string; data: UpdateSequenceInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateSequenceInput }) =>
			followupsApi.updateSequence(id, data),
		onSuccess: (updated) => {
			queryClient.invalidateQueries({ queryKey: ["followups", "sequences"] });
			queryClient.setQueryData(["followups", "sequences", updated.id], updated);
		},
		onError: (error) => {
			console.error("Failed to update sequence:", error);
		},
	});
};

export const useDeleteSequenceMutation = (): UseMutationResult<{ id: string }, Error, string> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: followupsApi.deleteSequence,
		onSuccess: (_, deletedId) => {
			queryClient.invalidateQueries({ queryKey: ["followups", "sequences"] });
			queryClient.removeQueries({ queryKey: ["followups", "sequences", deletedId] });
		},
		onError: (error) => {
			console.error("Failed to delete sequence:", error);
		},
	});
};

// ============================================================================
// ENROLLMENT QUERIES & MUTATIONS
// ============================================================================

export const useEnrollmentsQuery = (
	filters?: EnrollmentFilters
): UseQueryResult<FollowupEnrollment[], Error> => {
	return useQuery({
		queryKey: ["followups", "enrollments", filters],
		queryFn: () => followupsApi.getEnrollments(filters),
	});
};

export const useEnrollClientMutation = (): UseMutationResult<
	FollowupEnrollment,
	Error,
	EnrollInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: followupsApi.enrollClient,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["followups", "enrollments"] });
			queryClient.invalidateQueries({ queryKey: ["followups", "sequences"] });
		},
		onError: (error) => {
			console.error("Failed to enroll client:", error);
		},
	});
};

export const useStopEnrollmentMutation = (): UseMutationResult<
	FollowupEnrollment,
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: followupsApi.stopEnrollment,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["followups", "enrollments"] });
		},
		onError: (error) => {
			console.error("Failed to stop enrollment:", error);
		},
	});
};
