import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	Vehicle,
	VehicleStockItem,
	VehicleStockUsage,
	CreateVehicleInput,
	UpdateVehicleInput,
	AddVehicleStockItemInput,
	UpdateVehicleStockItemInput,
	AddPartsUsedInput,
	RestockRequestInput,
	RestockRequest,
	BulkRestockInput,
	BulkRestockResult,
	VehicleStockConflict,
	VehicleMaintenanceAlert,
	VehicleUsageTodayGroup,
	VehicleRestockRecord,
	CompleteRestockInput,
	AdjustStockInput,
	VehicleStockAdjustment,
	VehicleReadiness,
	FillPlan,
	ApplyFillInput,
	FillResultLine,
	TomorrowRequirementVisit,
	VehicleMaintenanceRecord,
	CreateMaintenanceRecordInput,
	UpdateMaintenanceRecordInput,
	MaintenanceSourceLine,
	VehicleMaintenanceReminder,
	CreateMaintenanceReminderInput,
	UpdateMaintenanceReminderInput,
} from "../types/vehicles";
import type { VisitLineItem } from "../types/jobs";

// ── Vehicles ──────────────────────────────────────────────────────────────────

export const getVehicles = async (status?: string): Promise<Vehicle[]> => {
	const params = status ? { status } : undefined;
	const response = await api.get<ApiResponse<Vehicle[]>>("/vehicles", { params });
	if (!response.data.success) throw new Error(response.data.error?.message || "Request failed");
	return response.data.data || [];
};

export const createVehicle = async (input: CreateVehicleInput): Promise<Vehicle> => {
	const response = await api.post<ApiResponse<Vehicle>>("/vehicles", input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create vehicle");
	}
	return response.data.data!;
};

export const updateVehicle = async (id: string, input: UpdateVehicleInput): Promise<Vehicle> => {
	const response = await api.put<ApiResponse<Vehicle>>(`/vehicles/${id}`, input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update vehicle");
	}
	return response.data.data!;
};

// ── Vehicle Stock ─────────────────────────────────────────────────────────────

export const getVehicleStock = async (vehicleId: string): Promise<VehicleStockItem[]> => {
	const response = await api.get<ApiResponse<VehicleStockItem[]>>(`/vehicles/${vehicleId}/stock`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Request failed");
	return response.data.data || [];
};

export const addVehicleStockItem = async (vehicleId: string, input: AddVehicleStockItemInput): Promise<VehicleStockItem> => {
	const response = await api.post<ApiResponse<VehicleStockItem>>(`/vehicles/${vehicleId}/stock`, input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to add stock item");
	}
	return response.data.data!;
};

export const updateVehicleStockItem = async (vehicleId: string, itemId: string, input: UpdateVehicleStockItemInput): Promise<VehicleStockItem> => {
	const response = await api.put<ApiResponse<VehicleStockItem>>(`/vehicles/${vehicleId}/stock/${itemId}`, input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update stock item");
	}
	return response.data.data!;
};

export const deleteVehicleStockItem = async (vehicleId: string, itemId: string): Promise<void> => {
	const response = await api.delete<ApiResponse<null>>(`/vehicles/${vehicleId}/stock/${itemId}`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete stock item");
	}
};

export const createRestockRequest = async (vehicleId: string, itemId: string, input: RestockRequestInput): Promise<void> => {
	const response = await api.post<ApiResponse<unknown>>(`/vehicles/${vehicleId}/stock/${itemId}/restock-request`, input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create restock request");
	}
};

// ── Restock request lifecycle ─────────────────────────────────────────────────

export const getRestockRequests = async (
	status?: string,
	vehicleId?: string,
): Promise<RestockRequest[]> => {
	const params: Record<string, string> = {};
	if (status) params.status = status;
	if (vehicleId) params.vehicleId = vehicleId;
	const response = await api.get<ApiResponse<RestockRequest[]>>("/vehicles/restock-requests", { params });
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to get restock requests");
	return response.data.data ?? [];
};

export const acknowledgeRestockRequest = async (requestId: string): Promise<RestockRequest> => {
	const response = await api.post<ApiResponse<RestockRequest>>(
		`/vehicles/restock-requests/${requestId}/acknowledge`,
	);
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to acknowledge restock request");
	return response.data.data!;
};

export const dismissRestockRequest = async (requestId: string): Promise<RestockRequest> => {
	const response = await api.post<ApiResponse<RestockRequest>>(
		`/vehicles/restock-requests/${requestId}/dismiss`,
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to dismiss restock request");
	}
	return response.data.data!;
};

export const getVehicleRestockRequests = async (vehicleId: string): Promise<RestockRequest[]> => {
	const response = await api.get<ApiResponse<RestockRequest[]>>(`/vehicles/${vehicleId}/restock-requests`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Request failed");
	return response.data.data || [];
};

export const createRestockRequestsBulk = async (
	vehicleId: string,
	input: BulkRestockInput,
): Promise<BulkRestockResult> => {
	const response = await api.post<ApiResponse<BulkRestockResult>>(
		`/vehicles/${vehicleId}/restock-requests/bulk`, input);
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to submit restock requests");
	return response.data.data!;
};

// ── Technician vehicle assignment ─────────────────────────────────────────────

export const setTechnicianVehicle = async (technicianId: string, vehicleId: string | null): Promise<void> => {
	const response = await api.put<ApiResponse<unknown>>(`/technicians/${technicianId}/vehicle`, { vehicle_id: vehicleId });
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to set vehicle");
	}
};

// ── Parts used ────────────────────────────────────────────────────────────────

export const getStockConflicts = async (): Promise<VehicleStockConflict[]> => {
	const response = await api.get<ApiResponse<VehicleStockConflict[]>>("/vehicles/stock-conflicts");
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to load stock conflicts");
	return response.data.data || [];
};

export const getMaintenanceAlerts = async (): Promise<VehicleMaintenanceAlert[]> => {
	const response = await api.get<ApiResponse<VehicleMaintenanceAlert[]>>("/vehicles/maintenance-alerts");
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to load maintenance alerts");
	return response.data.data || [];
};

export const getFillPlan = async (vehicleId: string): Promise<FillPlan> => {
	const response = await api.get<ApiResponse<FillPlan>>(`/vehicles/${vehicleId}/stock/fill-plan`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to load fill plan");
	return response.data.data!;
};

export const applyFill = async (vehicleId: string, input: ApplyFillInput): Promise<FillResultLine[]> => {
	const response = await api.post<ApiResponse<FillResultLine[]>>(`/vehicles/${vehicleId}/stock/fill`, input);
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to apply fill");
	return response.data.data!;
};

export const getUsageToday = async (vehicleId: string): Promise<VehicleUsageTodayGroup[]> => {
	const response = await api.get<ApiResponse<VehicleUsageTodayGroup[]>>(`/vehicles/${vehicleId}/usage-today`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Request failed");
	return response.data.data || [];
};

export const addPartsUsed = async (visitId: string, input: AddPartsUsedInput): Promise<{ lineItem: VisitLineItem; usage: VehicleStockUsage }> => {
	const response = await api.post<ApiResponse<{ lineItem: VisitLineItem; usage: VehicleStockUsage }>>(`/job-visits/${visitId}/parts-used`, input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to add parts used");
	}
	return response.data.data!;
};

export const updatePartsUsedQty = async (
	visitId: string,
	lineItemId: string,
	input: { technician_id: string; quantity: number },
): Promise<VisitLineItem | null> => {
	const response = await api.patch<ApiResponse<VisitLineItem | null>>(
		`/job-visits/${visitId}/parts-used/${lineItemId}`,
		input,
	);
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to update part quantity");
	return response.data.data ?? null;
};

export const getTomorrowRequirements = async (vehicleId: string): Promise<TomorrowRequirementVisit[]> => {
	const response = await api.get<ApiResponse<TomorrowRequirementVisit[]>>(`/vehicles/${vehicleId}/tomorrow-requirements`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to get tomorrow requirements");
	return response.data.data ?? [];
};

// ── Restock (End of Day) ──────────────────────────────────────────────────────

export const completeRestock = async (vehicleId: string, input: CompleteRestockInput): Promise<VehicleRestockRecord> => {
	const response = await api.post<ApiResponse<VehicleRestockRecord>>(`/vehicles/${vehicleId}/restock`, input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to complete restock");
	}
	return response.data.data!;
};

export const getVehicleRestockToday = async (vehicleId: string): Promise<VehicleRestockRecord | null> => {
	const response = await api.get<ApiResponse<VehicleRestockRecord | null>>(`/vehicles/${vehicleId}/restock/today`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Request failed");
	return response.data.data ?? null;
};

export const getVehicleRestockHistory = async (vehicleId: string): Promise<VehicleRestockRecord[]> => {
	const response = await api.get<ApiResponse<VehicleRestockRecord[]>>(`/vehicles/${vehicleId}/restock/history`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Request failed");
	return response.data.data ?? [];
};

export const getVehicleStockAdjustmentHistory = async (vehicleId: string): Promise<VehicleStockAdjustment[]> => {
	const response = await api.get<ApiResponse<VehicleStockAdjustment[]>>(`/vehicles/${vehicleId}/stock/adjustments`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Request failed");
	return response.data.data ?? [];
};

// ── Adjust Stock ──────────────────────────────────────────────────────────────

export const adjustStock = async (vehicleId: string, input: AdjustStockInput): Promise<VehicleStockAdjustment> => {
	const response = await api.post<ApiResponse<VehicleStockAdjustment>>(`/vehicles/${vehicleId}/stock/adjust`, input);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to adjust stock");
	}
	return response.data.data!;
};

// ── Readiness ─────────────────────────────────────────────────────────────────

export const getFleetReadiness = async (
	date: string,
): Promise<Array<{ vehicle_id: string } & VehicleReadiness>> => {
	const res = await api.get<ApiResponse<Array<{ vehicle_id: string } & VehicleReadiness>>>(
		`/vehicles/readiness?date=${encodeURIComponent(date)}`,
	);
	return res.data.data ?? [];
};

export const getVehicleReadiness = async (
	vehicleId: string,
	date?: string,
): Promise<VehicleReadiness> => {
	const res = await api.get<ApiResponse<VehicleReadiness>>(`/vehicles/${vehicleId}/readiness`, { params: date ? { date } : undefined });
	if (!res.data.success || !res.data.data)
		throw new Error(res.data.error?.message ?? "Failed to fetch readiness");
	return res.data.data;
};

export const confirmVehicleReadiness = async (
	vehicleId: string,
	body: { date: string; notes?: string },
): Promise<VehicleReadiness> => {
	const res = await api.post<ApiResponse<VehicleReadiness>>(`/vehicles/${vehicleId}/readiness`, body);
	if (!res.data.success || !res.data.data)
		throw new Error(res.data.error?.message ?? "Failed to confirm readiness");
	return res.data.data;
};

export const revokeVehicleReadiness = async (
	vehicleId: string,
	date: string,
): Promise<VehicleReadiness> => {
	const res = await api.delete<ApiResponse<VehicleReadiness>>(
		`/vehicles/${vehicleId}/readiness/${encodeURIComponent(date)}`
	);
	if (!res.data.success || !res.data.data)
		throw new Error(res.data.error?.message ?? "Failed to revoke readiness");
	return res.data.data;
};

// Vehicle maintenance

export const getMaintenanceRecords = async (vehicleId: string): Promise<VehicleMaintenanceRecord[]> => {
	const response = await api.get<ApiResponse<VehicleMaintenanceRecord[]>>(`/vehicles/${vehicleId}/maintenance`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Get maintenance records failed");
	return response.data.data || [];
}

export const createMaintenanceRecord = async (vehicleId: string, data: CreateMaintenanceRecordInput): Promise<VehicleMaintenanceRecord> => {
	const response = await api.post<ApiResponse<VehicleMaintenanceRecord>>(`/vehicles/${vehicleId}/maintenance`, data);
	if (!response.data.success) throw new Error(response.data.error?.message || "Create maintenance record failed");
	return response.data.data!;
}

export const updateMaintenanceRecord = async (vehicleId: string, recordId: string, data: UpdateMaintenanceRecordInput): Promise<VehicleMaintenanceRecord> => {
	const response = await api.patch<ApiResponse<VehicleMaintenanceRecord>>(`/vehicles/${vehicleId}/maintenance/${recordId}`, data);
	if (!response.data.success) throw new Error(response.data.error?.message || "Update maintenance record failed");
	return response.data.data!;
}

export const deleteMaintenanceRecord = async (vehicleId: string, recordId: string): Promise<void> => {
	const response = await api.delete<ApiResponse<unknown>>(`/vehicles/${vehicleId}/maintenance/${recordId}`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Delete maintenance record failed");
}

export const getMaintenanceReminders = async (vehicleId: string): Promise<VehicleMaintenanceReminder[]> => {
	const response = await api.get<ApiResponse<VehicleMaintenanceReminder[]>>(`/vehicles/${vehicleId}/maintenance/reminders`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Get maintenance reminders failed");
	return response.data.data || [];
}

export const createMaintenanceReminder = async (vehicleId: string, data: CreateMaintenanceReminderInput): Promise<VehicleMaintenanceReminder> => {
	const response = await api.post<ApiResponse<VehicleMaintenanceReminder>>(`/vehicles/${vehicleId}/maintenance/reminders`, data);
	if (!response.data.success) throw new Error(response.data.error?.message || "Create maintenance reminder failed");
	return response.data.data!;
}

export const updateMaintenanceReminder = async (vehicleId: string, reminderId: string, data: UpdateMaintenanceReminderInput): Promise<VehicleMaintenanceReminder> => {
	const response = await api.patch<ApiResponse<VehicleMaintenanceReminder>>(`/vehicles/${vehicleId}/maintenance/reminders/${reminderId}`, data);
	if (!response.data.success) throw new Error(response.data.error?.message || "Update maintenance reminder failed");
	return response.data.data!;
}

export const deleteMaintenanceReminder = async (vehicleId: string, reminderId: string): Promise<void> => {
	const response = await api.delete<ApiResponse<unknown>>(`/vehicles/${vehicleId}/maintenance/reminders/${reminderId}`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Delete maintenance reminder failed");
}

export const acknowledgeMaintenanceReminder = async (vehicleId: string, reminderId: string): Promise<VehicleMaintenanceReminder> => {
	const response = await api.post<ApiResponse<VehicleMaintenanceReminder>>(`/vehicles/${vehicleId}/maintenance/reminders/${reminderId}/acknowledge`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Acknowledge maintenance reminder failed");
	return response.data.data!;
}

export const unacknowledgeMaintenanceReminder = async (vehicleId: string, reminderId: string): Promise<VehicleMaintenanceReminder> => {
	const response = await api.post<ApiResponse<VehicleMaintenanceReminder>>(`/vehicles/${vehicleId}/maintenance/reminders/${reminderId}/unacknowledge`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Unacknowledge maintenance reminder failed");
	return response.data.data!;
}

export const completeMaintenanceReminder = async (vehicleId: string, reminderId: string): Promise<VehicleMaintenanceReminder> => {
	const response = await api.post<ApiResponse<VehicleMaintenanceReminder>>(`/vehicles/${vehicleId}/maintenance/reminders/${reminderId}/complete`);
	if (!response.data.success) throw new Error(response.data.error?.message || "Complete maintenance reminder failed");
	return response.data.data!;
}

export const searchMaintenanceSourceLines = async (vehicleId: string, q?: string): Promise<MaintenanceSourceLine[]> => {
	const response = await api.post<ApiResponse<MaintenanceSourceLine[]>>(
		`/vehicles/${vehicleId}/maintenance/purchase-lines`,
		undefined,
		{ params: q ? { q } : undefined },
	);
	if (!response.data.success) throw new Error(response.data.error?.message || "Search failed");
	return response.data.data || [];
}
