import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
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


// ============================================
// RECURRING PLAN API
// ============================================

export const getAllRecurringPlans = async (): Promise<RecurringPlan[]> => {
	const response = await api.get<ApiResponse<RecurringPlan[]>>("/recurring-plans");
	return response.data.data || [];
};

// NEW: Get recurring plan by its own ID
export const getRecurringPlanById = async (planId: string): Promise<RecurringPlan> => {
	if (!planId) {
		throw new Error("Plan ID is required");
	}

	const response = await api.get<ApiResponse<RecurringPlan>>(`/recurring-plans/${planId}`);

	if (!response.data.data) {
		throw new Error("Recurring plan not found");
	}

	return response.data.data;
};

export const getRecurringPlanByJobId = async (jobId: string): Promise<RecurringPlan> => {
	if (!jobId) {
		throw new Error("Job ID is required");
	}

	const response = await api.get<ApiResponse<RecurringPlan>>(`/jobs/${jobId}/recurring-plan`);

	if (!response.data.data) {
		throw new Error("Recurring plan not found");
	}

	return response.data.data;
};

export const createRecurringPlan = async (
	input: CreateRecurringPlanInput
): Promise<RecurringPlan> => {
	const response = await api.post<ApiResponse<RecurringPlan>>("/recurring-plans", input);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create recurring plan");
	}

	return response.data.data!;
};

export const updateRecurringPlan = async (
	jobId: string,
	updates: UpdateRecurringPlanInput
): Promise<RecurringPlan> => {
	const response = await api.put<ApiResponse<RecurringPlan>>(
		`/jobs/${jobId}/recurring-plan`,
		updates
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update recurring plan");
	}

	return response.data.data!;
};

export const updateRecurringPlanLineItems = async (
	jobId: string,
	updates: UpdateRecurringPlanLineItemsInput
): Promise<RecurringPlan> => {
	const response = await api.put<ApiResponse<RecurringPlan>>(
		`/jobs/${jobId}/recurring-plan/template`,
		updates
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to update recurring plan template"
		);
	}

	return response.data.data!;
};

// ============================================
// RECURRING PLAN LIFECYCLE API
// ============================================

export const pauseRecurringPlan = async (jobId: string): Promise<RecurringPlan> => {
	const response = await api.post<ApiResponse<RecurringPlan>>(
		`/jobs/${jobId}/recurring-plan/pause`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to pause recurring plan");
	}

	return response.data.data!;
};

export const resumeRecurringPlan = async (jobId: string): Promise<RecurringPlan> => {
	const response = await api.post<ApiResponse<RecurringPlan>>(
		`/jobs/${jobId}/recurring-plan/resume`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to resume recurring plan");
	}

	return response.data.data!;
};

export const cancelRecurringPlan = async (jobId: string): Promise<RecurringPlan> => {
	const response = await api.post<ApiResponse<RecurringPlan>>(
		`/jobs/${jobId}/recurring-plan/cancel`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to cancel recurring plan");
	}

	return response.data.data!;
};

export const completeRecurringPlan = async (jobId: string): Promise<RecurringPlan> => {
	const response = await api.post<ApiResponse<RecurringPlan>>(
		`/jobs/${jobId}/recurring-plan/complete`
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to complete recurring plan"
		);
	}

	return response.data.data!;
};

// ============================================
// OCCURRENCE API
// ============================================

export const getOccurrencesByJobId = async (jobId: string): Promise<RecurringOccurrence[]> => {
	const response = await api.get<ApiResponse<RecurringOccurrence[]>>(
		`/jobs/${jobId}/occurrences`
	);
	return response.data.data || [];
};

export const generateOccurrences = async (
	jobId: string,
	input: GenerateOccurrencesInput
): Promise<OccurrenceGenerationResult> => {
	const response = await api.post<ApiResponse<OccurrenceGenerationResult>>(
		`/jobs/${jobId}/occurrences/generate`,
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to generate occurrences");
	}

	return response.data.data!;
};

export const skipOccurrence = async (
	occurrenceId: string,
	input: SkipOccurrenceInput
): Promise<RecurringOccurrence> => {
	const response = await api.post<ApiResponse<RecurringOccurrence>>(
		`/occurrences/${occurrenceId}/skip`,
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to skip occurrence");
	}

	return response.data.data!;
};

export const rescheduleOccurrence = async (
	occurrenceId: string,
	input: RescheduleOccurrenceInput
): Promise<RecurringOccurrence> => {
	const response = await api.put<ApiResponse<RecurringOccurrence>>(
		`/occurrences/${occurrenceId}/reschedule`,
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to reschedule occurrence");
	}

	return response.data.data!;
};

export const bulkSkipOccurrences = async (
	input: BulkSkipOccurrencesInput
): Promise<{ skipped: number }> => {
	const response = await api.post<ApiResponse<{ skipped: number }>>(
		"/occurrences/bulk-skip",
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to bulk skip occurrences");
	}

	return response.data.data!;
};

export const generateVisitFromOccurrence = async (
	occurrenceId: string
): Promise<VisitGenerationResult> => {
	const response = await api.post<ApiResponse<VisitGenerationResult>>(
		`/occurrences/${occurrenceId}/generate-visit`
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to generate visit from occurrence"
		);
	}

	return response.data.data!;
};

// ============================================
// RECURRING PLAN NOTES API
// ============================================

export const getRecurringPlanNotes = async (jobId: string): Promise<RecurringPlanNote[]> => {
	const response = await api.get<ApiResponse<RecurringPlanNote[]>>(
		`/jobs/${jobId}/recurring-plan/notes`
	);
	return response.data.data || [];
};

export const createRecurringPlanNote = async (
	jobId: string,
	data: CreateRecurringPlanNoteInput
): Promise<RecurringPlanNote> => {
	const response = await api.post<ApiResponse<RecurringPlanNote>>(
		`/jobs/${jobId}/recurring-plan/notes`,
		data
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to create recurring plan note"
		);
	}

	return response.data.data!;
};

export const updateRecurringPlanNote = async (
	jobId: string,
	noteId: string,
	data: UpdateRecurringPlanNoteInput
): Promise<RecurringPlanNote> => {
	const response = await api.put<ApiResponse<RecurringPlanNote>>(
		`/jobs/${jobId}/recurring-plan/notes/${noteId}`,
		data
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to update recurring plan note"
		);
	}

	return response.data.data!;
};

export const deleteRecurringPlanNote = async (
	jobId: string,
	noteId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/jobs/${jobId}/recurring-plan/notes/${noteId}`
	);

	if (!response.data.success) {
		throw new Error(
			response.data.error?.message || "Failed to delete recurring plan note"
		);
	}

	return response.data.data || { message: "Recurring plan note deleted successfully" };
};

export const getSkippedDates = async (jobId: string): Promise<string[]> =>
	(await api.get(`/jobs/${jobId}/recurring-plan/skipped-dates`)).data.data.dates;

export const getRecurringTaxEstimate = async (
	input: RecurringTaxEstimateInput
): Promise<TaxEstimate> => {
	const response = await api.post<ApiResponse<TaxEstimate>>(
		"/recurring-plans/tax-estimate",
		input
	);
	if (!response.data.data) {
		throw new Error("Tax estimate unavailable");
	}
	return response.data.data;
};
