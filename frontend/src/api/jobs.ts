import axios from "axios";
import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
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


// ============================================
// JOB API
// ============================================

export const getAllJobs = async (): Promise<Job[]> => {
	const response = await api.get<ApiResponse<Job[]>>("/jobs");
	return response.data.data || [];
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
	const response = await api.delete<ApiResponse<{ message: string; id: string }>>(
		`/jobs/${id}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete job");
	}

	return response.data.data || { message: "Job deleted successfully", id };
};

// ============================================
// JOB VISIT API
// ============================================

export const getAllJobVisits = async (): Promise<JobVisit[]> => {
	const response = await api.get<ApiResponse<JobVisit[]>>("/job-visits");
	return response.data.data || [];
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
 * The technician's own work, thin. `getAllJobVisits` returns every visit in the org
 * with client, line items and time entries attached - far too much to send a phone
 * to populate one dropdown.
 */
export const getMyJobs = async (): Promise<MyJobOption[]> => {
	const response = await api.get<ApiResponse<MyJobOption[]>>("/job-visits/mine");
	return response.data.data || [];
};

export const getClientVisitHistory = async (clientId: string, limit = 5): Promise<JobVisit[]> => {
	const response = await api.get<ApiResponse<JobVisit[]>>("/job-visits", {
		params: { client_id: clientId, limit, sort: "desc" },
	});
	return response.data.data || [];
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

export const getJobVisitsByDateRange = async (
	startDate: Date,
	endDate: Date
): Promise<JobVisit[]> => {
	const start = startDate.toISOString().split("T")[0]; // YYYY-MM-DD
	const end = endDate.toISOString().split("T")[0];

	const response = await api.get<ApiResponse<JobVisit[]>>(
		`/job-visits/date-range/${start}/${end}`
	);

	return response.data.data || [];
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
	const response = await api.put<ApiResponse<JobVisit>>(`/job-visits/${id}`, updates);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update job visit");
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
