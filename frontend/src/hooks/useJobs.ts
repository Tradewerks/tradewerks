import { useCallback } from "react";
import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
import type {
	CreateJobInput,
	UpdateJobInput,
	Job,
	JobNote,
	CreateJobNoteInput,
	UpdateJobNoteInput,
	JobVisit,
	CreateJobVisitInput,
	UpdateJobVisitInput,
	LifecycleAction,
	ClockInResult,
	ClockOutResult,
} from "../types/jobs";
import * as jobApi from "../api/jobs";
import type { MyJobOption } from "../api/jobs";
import { qk } from "../lib/queryKeys";

// ============================================
// JOB QUERIES
// ============================================

export const useAllJobsQuery = (): UseQueryResult<Job[], Error> => {
	return useQuery({
		queryKey: ["jobs"],
		queryFn: jobApi.getAllJobs,
	});
};

export const useJobByIdQuery = (
	id: string,
	options?: { retry?: boolean }
): UseQueryResult<Job, Error> => {
	return useQuery({
		queryKey: ["jobs", id],
		queryFn: () => jobApi.getJobById(id),
		enabled: !!id,
		...(options?.retry !== undefined ? { retry: options.retry } : {}),
	});
};

// ============================================
// JOB MUTATIONS
// ============================================

export const useCreateJobMutation = (): UseMutationResult<Job, Error, CreateJobInput> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: jobApi.createJob,
		onSuccess: (newJob: Job) => {
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });

			void queryClient.invalidateQueries({
				queryKey: ["clients", newJob.client_id],
			});
			void queryClient.invalidateQueries({ queryKey: ["clients"] });

			if (newJob.request_id) {
				void queryClient.invalidateQueries({
					queryKey: ["requests", newJob.request_id],
				});
				void queryClient.invalidateQueries({
					queryKey: ["requests"],
				});
			}

			if (newJob.quote_id) {
				void queryClient.invalidateQueries({
					queryKey: ["quotes", newJob.quote_id],
				});
				void queryClient.invalidateQueries({
					queryKey: ["quotes"],
				});
				// Selling one quote closes Revise & Resend on its siblings, and
				// those outcomes arrive with each sibling's disputes.
				void queryClient.invalidateQueries({ queryKey: ["disputes"] });
			}

			queryClient.setQueryData(["jobs", newJob.id], newJob);
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useUpdateJobMutation = (): UseMutationResult<
	Job,
	Error,
	{ id: string; updates: UpdateJobInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, updates }) => jobApi.updateJob(id, updates),
		onSuccess: (updatedJob, variables) => {
			// Covers the case where a job goes from 0 → 1+ line items and the
			// stale empty-array cache would otherwise win the race.
			queryClient.setQueryData(["jobs", variables.id], updatedJob);
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({
				queryKey: ["clients", updatedJob.client_id],
			});
			// Address edits re-tax the open visits server-side.
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["clients"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useCancelJobMutation = (): UseMutationResult<
	Job,
	Error,
	{ jobId: string; reason: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, reason }) => jobApi.cancelJob(jobId, reason),
		onSuccess: (job, variables) => {
			queryClient.setQueryData(["jobs", variables.jobId], job);
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useDeleteJobMutation = (): UseMutationResult<
	{ message: string; id: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: jobApi.deleteJob,
		onSuccess: (_, jobId) => {
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({ queryKey: ["clients"] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });

			queryClient.removeQueries({ queryKey: ["jobs", jobId] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

// ============================================
// JOB VISIT QUERIES
// ============================================

export const useAllJobVisitsQuery = (): UseQueryResult<JobVisit[], Error> => {
	return useQuery({
		queryKey: ["jobVisits"],
		queryFn: jobApi.getAllJobVisits,
	});
};

/**
 * The caller's own jobs, for pickers. Separate from `useAllJobVisitsQuery`, which
 * pulls the whole organization's visit history and is far too heavy for a phone.
 */
export const useMyJobsQuery = (enabled = true): UseQueryResult<MyJobOption[], Error> => {
	return useQuery({
		queryKey: ["jobVisits", "mine"],
		queryFn: jobApi.getMyJobs,
		enabled,
		staleTime: 60_000,
	});
};

export const useJobVisitByIdQuery = (id: string): UseQueryResult<JobVisit, Error> => {
	return useQuery({
		queryKey: ["jobVisits", id],
		queryFn: () => jobApi.getJobVisitById(id),
		enabled: !!id,
	});
};

export const useJobVisitsByJobIdQuery = (jobId: string): UseQueryResult<JobVisit[], Error> => {
	return useQuery({
		queryKey: ["jobs", jobId, "visits"],
		queryFn: () => jobApi.getJobVisitsByJobId(jobId),
		enabled: !!jobId,
	});
};

export const useJobVisitsByTechIdQuery = (techId: string): UseQueryResult<JobVisit[], Error> => {
	return useQuery({
		queryKey: ["jobVisits", "tech", techId],
		queryFn: () => jobApi.getJobVisitsByTechId(techId),
		enabled: !!techId,
	});
};

export const useClientVisitHistoryQuery = (
	clientId: string | null | undefined,
	limit = 5,
): UseQueryResult<JobVisit[], Error> => {
	return useQuery({
		queryKey: ["clients", clientId, "visit-history", limit],
		queryFn: () => jobApi.getClientVisitHistory(clientId!, limit),
		enabled: !!clientId,
	});
};

export const useJobVisitsByDateRangeQuery = (
	startDate: Date,
	endDate: Date,
	options?: { enabled?: boolean }
): UseQueryResult<JobVisit[], Error> => {
	return useQuery({
		queryKey: [
			"jobVisits",
			"dateRange",
			startDate.toISOString(),
			endDate.toISOString(),
		],
		queryFn: () => jobApi.getJobVisitsByDateRange(startDate, endDate),
		enabled: options?.enabled !== undefined ? options.enabled : true,
	});
};

// ============================================
// JOB VISIT MUTATIONS
// ============================================

export const useCreateJobVisitMutation = (): UseMutationResult<
	JobVisit,
	Error,
	CreateJobVisitInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: jobApi.createJobVisit,
		onSuccess: (newVisit) => {
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({
				queryKey: ["jobs", newVisit.job_id, "visits"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["jobs", newVisit.job_id],
			});
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			if (newVisit.visit_techs && newVisit.visit_techs.length > 0) {
				for (const vt of newVisit.visit_techs) {
					void queryClient.invalidateQueries({
						queryKey: ["jobVisits", "tech", vt.tech_id],
					});
				}
			}

			queryClient.setQueryData(["jobVisits", newVisit.id], newVisit);
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

const refreshAfterVisitWrite = (
	queryClient: ReturnType<typeof useQueryClient>,
	updatedVisit: JobVisit
) => {
	// Set fresh data first to avoid stale-cache race on line_items
	queryClient.setQueryData(qk.visits.detail(updatedVisit.id), updatedVisit);

	void queryClient.invalidateQueries({ queryKey: qk.visits.all });
	void queryClient.invalidateQueries({
		queryKey: [...qk.jobs.detail(updatedVisit.job_id), "visits"],
	});
	void queryClient.invalidateQueries({
		queryKey: qk.jobs.detail(updatedVisit.job_id),
	});
	const jobsList = queryClient.invalidateQueries({ queryKey: qk.jobs.all });
	if (updatedVisit.visit_techs && updatedVisit.visit_techs.length > 0) {
		for (const vt of updatedVisit.visit_techs) {
			void queryClient.invalidateQueries({
				queryKey: ["jobVisits", "tech", vt.tech_id],
			});
		}
	}
	void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
	void queryClient.invalidateQueries({ queryKey: ["changes"] });
	return jobsList;
};

export const useUpdateJobVisitMutation = (): UseMutationResult<
	JobVisit,
	Error,
	{ id: string; data: UpdateJobVisitInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }) => jobApi.updateJobVisit(id, data),
		onSuccess: (updatedVisit) => {
			void refreshAfterVisitWrite(queryClient, updatedVisit);
		},
	});
};

/**
 * After a 409 on a visit save: refetch so the stale copy the user edited is replaced.
 * qk.visits.all covers the visit detail and the board's date-range queries,
 * which live under it until the board moves to qk.board.
 */
export const useReloadConflictedVisit = () => {
	const queryClient = useQueryClient();
	return useCallback(
		async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: qk.visits.all }),
				queryClient.invalidateQueries({ queryKey: qk.board.all }),
				queryClient.invalidateQueries({ queryKey: qk.jobs.all }),
			]);
		},
		[queryClient],
	);
};

export const useUpdateFieldLineQuantityMutation = (): UseMutationResult<
	JobVisit,
	Error,
	{ visitId: string; lineItemId: string; quantity: number }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ visitId, lineItemId, quantity }) =>
			jobApi.updateFieldLineQuantity(visitId, lineItemId, quantity),
		onSuccess: (updatedVisit) => {
			void refreshAfterVisitWrite(queryClient, updatedVisit);
		},
	});
};

export const useAssignTechniciansToVisitMutation = (): UseMutationResult<
	JobVisit,
	Error,
	{ visitId: string; techIds: string[] }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ visitId, techIds }) =>
			jobApi.assignTechniciansToVisit(visitId, techIds),
		onSuccess: (updatedVisit) => {
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id, "visits"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id],
			});
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });

			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const usePatchVisitTechniciansMutation = (): UseMutationResult<
	JobVisit,
	Error,
	{ visitId: string; add?: string[]; remove?: string[] }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ visitId, add, remove }) =>
			jobApi.patchVisitTechnicians(visitId, { add, remove }),
		// Awaited on purpose: the picker closes when this resolves and the card
		// behind it must already show the new roster, not flash the old one.
		onSuccess: async (updatedVisit) => {
			const jobsList = refreshAfterVisitWrite(queryClient, updatedVisit);
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });
			await jobsList;
		},
	});
};

export const useAcceptJobVisitMutation = (): UseMutationResult<
	JobVisit,
	Error,
	{ visitId: string; techId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ visitId, techId }) => jobApi.acceptJobVisit(visitId, techId),
		onSuccess: (updatedVisit) => {
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id, "visits"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id],
			});
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useDeleteJobVisitMutation = (): UseMutationResult<
	{ message: string },
	Error,
	string
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: jobApi.deleteJobVisit,
		onSuccess: (_, visitId) => {
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });
			queryClient.removeQueries({ queryKey: ["jobVisits", visitId] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

// ============================================
// JOB VISIT LIFECYCLE MUTATIONS
// ============================================

export const useVisitTransitionMutation = (): UseMutationResult<JobVisit, Error, { visitId: string; action: LifecycleAction; pauseReason?: string; techCoords?: { lat: number; lon: number } }> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ visitId, action, pauseReason, techCoords }) => jobApi.transitionJobVisit(visitId, action, pauseReason, techCoords),
		onSuccess: (updatedVisit) => {
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			if (updatedVisit.visit_techs?.length > 0) {
				for (const vt of updatedVisit.visit_techs) {
					queryClient.setQueryData<JobVisit[]>(
						["jobVisits", "tech", vt.tech_id],
						(old) => old?.map((v) => (v.id === updatedVisit.id ? updatedVisit : v)),
					);
				}
			}
			queryClient.setQueryData<JobVisit[]>(
				["jobVisits"],
				(old) => old?.map((v) => (v.id === updatedVisit.id ? updatedVisit : v)),
			);
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id, "visits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id] });
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useStartJobVisitMutation = () => {
	const m = useVisitTransitionMutation();
	return { ...m, mutate: (visitId: string) => m.mutate({ visitId, action: "start" }),
		mutateAsync: (visitId: string) => m.mutateAsync({ visitId, action: "start" }) };
};

export const usePauseJobVisitMutation = () => {
	const m = useVisitTransitionMutation();
	return { ...m, mutate: (visitId: string) => m.mutate({ visitId, action: "pause" }),
		mutateAsync: (visitId: string) => m.mutateAsync({ visitId, action: "pause" }) };
};

export const useResumeJobVisitMutation = () => {
	const m = useVisitTransitionMutation();
	return { ...m, mutate: (visitId: string) => m.mutate({ visitId, action: "resume" }),
		mutateAsync: (visitId: string) => m.mutateAsync({ visitId, action: "resume" }) };
};

export const useCompleteJobVisitMutation = () => {
	const m = useVisitTransitionMutation();
	return { ...m, mutate: (visitId: string) => m.mutate({ visitId, action: "complete" }),
		mutateAsync: (visitId: string) => m.mutateAsync({ visitId, action: "complete" }) };
};

export const useDelayJobVisitMutation = (): UseMutationResult<JobVisit, Error, string> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (visitId: string) => jobApi.delayJobVisit(visitId),
		onSuccess: (updatedVisit) => {
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			if (updatedVisit.visit_techs?.length > 0) {
				for (const vt of updatedVisit.visit_techs) {
					queryClient.setQueryData<JobVisit[]>(
						["jobVisits", "tech", vt.tech_id],
						(old) => old?.map((v) => (v.id === updatedVisit.id ? updatedVisit : v)),
					);
				}
			}
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id, "visits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id] });
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useCancelJobVisitMutation = (): UseMutationResult<
	JobVisit,
	Error,
	{ visitId: string; cancellationReason: string }
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ visitId, cancellationReason }) =>
			jobApi.cancelJobVisit(visitId, cancellationReason),
		onSuccess: (updatedVisit) => {
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id, "visits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id] });
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			for (const vt of updatedVisit.visit_techs ?? []) {
				queryClient.setQueryData<JobVisit[]>(
					["jobVisits", "tech", vt.tech_id],
					(old) => old?.map((v) => (v.id === updatedVisit.id ? updatedVisit : v)),
				);
				void queryClient.invalidateQueries({ queryKey: ["technicians", vt.tech_id] });
			}
			void queryClient.invalidateQueries({ queryKey: ["technicians"] });
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

// ============================================
// TIME TRACKING MUTATIONS
// ============================================

export const useClockInMutation = (): UseMutationResult<
	ClockInResult,
	Error,
	{ visitId: string; techId: string }
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ visitId, techId }) => jobApi.clockInVisit(visitId, techId),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits", "tech", variables.techId] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits", variables.visitId] });
		},
	});
};

export const useClockOutMutation = (): UseMutationResult<
	ClockOutResult,
	Error,
	{ visitId: string; techId: string; pauseReason?: string }
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ visitId, techId, pauseReason }) => jobApi.clockOutVisit(visitId, techId, pauseReason),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits", "tech", variables.techId] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits", variables.visitId] });
		},
	});
};

// ============================================
// JOB NOTE QUERIES
// ============================================

export const useJobNotesQuery = (jobId: string): UseQueryResult<JobNote[], Error> => {
	return useQuery({
		queryKey: ["jobs", jobId, "notes"],
		queryFn: () => jobApi.getJobNotes(jobId),
		enabled: !!jobId,
	});
};

// ============================================
// JOB NOTE MUTATIONS
// ============================================

export const useCreateJobNoteMutation = (): UseMutationResult<
	JobNote,
	Error,
	{ jobId: string; data: CreateJobNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, data }: { jobId: string; data: CreateJobNoteInput }) =>
			jobApi.createJobNote(jobId, data),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "notes"],
			});
			if (variables.data.visit_id) {
				void queryClient.invalidateQueries({
					queryKey: ["jobVisits", variables.data.visit_id],
				});
			}
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useUpdateJobNoteMutation = (): UseMutationResult<
	JobNote,
	Error,
	{ jobId: string; noteId: string; data: UpdateJobNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			jobId,
			noteId,
			data,
		}: {
			jobId: string;
			noteId: string;
			data: UpdateJobNoteInput;
		}) => jobApi.updateJobNote(jobId, noteId, data),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "notes"],
			});
			if (variables.data.visit_id) {
				void queryClient.invalidateQueries({
					queryKey: ["jobVisits", variables.data.visit_id],
				});
			}
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useDeleteJobNoteMutation = (): UseMutationResult<
	{ message: string },
	Error,
	{ jobId: string; noteId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ jobId, noteId }: { jobId: string; noteId: string }) =>
			jobApi.deleteJobNote(jobId, noteId),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId],
			});
			void queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "notes"],
			});
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			void queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useUploadNotePhotoMutation = (): UseMutationResult<{ url: string, raw_url: string }, Error, {jobId: string, file: File}> =>
	useMutation({ mutationFn: ({jobId, file}) => jobApi.uploadNotePhoto(jobId, file) });
