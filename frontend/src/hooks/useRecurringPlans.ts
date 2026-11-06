import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import type {
	RecurringPlan,
	CreateRecurringPlanInput,
	UpdateRecurringPlanInput,
	UpdateRecurringPlanLineItemsInput,
	RecurringOccurrence,
	GenerateOccurrencesInput,
	OccurrenceGenerationResult,
	SkipOccurrenceInput,
	RescheduleOccurrenceInput,
	BulkSkipOccurrencesInput,
	VisitGenerationResult,
	RecurringPlanNote,
	CreateRecurringPlanNoteInput,
	UpdateRecurringPlanNoteInput,
	TaxEstimate,
	RecurringTaxEstimateInput,
} from "../types/recurringPlans";
import * as recurringPlanApi from "../api/recurringPlans";
import type { Job } from "../types/jobs";

const useQuery = moduleQuery("recurring_plans");

// ============================================
// RECURRING PLAN QUERIES
// ============================================

export const useAllRecurringPlansQuery = (enabled = true): UseQueryResult<RecurringPlan[], Error> => {
	return useQuery({
		queryKey: ["recurringPlans"],
		queryFn: recurringPlanApi.getAllRecurringPlans,
		enabled,
	});
};

export const useRecurringPlanByIdQuery = (planId: string): UseQueryResult<RecurringPlan, Error> => {
	return useQuery({
		queryKey: ["recurringPlans", planId],
		queryFn: () => recurringPlanApi.getRecurringPlanById(planId),
		enabled: !!planId,
	});
};

export const useRecurringPlanByJobIdQuery = (
	jobId: string
): UseQueryResult<RecurringPlan, Error> => {
	return useQuery({
		queryKey: ["jobs", jobId, "recurringPlan"],
		queryFn: () => recurringPlanApi.getRecurringPlanByJobId(jobId),
		enabled: !!jobId,
	});
};

// ============================================
// RECURRING PLAN MUTATIONS
// ============================================

export const useCreateRecurringPlanMutation = (): UseMutationResult<
	RecurringPlan,
	Error,
	CreateRecurringPlanInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: recurringPlanApi.createRecurringPlan,
		onSuccess: async (newPlan: RecurringPlan) => {
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });

			await queryClient.invalidateQueries({
				queryKey: ["clients", newPlan.client_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["clients"] });

			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			if (newPlan.job_container?.id) {
				queryClient.setQueryData(
					["jobs", newPlan.job_container.id, "recurringPlan"],
					newPlan
				);
			}

			// Set the plan by its own ID in cache
			queryClient.setQueryData(["recurringPlans", newPlan.id], newPlan);
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
	});
};

export const useUpdateRecurringPlanMutation = (): UseMutationResult<
	RecurringPlan,
	Error,
	{ jobId: string; updates: UpdateRecurringPlanInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, updates }) =>
			recurringPlanApi.updateRecurringPlan(jobId, updates),
		onSuccess: async (updatedPlan, variables) => {
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });

			await queryClient.invalidateQueries({
				queryKey: ["clients", updatedPlan.client_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["clients"] });

			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			// If rule or line_items were updated, invalidate  related occurrences
			if (variables.updates.rule || variables.updates.line_items) {
				await queryClient.invalidateQueries({
					queryKey: ["jobs", variables.jobId, "occurrences"],
				});
			}

			// Update the specific recurring plan in cache
			queryClient.setQueryData(
				["jobs", variables.jobId, "recurringPlan"],
				updatedPlan
			);

			// Also update by plan ID
			queryClient.setQueryData(["recurringPlans", updatedPlan.id], updatedPlan);
		},
	});
};

export const useUpdateRecurringPlanLineItemsMutation = (): UseMutationResult<
	RecurringPlan,
	Error,
	{ jobId: string; updates: UpdateRecurringPlanLineItemsInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, updates }) =>
			recurringPlanApi.updateRecurringPlanLineItems(jobId, updates),
		onSuccess: async (updatedPlan, variables) => {
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });

			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "occurrences"],
			});

			// Update the specific recurring plan in cache
			queryClient.setQueryData(
				["jobs", variables.jobId, "recurringPlan"],
				updatedPlan
			);

			// Also update by plan ID
			queryClient.setQueryData(["recurringPlans", updatedPlan.id], updatedPlan);
		},
	});
};

// ============================================
// RECURRING PLAN LIFECYCLE MUTATIONS
// ============================================

export const usePauseRecurringPlanMutation = (): UseMutationResult<
	RecurringPlan,
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: recurringPlanApi.pauseRecurringPlan,
		onSuccess: async (updatedPlan, jobId) => {
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });

			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			queryClient.setQueryData(["jobs", jobId, "recurringPlan"], updatedPlan);
			queryClient.setQueryData(["recurringPlans", updatedPlan.id], updatedPlan);
		},
	});
};

export const useResumeRecurringPlanMutation = (): UseMutationResult<
	RecurringPlan,
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: recurringPlanApi.resumeRecurringPlan,
		onSuccess: async (updatedPlan, jobId) => {
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });

			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			queryClient.setQueryData(["jobs", jobId, "recurringPlan"], updatedPlan);
			queryClient.setQueryData(["recurringPlans", updatedPlan.id], updatedPlan);
		},
	});
};

export const useCancelRecurringPlanMutation = (): UseMutationResult<
	RecurringPlan,
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: recurringPlanApi.cancelRecurringPlan,
		onSuccess: async (updatedPlan, jobId) => {
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });

			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			await queryClient.invalidateQueries({
				queryKey: ["jobs", jobId, "occurrences"],
			});

			queryClient.setQueryData(["jobs", jobId, "recurringPlan"], updatedPlan);
			queryClient.setQueryData(["recurringPlans", updatedPlan.id], updatedPlan);
		},
	});
};

export const useCompleteRecurringPlanMutation = (): UseMutationResult<
	RecurringPlan,
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: recurringPlanApi.completeRecurringPlan,
		onSuccess: async (updatedPlan, jobId) => {
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });

			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			queryClient.setQueryData(["jobs", jobId, "recurringPlan"], updatedPlan);
			queryClient.setQueryData(["recurringPlans", updatedPlan.id], updatedPlan);
		},
	});
};

// ============================================
// OCCURRENCE QUERIES
// ============================================

export const useOccurrencesByJobIdQuery = (
	jobId: string
): UseQueryResult<RecurringOccurrence[], Error> => {
	return useQuery({
		queryKey: ["jobs", jobId, "occurrences"],
		queryFn: () => recurringPlanApi.getOccurrencesByJobId(jobId),
		enabled: !!jobId,
	});
};

// ============================================
// OCCURRENCE MUTATIONS
// ============================================

export const useGenerateOccurrencesMutation = (): UseMutationResult<
	OccurrenceGenerationResult,
	Error,
	{ jobId: string; input: GenerateOccurrencesInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, input }) =>
			recurringPlanApi.generateOccurrences(jobId, input),
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "occurrences"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "recurringPlan"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["recurringPlans"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs"],
			});
		},
	});
};

export const useSkipOccurrenceMutation = (): UseMutationResult<
	RecurringOccurrence,
	Error,
	{ occurrenceId: string; jobId: string; input: SkipOccurrenceInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ occurrenceId, input }) =>
			recurringPlanApi.skipOccurrence(occurrenceId, input),
		onSuccess: async (_, variables) => {
			const { jobId } = variables;

			await queryClient.invalidateQueries({
				queryKey: ["jobs", jobId, "occurrences"],
			});

			await queryClient.invalidateQueries({
				queryKey: ["jobs", jobId, "recurringPlan"],
			});

			await queryClient.invalidateQueries({
				queryKey: ["recurringPlans"],
			});

			await queryClient.invalidateQueries({
				queryKey: ["jobs"],
			});
		},
		onError: (error) => {
			console.error("Skip occurrence mutation error:", error);
		},
	});
};

export const useRescheduleOccurrenceMutation = (): UseMutationResult<
	RecurringOccurrence,
	Error,
	{ occurrenceId: string; jobId: string; input: RescheduleOccurrenceInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ occurrenceId, input }) =>
			recurringPlanApi.rescheduleOccurrence(occurrenceId, input),
		onSuccess: async (updatedOccurrence, variables) => {
			const { jobId } = variables;

			// Immediately patch the jobs cache so the card appears on the new date
			// without waiting for the network refetch to complete.
			queryClient.setQueriesData<Job[]>({ queryKey: ["jobs"] }, (old) => {
				if (!old) return old;
				return old.map((job) => {
					if (job.id !== jobId) return job;
					const plan = job.recurring_plan;
					if (!plan?.occurrences) return job;
					const updatedOccs = plan.occurrences.map((occ) =>
						occ.id === updatedOccurrence.id ? { ...occ, ...updatedOccurrence } : occ
					);
					return { ...job, recurring_plan: { ...plan, occurrences: updatedOccs } };
				});
			});

			await queryClient.invalidateQueries({
				queryKey: ["jobs", jobId, "occurrences"],
			});

			await queryClient.invalidateQueries({
				queryKey: ["jobs", jobId, "recurringPlan"],
			});

			await queryClient.invalidateQueries({
				queryKey: ["recurringPlans"],
			});

			await queryClient.invalidateQueries({
				queryKey: ["jobs"],
			});
		},
		onError: (error) => {
			console.error("Reschedule occurrence mutation error:", error);
		},
	});
};

export const useBulkSkipOccurrencesMutation = (): UseMutationResult<
	{ skipped: number },
	Error,
	BulkSkipOccurrencesInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: recurringPlanApi.bulkSkipOccurrences,
		onSuccess: async () => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs"],
				predicate: (query) => query.queryKey.includes("occurrences"),
			});
			await queryClient.invalidateQueries({ queryKey: ["recurringPlans"] });
		},
		onError: (error) => {
			console.error("Bulk skip occurrences mutation error:", error);
		},
	});
};

export const useGenerateVisitFromOccurrenceMutation = (): UseMutationResult<
	VisitGenerationResult,
	Error,
	{ occurrenceId: string; jobId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ occurrenceId }) =>
			recurringPlanApi.generateVisitFromOccurrence(occurrenceId),
		onSuccess: async (result, variables) => {
			const { jobId } = variables;

			await queryClient.invalidateQueries({
				queryKey: ["jobs", jobId, "occurrences"],
			});

			await queryClient.invalidateQueries({
				queryKey: ["jobs", jobId, "visits"],
			});

			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });

			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			if (result.visit_id) {
				await queryClient.invalidateQueries({
					queryKey: ["jobVisits", result.visit_id],
				});
			}
		},
		onError: (error) => {
			console.error("Generate visit mutation error:", error);
		},
	});
};

// ============================================
// RECURRING PLAN NOTE QUERIES
// ============================================

export const useRecurringPlanNotesQuery = (
	jobId: string
): UseQueryResult<RecurringPlanNote[], Error> => {
	return useQuery({
		queryKey: ["jobs", jobId, "recurringPlan", "notes"],
		queryFn: () => recurringPlanApi.getRecurringPlanNotes(jobId),
		enabled: !!jobId,
	});
};

// ============================================
// RECURRING PLAN NOTE MUTATIONS
// ============================================

export const useCreateRecurringPlanNoteMutation = (): UseMutationResult<
	RecurringPlanNote,
	Error,
	{ jobId: string; data: CreateRecurringPlanNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, data }) =>
			recurringPlanApi.createRecurringPlanNote(jobId, data),
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "recurringPlan", "notes"],
			});
		},
	});
};

export const useUpdateRecurringPlanNoteMutation = (): UseMutationResult<
	RecurringPlanNote,
	Error,
	{ jobId: string; noteId: string; data: UpdateRecurringPlanNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, noteId, data }) =>
			recurringPlanApi.updateRecurringPlanNote(jobId, noteId, data),
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "recurringPlan", "notes"],
			});
		},
	});
};

export const useDeleteRecurringPlanNoteMutation = (): UseMutationResult<
	{ message: string },
	Error,
	{ jobId: string; noteId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, noteId }) =>
			recurringPlanApi.deleteRecurringPlanNote(jobId, noteId),
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "recurringPlan", "notes"],
			});
		},
	});
};

export const useSkippedDatesQuery = (jobId: string | undefined) =>
	useQuery({
		queryKey: ["recurringPlans", "skippedDates", jobId],
		queryFn: () => recurringPlanApi.getSkippedDates(jobId as string),
		enabled: !!jobId,
		staleTime: 5 * 60_000,
	});

export const useRecurringTaxEstimateQuery = (
	input: RecurringTaxEstimateInput | null
): UseQueryResult<TaxEstimate, Error> =>
	useQuery({
		queryKey: ["recurringTaxEstimate", input],
		queryFn: () => recurringPlanApi.getRecurringTaxEstimate(input as RecurringTaxEstimateInput),
		enabled: !!input,
		// Keep the last figure while retyping lines, never across a client/address change or a cleared input.
		placeholderData: (prev, prevQuery) => {
			const before = prevQuery?.queryKey[1] as RecurringTaxEstimateInput | null | undefined;
			if (!input || !before) return undefined;
			return before.client_id === input.client_id && before.address === input.address
				? prev
				: undefined;
		},
	});

const DEBOUNCE_MS = 300;

/** Builds the estimate input from editor state; null (query disabled) without client or address. */
export function useDebouncedRecurringTaxEstimate(
	parts: {
		clientId: string;
		address: string | undefined;
		coords?: RecurringTaxEstimateInput["coords"];
		lineItems: { quantity: number; unit_price: number; taxable?: boolean; tax_group_id?: string | null }[];
		planId?: string;
	}
): UseQueryResult<TaxEstimate, Error> {
	const { clientId, address, coords, lineItems, planId } = parts;
	const built = useMemo<RecurringTaxEstimateInput | null>(() => {
		if (!clientId.trim() || !address?.trim()) return null;
		return {
			client_id: clientId.trim(),
			address,
			coords: coords ?? null,
			line_items: lineItems
				.filter((li) => Number(li.quantity) > 0)
				.map((li) => ({
					quantity: Number(li.quantity) || 0,
					unit_price: Number(li.unit_price) || 0,
					taxable: li.taxable ?? true,
					tax_group_id: li.tax_group_id ?? null,
				})),
			...(planId ? { plan_id: planId } : {}),
		};
	}, [clientId, address, coords, lineItems, planId]);
	const key = JSON.stringify(built);
	const [debounced, setDebounced] = useState(built);
	useEffect(() => {
		const t = setTimeout(() => setDebounced(built), DEBOUNCE_MS);
		return () => clearTimeout(t);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	const settled =
		built && debounced && debounced.client_id === built.client_id && debounced.address === built.address
			? debounced
			: null;
	return useRecurringTaxEstimateQuery(settled);
}
