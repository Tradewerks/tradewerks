import axios, { isAxiosError } from "axios";
import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { BoardResponse, BoardVisit } from "../types/board";
import { conflictFromResponse } from "../lib/apiErrors";
import type {
	CreateJobInput,
	UpdateJobInput,
	Job,
	CreateJobNoteInput,
	JobNote,
	UpdateJobNoteInput,
	JobVisit,
	CreateJobVisitInput,
	UpdateJobVisitInput,
	ClockInResult,
	ClockOutResult,
	VisitStatusEvent,
} from "../types/jobs";
import type { ListParams, PagedResult } from "../types/paging";
import { pagedResultFrom } from "../hooks/usePagedList";


// ============================================
// JOB API
// ============================================

// legacy-list: CreateInvoice links a client's jobs with their visits and line items,
// which the slim paged shape omits.
export const getAllJobs = async (clientId?: string): Promise<Job[]> => {
	const response = await api.get<ApiResponse<Job[]>>("/jobs", {
		params: clientId ? { client_id: clientId } : undefined,
	});
	return response.data.data || [];
};

// The server's slim list row: no description, coords, visit techs or line items.
export type JobListRow = Pick<
	Job,
	| "id"
	| "job_number"
	| "name"
	| "status"
	| "priority"
	| "address"
	| "client_id"
	| "recurring_plan_id"
	| "estimated_total"
	| "actual_total"
	| "created_at"
	| "completed_at"
> & {
	client?: { id: string; name: string };
	project?: { id: string; project_number: string; name: string } | null;
	_count?: { visits: number };
	// The next open visit, at most one.
	visits?: { id: string; scheduled_start_at: Date | string; status: string }[];
};

export interface JobListExtras {
	priority?: string[];
	client_id?: string;
	unattached?: boolean;
}

export const getJobsPage = async (
	params: ListParams,
	extras: JobListExtras = {}
): Promise<PagedResult<JobListRow>> => {
	const response = await api.get<ApiResponse<JobListRow[]>>("/jobs", {
		params: {
			...params,
			status: params.status?.join(","),
			priority: extras.priority?.join(","),
			client_id: extras.client_id,
			unattached: extras.unattached ? "true" : undefined,
		},
	});
	return pagedResultFrom(response.data, params);
};

export const getJobById = async (id: string): Promise<Job> => {
	if (!id) {
		throw new Error("Job ID is required");
	}

	const response = await api.get<ApiResponse<Job>>(`/jobs/${id}`);

	if (!response.data.data) {
		throw new Error("Job not found");
	}

	return response.data.data;
};

export const createJob = async (input: CreateJobInput): Promise<Job> => {
	const response = await api.post<ApiResponse<Job>>("/jobs", input);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create job");
	}

	return response.data.data!;
};

export const updateJob = async (id: string, updates: UpdateJobInput): Promise<Job> => {
	const response = await api.patch<ApiResponse<Job>>(`/jobs/${id}`, updates);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update job");
	}

	return response.data.data!;
};

export const deleteJob = async (id: string): Promise<{ message: string; id: string }> => {
	try {
		const response = await api.delete<ApiResponse<{ message: string; id: string }>>(
			`/jobs/${id}`
		);

		return response.data.data || { message: "Job deleted successfully", id };
	} catch (err) {
		throw new Error((isAxiosError(err) && err.response?.data?.error?.message) || "Failed to delete job");
	}
};

/** One request cancels the job and every open visit in a single transaction. */
export const cancelJob = async (jobId: string, reason: string): Promise<Job> => {
	const response = await api.post<ApiResponse<Job>>(`/jobs/${jobId}/cancel`, { reason });

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to cancel job");
	}

	return response.data.data!;
};

// ============================================
// JOB VISIT API
// ============================================

/** One page of the org-wide visit list, in the board's slim shape (no line items). */
export const listJobVisits = async (params: ListParams): Promise<PagedResult<BoardVisit>> => {
	const response = await api.get<ApiResponse<BoardVisit[]>>("/job-visits", {
		params: { ...params, status: params.status?.join(",") },
	});
	return pagedResultFrom(response.data, params);
};

/** One row per job the caller is on, carrying the visit a charge would land on. */
export interface MyJobOption {
	job_id: string;
	job_name: string | null;
	job_number: string | null;
	visit_id: string;
	visit_name: string | null;
	scheduled_start_at: string | null;
}

/**
 * The technician's own work, thin: the org-wide visit list carries client, line
 * items and time entries, far too much to send a phone to populate one dropdown.
 */
export const getMyJobs = async (): Promise<MyJobOption[]> => {
	const response = await api.get<ApiResponse<MyJobOption[]>>("/job-visits/mine");
	return response.data.data || [];
};

// legacy-list: the history card reads notes, which the slim paged shape omits.
// The legacy array is oldest first, so newest-first and the cap happen here.
export const getClientVisitHistory = async (clientId: string, limit = 5): Promise<JobVisit[]> => {
	const response = await api.get<ApiResponse<JobVisit[]>>("/job-visits", {
		params: { clientId },
	});
	return (response.data.data || [])
		.sort((a, b) => new Date(b.scheduled_start_at).getTime() - new Date(a.scheduled_start_at).getTime())
		.slice(0, limit);
};

/**
 * The phone's visit list: the caller's own visits (with their pricing, notes and
 * time) plus, for a caller who can accept, the unclaimed pool without pricing.
 * The server picks the window (org-local yesterday through 14 days out) unless
 * one is passed.
 */
export const getAssignedVisits = async (
	range?: { from: string; to: string },
	opts: { own?: boolean } = {},
): Promise<JobVisit[]> => {
	const response = await api.get<ApiResponse<JobVisit[]>>("/job-visits/assigned", {
		params: { ...range, ...(opts.own && { own: "1" }) },
	});
	return response.data.data || [];
};

/** The Past tab: the caller's closed visits plus open ones that ended before the Mine window; newest first. */
export const getAssignedPastVisits = async (params: {
	page: number;
	limit: number;
}): Promise<PagedResult<JobVisit>> => {
	const response = await api.get<ApiResponse<JobVisit[]>>("/job-visits/assigned", {
		params: { scope: "past", ...params },
	});
	return pagedResultFrom(response.data, params);
};

export const getJobVisitById = async (id: string): Promise<JobVisit> => {
	const response = await api.get<ApiResponse<JobVisit>>(`/job-visits/${id}`);

	if (!response.data.data) {
		throw new Error("Job visit not found");
	}

	return response.data.data;
};

export const getJobVisitsByJobId = async (jobId: string): Promise<JobVisit[]> => {
	const response = await api.get<ApiResponse<JobVisit[]>>(`/jobs/${jobId}/visits`);
	return response.data.data || [];
};

export const getJobVisitsByTechId = async (techId: string): Promise<JobVisit[]> => {
	const response = await api.get<ApiResponse<JobVisit[]>>(`/technicians/${techId}/visits`);
	return response.data.data || [];
};

export const getBoard = async (
	from: Date,
	to: Date,
	opts?: { includeUnscheduled?: boolean },
): Promise<BoardResponse> => {
	const response = await api.get<ApiResponse<BoardResponse>>("/job-visits/board", {
		params: {
			from: from.toISOString(),
			to: to.toISOString(),
			...(opts?.includeUnscheduled ? { includeUnscheduled: 1 } : {}),
		},
	});
	return response.data.data ?? { visits: [], occurrences: [] };
};

export const createJobVisit = async (input: CreateJobVisitInput): Promise<JobVisit> => {
	const response = await api.post<ApiResponse<JobVisit>>("/job-visits", input);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create job visit");
	}

	return response.data.data!;
};

export const updateJobVisit = async (
	id: string,
	updates: UpdateJobVisitInput
): Promise<JobVisit> => {
	let response;
	try {
		response = await api.put<ApiResponse<JobVisit>>(`/job-visits/${id}`, updates);
	} catch (err) {
		throw conflictFromResponse(err) ?? err;
	}

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update job visit");
	}

	return response.data.data!;
};

// The technician's only line write: quantity only, priced server-side. 0 deletes the line.
export const updateFieldLineQuantity = async (
	visitId: string,
	lineItemId: string,
	quantity: number
): Promise<JobVisit> => {
	const response = await api.patch<ApiResponse<JobVisit>>(
		`/job-visits/${visitId}/field-lines/${lineItemId}`,
		{ quantity }
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update line quantity");
	}

	return response.data.data!;
};

export const assignTechniciansToVisit = async (
	visitId: string,
	techIds: string[]
): Promise<JobVisit> => {
	const response = await api.put<ApiResponse<JobVisit>>(
		`/job-visits/${visitId}/technicians`,
		{ tech_ids: techIds }
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to assign technicians to visit"
		);
	}

	return response.data.data!;
};

export const patchVisitTechnicians = async (
	visitId: string,
	diff: { add?: string[]; remove?: string[] }
): Promise<JobVisit> => {
	const response = await api.patch<ApiResponse<JobVisit>>(
		`/job-visits/${visitId}/technicians`,
		diff
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update the visit's technicians");
	}

	return response.data.data!;
};

export const acceptJobVisit = async (visitId: string, techId: string): Promise<JobVisit> => {
	const response = await api.post<ApiResponse<JobVisit>>(`/job-visits/${visitId}/accept`, { tech_id: techId });

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to accept visit");
	}

	return response.data.data!;
};

export const deleteJobVisit = async (id: string): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(`/job-visits/${id}`);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete job visit");
	}

	return response.data.data || { message: "Job visit deleted successfully" };
};

// ============================================
// JOB VISIT LIFECYCLE API
// ============================================
export const transitionJobVisit = async (visitId: string,action: import("../types/jobs").LifecycleAction,pauseReason?: string,techCoords?: { lat: number; lon: number },): Promise<JobVisit> => {
	const response = await api.post<ApiResponse<JobVisit>>(`/job-visits/${visitId}/transition`, {
		action,
		...(pauseReason ? { pause_reason: pauseReason } : {}),
		...(techCoords ? { tech_coords: techCoords } : {}),
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update visit");
	}

	return response.data.data!;
};

export const cancelJobVisit = async (visitId: string, cancellationReason: string): Promise<JobVisit> => {
	const response = await api.post<ApiResponse<JobVisit>>(`/job-visits/${visitId}/cancel`, {
		cancellation_reason: cancellationReason,
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to cancel visit");
	}

	return response.data.data!;
};

export const delayJobVisit = async (visitId: string): Promise<JobVisit> => {
	const response = await api.post<ApiResponse<JobVisit>>(`/job-visits/${visitId}/delay`);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delay visit");
	}

	return response.data.data!;
};

// ============================================
// TIME TRACKING API
// ============================================

export const clockInVisit = async (visitId: string, techId: string): Promise<ClockInResult> => {
	try {
		const response = await api.post<ApiResponse<ClockInResult>>(
			`/job-visits/${visitId}/clock-in`,
			{ tech_id: techId },
		);
		if (!response.data.success) {
			throw new Error(response.data.error?.message || "Failed to clock in");
		}
		return response.data.data!;
	} catch (err) {
		if (axios.isAxiosError(err) && err.response?.data?.error?.message) {
			throw new Error(err.response.data.error.message);
		}
		throw err;
	}
};

export const clockOutVisit = async (visitId: string, techId: string, pauseReason?: string): Promise<ClockOutResult> => {
	const response = await api.post<ApiResponse<ClockOutResult>>(
		`/job-visits/${visitId}/clock-out`,
		{ tech_id: techId, ...(pauseReason ? { pause_reason: pauseReason } : {}) },
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to clock out");
	}
	return response.data.data!;
};

// ============================================
// JOB NOTES API
// ============================================

export const getJobNotes = async (jobId: string): Promise<JobNote[]> => {
	const response = await api.get<ApiResponse<JobNote[]>>(`/jobs/${jobId}/notes`);
	return response.data.data || [];
};

export const createJobNote = async (jobId: string, data: CreateJobNoteInput): Promise<JobNote> => {
	const response = await api.post<ApiResponse<JobNote>>(`/jobs/${jobId}/notes`, data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create job note");
	}

	return response.data.data!;
};

export const updateJobNote = async (
	jobId: string,
	noteId: string,
	data: UpdateJobNoteInput
): Promise<JobNote> => {
	const response = await api.put<ApiResponse<JobNote>>(
		`/jobs/${jobId}/notes/${noteId}`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update job note");
	}

	return response.data.data!;
};

export const deleteJobNote = async (
	jobId: string,
	noteId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/jobs/${jobId}/notes/${noteId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete job note");
	}

	return response.data.data || { message: "Job note deleted successfully" };
};

export const uploadNotePhoto = async (jobId: string, file: File): Promise<{ url: string, raw_url: string }> => {
	const formData = new FormData();
	formData.append("photo", file);
	const response = await api.post<ApiResponse<{ url: string, raw_url: string }>>(
		`/jobs/${jobId}/notes/upload-photo`,
		formData,
		{ headers: { "Content-Type": "multipart/form-data" } },
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Upload failed");
	}
	return response.data.data!;
};

export const fetchRecentStatusEvents = async (): Promise<VisitStatusEvent[]> => {
	const response = await api.get<ApiResponse<VisitStatusEvent[]>>("/job-visits/recent-status-events");
	return response.data.data ?? [];
};
