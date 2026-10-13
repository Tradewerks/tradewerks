import {api} from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { ApproveTimesheetInput, EditShiftInput,TechWeekDetails, TimesheetWeek } from "../types/timesheets";

export const approveTimesheet = async (data: ApproveTimesheetInput) => {
    const response = await api.post<ApiResponse<TimesheetWeek>>("timesheets/approve", data);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to approve timesheet");
    return response.data.data!;
}

export const unapproveTimesheet = async (data: ApproveTimesheetInput) => {
    const response = await api.delete<ApiResponse<TimesheetWeek>>("timesheets/approve", { data });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to unapprove timesheet");
    return response.data.data!;
}

export const getTimesheets = async (date?: string) => {
    const response = await api.get<ApiResponse<TimesheetWeek[]>>("timesheets", { params: { date } });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get timesheet");
    return response.data.data!;
}

export const editShift = async ({ shiftId, data }: { shiftId: string; data: EditShiftInput }) => {
    const response = await api.patch<ApiResponse<unknown>>(`timesheets/shifts/${shiftId}`, data);
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to edit shift");
    return response.data.data!;
}

export const reportShiftIssue = async ({ shiftId, message, proposed }: { shiftId: string; message: string; proposed?: EditShiftInput }) => {
    const response = await api.post<ApiResponse<null>>(`timesheets/shifts/${shiftId}/report`, { message, proposed });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to report issue");
}

export const acceptCorrection = async ({ id, note, proposed }: { id: string; note?: string; proposed?: EditShiftInput }) => {
    const response = await api.post<ApiResponse<boolean>>(`timesheets/corrections/${id}/accept`, { note, proposed });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to accept correction");
}

export const rejectCorrection = async ({ id, note }: { id: string; note?: string }) => {
    const response = await api.post<ApiResponse<boolean>>(`timesheets/corrections/${id}/reject`, { note });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to reject correction");
}

export const getTechnicianWeek =async (technicianId: string, date?: string) => {
    const response = await api.get<ApiResponse<TechWeekDetails>>(`timesheets/technician/${technicianId}`, { params: { date } });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get technician week details");
    return response.data.data!;
}
