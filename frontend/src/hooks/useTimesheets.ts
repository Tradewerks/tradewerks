import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approveTimesheet, getTimesheets, getTechnicianWeek, unapproveTimesheet } from "../api/timesheet";
import { qk } from "../lib/queryKeys";

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
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.timesheets.all }),
	});
};

export const useUnapproveTimesheetMutation = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: unapproveTimesheet,
		onSuccess: () => qc.invalidateQueries({ queryKey: qk.timesheets.all }),
	});
};
