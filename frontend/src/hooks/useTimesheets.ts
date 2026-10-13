import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { acceptCorrection, approveTimesheet, editShift, getTimesheets, getTechnicianWeek, rejectCorrection, reportShiftIssue, unapproveTimesheet } from "../api/timesheet";
import { qk } from "../lib/queryKeys";

const refreshTimesheets = (qc: QueryClient, hoursChanged = false) => {
	qc.invalidateQueries({ queryKey: qk.timesheets.all });
	qc.invalidateQueries({ queryKey: ["changes", "entity", "timesheet"] });
	if (hoursChanged) qc.invalidateQueries({ queryKey: ["reports", "timesheets"] });
};

// No date = the current week, resolved server-side in the org's timezone.
export const useTimesheetsQuery = (date?: string, enabled = true) => {
	return useQuery({
		queryKey: qk.timesheets.week(date),
		queryFn: () => getTimesheets(date),
		enabled,
	});
};

export const useTechnicianWeekQuery = (technicianId: string, date?: string, enabled = true) => {
	return useQuery({
		queryKey: qk.timesheets.technician(technicianId, date),
		queryFn: () => getTechnicianWeek(technicianId, date),
		enabled: enabled && !!technicianId,
	});
};

export const useApproveTimesheetMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: approveTimesheet,
		onSuccess: () => refreshTimesheets(qc),
	});
};

export const useUnapproveTimesheetMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: unapproveTimesheet,
		onSuccess: () => refreshTimesheets(qc),
	});
};

export const useReportShiftIssueMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: reportShiftIssue,
		onSuccess: () => refreshTimesheets(qc),
	});
};

export const useEditShiftMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: editShift,
		onSuccess: () => refreshTimesheets(qc, true),
	});
};

export const useAcceptCorrectionMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: acceptCorrection,
		onSuccess: () => refreshTimesheets(qc, true),
	});
};

export const useRejectCorrectionMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: rejectCorrection,
		onSuccess: () => refreshTimesheets(qc),
	});
};
