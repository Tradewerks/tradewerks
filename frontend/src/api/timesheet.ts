import {api} from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { ApproveTimesheetInput, TechWeekDetails, TimesheetWeek } from "../types/timesheets";

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

export const getTechnicianWeek = async (technicianId: string, date?: string) => {
    const response = await api.get<ApiResponse<TechWeekDetails>>(`timesheets/technician/${technicianId}`, { params: { date } });
    if (response.data.error) throw new Error(response.data.error?.message || "Failed to get technician week details");
    return response.data.data!;
}
