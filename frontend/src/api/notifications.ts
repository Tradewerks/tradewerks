import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { TechnicianNotification, DispatcherNotification } from "../types/notifications";

export const getNotifications = async (technicianId: string, unreadOnly = false): Promise<TechnicianNotification[]> => {
	const params = unreadOnly ? { unread: "true" } : undefined;
	const response = await api.get<ApiResponse<TechnicianNotification[]>>(`/technicians/${technicianId}/notifications`, { params });
	return response.data.data || [];
};

export const markNotificationRead = async (technicianId: string, notifId: string): Promise<TechnicianNotification> => {
	const response = await api.patch<ApiResponse<TechnicianNotification>>(
		`/technicians/${technicianId}/notifications/${notifId}/read`,
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to mark notification read");
	}
	return response.data.data!;
};

export const markAllNotificationsRead = async (technicianId: string): Promise<void> => {
	const response = await api.patch<ApiResponse<null>>(`/technicians/${technicianId}/notifications/read-all`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to mark all read");
	}
};

// dispatcher notifications
export const getDispatcherNotifications = async (dispatcherId: string, unreadOnly = false): Promise<DispatcherNotification[]> => {
	const params = unreadOnly ? { unread: "true" } : undefined;
	const response = await api.get<ApiResponse<DispatcherNotification[]>>(`/dispatchers/${dispatcherId}/notifications`, { params });
	return response.data.data || [];
};

export const markDispatcherNotificationRead = async (dispatcherId: string, notifId: string): Promise<DispatcherNotification> => {
	const response = await api.patch<ApiResponse<DispatcherNotification>>(
		`/dispatchers/${dispatcherId}/notifications/${notifId}/read`,
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to mark notification read");
	}
	return response.data.data!;
};

export const markAllDispatcherNotificationsRead = async (dispatcherId: string): Promise<void> => {
	const response = await api.patch<ApiResponse<null>>(`/dispatchers/${dispatcherId}/notifications/read-all`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to mark all read");
	}
};
