import { isAxiosError } from "axios";
import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { 
	Technician, 
	CreateTechnicianInput, 
	UpdateTechnicianInput,
} from "../types/technicians";


// ============================================
// TECHNICIAN API
// ============================================

export const getAllTechnicians = async (): Promise<Technician[]> => {
	const response = await api.get<ApiResponse<Technician[]>>('/technicians');
	return response.data.data || [];
};

export const getTechnicianById = async (id: string): Promise<Technician> => {
	const response = await api.get<ApiResponse<Technician>>(`/technicians/${id}`);
	
	if (!response.data.data) {
		throw new Error('Technician not found');
	}
	
	return response.data.data;
};

export const createTechnician = async (input: CreateTechnicianInput): Promise<Technician> => {
	// Ensure coords is always provided (backend requirement)
	const technicianData = {
		...input,
		coords: input.coords || { lat: 0, lon: 0 }
	};
	
	const response = await api.post<ApiResponse<Technician>>('/technicians', technicianData);
	
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to create technician');
	}
	
	return response.data.data!;
};

export const updateTechnician = async (id: string, data: UpdateTechnicianInput): Promise<Technician> => {
	const response = await api.put<ApiResponse<Technician>>(`/technicians/${id}`, data);
	
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to update technician');
	}
	
	return response.data.data!;
};

export const deleteTechnician = async (id: string): Promise<{ message: string; id: string }> => {
	const response = await api.delete<ApiResponse<{ message: string; id: string }>>(`/technicians/${id}`);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to delete technician');
	}

	return response.data.data || { message: 'Technician deleted successfully', id };
};

export const setTechnicianCurrentVehicle = async (technicianId: string, vehicleId: string | null): Promise<void> => {
	const response = await api.put<ApiResponse<unknown>>(`/technicians/${technicianId}/vehicle`, { vehicle_id: vehicleId });
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to set vehicle');
	}
};

export const goAvailable = async (technicianId: string): Promise<Technician> => {
	const response = await api.post<ApiResponse<Technician>>(`/technicians/${technicianId}/available`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to go available');
	}
	return response.data.data!;
};

export const goOffline = async (technicianId: string, techCoords?: { lat: number; lon: number }): Promise<Technician> => {
	const response = await api.post<ApiResponse<Technician>>(`/technicians/${technicianId}/offline`, {
		...(techCoords ? { tech_coords: techCoords } : {}),
	});
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to go offline');
	}
	return response.data.data!;
};

export const pingLocation = async (technicianId: string, coords: { lat: number; lon: number }): Promise<void> => {
	await api.post(`/technicians/${technicianId}/ping`, { coords });
};

export const goOnBreak = async (technicianId: string, reason: string): Promise<Technician> => {
	const response = await api.post<ApiResponse<Technician>>(`/technicians/${technicianId}/break`, { reason });
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to start break');
	}
	return response.data.data!;
};

export const markDone = async (technicianId: string): Promise<Technician> => {
	const response = await api.post<ApiResponse<Technician>>(`/technicians/${technicianId}/done`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to mark done');
	}
	return response.data.data!;
};

export const returnFromJob = async (technicianId: string): Promise<Technician> => {
	const response = await api.post<ApiResponse<Technician>>(`/technicians/${technicianId}/head-back`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || 'Failed to return');
	}
	return response.data.data!;
}

export const changeTechnicianPassword = async (id: string, data: { current_password: string; new_password: string }): Promise<Technician> => {
	try {
		const response = await api.post<ApiResponse<Technician>>(`/technicians/${id}/change-password`, data);
		if (!response.data.success) {
			throw new Error(response.data.error?.message || 'Failed to change password');
		}
		return response.data.data!;
	} catch (err) {
		const message =
			(isAxiosError(err) ? err.response?.data?.error?.message : undefined) ||
			(err instanceof Error ? err.message : undefined) ||
			'Failed to change password';
		throw new Error(message);
	}
};