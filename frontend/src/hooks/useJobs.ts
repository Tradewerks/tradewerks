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
		onSuccess: async (newJob: Job) => {
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });

			await queryClient.invalidateQueries({
				queryKey: ["clients", newJob.client_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["clients"] });

			if (newJob.request_id) {
				await queryClient.invalidateQueries({
					queryKey: ["requests", newJob.request_id],
				});
				await queryClient.invalidateQueries({
					queryKey: ["requests"],
				});
			}

			if (newJob.quote_id) {
				await queryClient.invalidateQueries({
					queryKey: ["quotes", newJob.quote_id],
				});
				await queryClient.invalidateQueries({
					queryKey: ["quotes"],
				});
				// Selling one quote closes Revise & Resend on its siblings, and
				// those outcomes arrive with each sibling's disputes.
				await queryClient.invalidateQueries({ queryKey: ["disputes"] });
			}

			queryClient.setQueryData(["jobs", newJob.id], newJob);
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (updatedJob, variables) => {
			// Covers the case where a job goes from 0 → 1+ line items and the
			// stale empty-array cache would otherwise win the race.
			queryClient.setQueryData(["jobs", variables.id], updatedJob);
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			await queryClient.invalidateQueries({
				queryKey: ["clients", updatedJob.client_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["clients"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (_, jobId) => {
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			await queryClient.invalidateQueries({ queryKey: ["clients"] });
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["technicians"] });

			queryClient.removeQueries({ queryKey: ["jobs", jobId] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (newVisit) => {
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({
				queryKey: ["jobs", newVisit.job_id, "visits"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", newVisit.job_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			if (newVisit.visit_techs && newVisit.visit_techs.length > 0) {
				for (const vt of newVisit.visit_techs) {
					await queryClient.invalidateQueries({
						queryKey: ["jobVisits", "tech", vt.tech_id],
					});
				}
			}

			queryClient.setQueryData(["jobVisits", newVisit.id], newVisit);
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useUpdateJobVisitMutation = (): UseMutationResult<
	JobVisit,
	Error,
	{ id: string; data: UpdateJobVisitInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }) => jobApi.updateJobVisit(id, data),
		onSuccess: async (updatedVisit) => {
			// Set fresh data first to avoid stale-cache race on line_items
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);

			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id, "visits"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			if (updatedVisit.visit_techs && updatedVisit.visit_techs.length > 0) {
				for (const vt of updatedVisit.visit_techs) {
					await queryClient.invalidateQueries({
						queryKey: ["jobVisits", "tech", vt.tech_id],
					});
				}
			}
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (updatedVisit) => {
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id, "visits"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["technicians"] });

			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (updatedVisit) => {
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id, "visits"],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", updatedVisit.job_id],
			});
			await queryClient.invalidateQueries({ queryKey: ["technicians"] });
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (_, visitId) => {
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			await queryClient.invalidateQueries({ queryKey: ["technicians"] });
			queryClient.removeQueries({ queryKey: ["jobVisits", visitId] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (updatedVisit) => {
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
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id, "visits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id] });
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			await queryClient.invalidateQueries({ queryKey: ["technicians"] });
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (updatedVisit) => {
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			if (updatedVisit.visit_techs?.length > 0) {
				for (const vt of updatedVisit.visit_techs) {
					queryClient.setQueryData<JobVisit[]>(
						["jobVisits", "tech", vt.tech_id],
						(old) => old?.map((v) => (v.id === updatedVisit.id ? updatedVisit : v)),
					);
				}
			}
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id, "visits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id] });
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			await queryClient.invalidateQueries({ queryKey: ["technicians"] });
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (updatedVisit) => {
			queryClient.setQueryData(["jobVisits", updatedVisit.id], updatedVisit);
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id, "visits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobs", updatedVisit.job_id] });
			await queryClient.invalidateQueries({ queryKey: ["jobs"] });
			for (const vt of updatedVisit.visit_techs ?? []) {
				queryClient.setQueryData<JobVisit[]>(
					["jobVisits", "tech", vt.tech_id],
					(old) => old?.map((v) => (v.id === updatedVisit.id ? updatedVisit : v)),
				);
				await queryClient.invalidateQueries({ queryKey: ["technicians", vt.tech_id] });
			}
			await queryClient.invalidateQueries({ queryKey: ["technicians"] });
			await queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobVisits", "tech", variables.techId] });
			await queryClient.invalidateQueries({ queryKey: ["jobVisits", variables.visitId] });
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
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["jobVisits", "tech", variables.techId] });
			await queryClient.invalidateQueries({ queryKey: ["jobVisits", variables.visitId] });
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
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "notes"],
			});
			if (variables.data.visit_id) {
				await queryClient.invalidateQueries({
					queryKey: ["jobVisits", variables.data.visit_id],
				});
			}
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "notes"],
			});
			if (variables.data.visit_id) {
				await queryClient.invalidateQueries({
					queryKey: ["jobVisits", variables.data.visit_id],
				});
			}
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
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
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId],
			});
			await queryClient.invalidateQueries({
				queryKey: ["jobs", variables.jobId, "notes"],
			});
			await queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
			await queryClient.invalidateQueries({ queryKey: ["changes"] });
		},
	});
};

export const useUploadNotePhotoMutation = (): UseMutationResult<{ url: string, raw_url: string }, Error, {jobId: string, file: File}> =>
	useMutation({ mutationFn: ({jobId, file}) => jobApi.uploadNotePhoto(jobId, file) });
