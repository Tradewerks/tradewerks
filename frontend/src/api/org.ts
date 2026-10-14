import { isAxiosError } from "axios";
import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { ProvisionalItem } from "../types/inventory";

export type RestockMode = "tech_self_serve" | "dispatch_prepared";

export type MeasurementSystem = "imperial" | "metric";

export interface OrgSettings {
	id: string;
	name: string;
	logo_url: string | null;
	phone: string | null;
	address: string | null;
	coords: { lat: number; lon: number } | null;
	email: string | null;
	website: string | null;
	tax_rate: string;
	restock_mode: RestockMode;
	measurement_system: MeasurementSystem;
	mfa_required: boolean;
	brand_color: string | null;
	/** Decimal over the wire, like tax_rate. Null means second sign-off is off. */
	field_purchase_second_signoff_threshold: string | null;
}

export interface OrgSettingsUpdate {
	name?: string;
	phone?: string | null;
	address?: string | null;
	coords?: { lat: number; lon: number } | null;
	email?: string | null;
	website?: string | null;
	restock_mode?: RestockMode;
	measurement_system?: MeasurementSystem;
	mfa_required?: boolean;
	brand_color?: string | null;
	field_purchase_second_signoff_threshold?: number | null;
}

export const getOrgSettings = async (): Promise<OrgSettings> => {
	const response = await api.get<ApiResponse<OrgSettings>>("/org");
	if (!response.data.data) throw new Error("Organization not found");
	return response.data.data;
};

export const updateOrgSettings = async (data: OrgSettingsUpdate): Promise<OrgSettings> => {
	const response = await api.patch<ApiResponse<OrgSettings>>("/org", data);
	if (!response.data.data) throw new Error("Failed to update organization");
	return response.data.data;
};

export const uploadOrgLogo = async (file: File): Promise<string> => {
	const formData = new FormData();
	formData.append("image", file);
	const response = await api.post<ApiResponse<{ url: string }>>("/org/logo", formData, {
		headers: { "Content-Type": "multipart/form-data" },
	});
	if (!response.data.data) throw new Error("Upload failed");
	return response.data.data.url;
};

export const deleteOrgLogo = async (): Promise<void> => {
	await api.delete("/org/logo");
};

// ============================================================================
// PROVISIONAL ITEMS
// ============================================================================

export const getProvisionalItems = async (): Promise<ProvisionalItem[]> => {
	const response = await api.get<ApiResponse<ProvisionalItem[]>>("/inventory/provisional");
	return response.data.data || [];
};

/**
 * Adopt a provisional item into the real catalog. The 400 for a missing
 * cost basis is unwrapped here so the client shows the server's wording,
 * not axios's.
 */
export const approveItem = async (
	itemId: string,
	body?: {
		initial_warehouse_qty?: number;
		cost?: number;
		unit?: string;
		low_stock_threshold?: number | null;
		location?: string | null;
	},
): Promise<void> => {
	try {
		await api.post(`/inventory/${itemId}/approve`, body ?? {});
	} catch (err) {
		throw new Error(
			(isAxiosError(err) ? err.response?.data?.error?.message : undefined) ||
				"Failed to adopt item",
		);
	}
};

export const mergeItem = async (itemId: string, targetInventoryItemId: string): Promise<void> => {
	await api.post(`/inventory/${itemId}/merge`, { target_inventory_item_id: targetInventoryItemId });
};

export const rejectItem = async (itemId: string): Promise<void> => {
	await api.post(`/inventory/${itemId}/reject`);
};
