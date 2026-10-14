import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { ArrivalBoard } from "../types/arrivals";

export const getArrivals = async (params?: { visitId?: string; techId?: string }): Promise<ArrivalBoard> => {
	const response = await api.get<ApiResponse<ArrivalBoard>>("/arrivals", { params });
	if (!response.data.success) throw new Error(response.data.error?.message || "Failed to load arrivals");
	return response.data.data!;
};
