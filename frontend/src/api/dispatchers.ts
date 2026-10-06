import { isAxiosError } from "axios";
import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { 
	Dispatcher, 
	CreateDispatcherInput, 
	UpdateDispatcherInput,
} from "../types/dispatchers";

// ============================================
// DISPATCHER API
// ============================================

export const getAllDispatchers = async (): Promise<Dispatcher[]> => {
    const response = await api.get<ApiResponse<Dispatcher[]>>('/dispatchers');
    return response.data.data || [];
}

export const getDispatcherById = async (id: string): Promise<Dispatcher> => {
    const response = await api.get<ApiResponse<Dispatcher>>(`/dispatchers/${id}`);
    
    if (!response.data.data) {
        throw new Error('Dispatcher not found');
    }
    
    return response.data.data;
};

export const createDispatcher = async (input: CreateDispatcherInput): Promise<Dispatcher> => {
    // Ensure coords is always provided (backend requirement)
    const dispatcherData = {
        ...input,
    };
    
    const response = await api.post<ApiResponse<Dispatcher>>('/dispatchers', dispatcherData);
    
    if (!response.data.success) {
        throw new Error(response.data.error?.message || 'Failed to create dispatcher');
    }
    
    return response.data.data!;
};

export const updateDispatcher = async (id: string, data: UpdateDispatcherInput): Promise<Dispatcher> => {
    const response = await api.put<ApiResponse<Dispatcher>>(`/dispatchers/${id}`, data);
    
    if (!response.data.success) {
        throw new Error(response.data.error?.message || 'Failed to update dispatcher');
    }
    
    return response.data.data!;
};

export const deleteDispatcher = async (id: string): Promise<{ message: string; id: string }> => {
    const response = await api.delete<ApiResponse<{ message: string; id: string }>>(`/dispatchers/${id}`);
    
    if (!response.data.success) {
        throw new Error(response.data.error?.message || 'Failed to delete dispatcher');
    }
    
    return response.data.data || { message: 'Dispatcher deleted successfully', id };
};

export const changeDispatcherPassword = async (id: string, data: { current_password: string; new_password: string }): Promise<Dispatcher> => {
    try {
        const response = await api.post<ApiResponse<Dispatcher>>(`/dispatchers/${id}/change-password`, data);

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
}

export const deactivateDispatcher = async (id: string): Promise<Dispatcher> => {
	const response = await api.post<ApiResponse<Dispatcher>>(`/dispatchers/${id}/deactivate`);
	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to deactivate dispatcher");
	}
	return response.data.data;
};

export const reactivateDispatcher = async (id: string): Promise<Dispatcher> => {
	const response = await api.post<ApiResponse<Dispatcher>>(`/dispatchers/${id}/reactivate`);
	if (!response.data.success || !response.data.data) {
		throw new Error(response.data.error?.message || "Failed to reactivate dispatcher");
	}
	return response.data.data;
};
