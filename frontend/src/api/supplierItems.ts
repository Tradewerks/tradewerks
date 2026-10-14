import { z } from "zod";
import { api, queryParams } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { SupplierItem } from "../types/supplierItems";

// Mirrors backend/src/lib/validate/supplierItems.ts.
const optionalText = (max: number) =>
	z
		.string()
		.max(max, `Must be at most ${max} characters`)
		.nullable()
		.optional()
		.transform((v) => (v == null ? v : v.trim() === "" ? null : v.trim()));

const money = z
	.number()
	.min(0, "Price cannot be negative")
	.max(99_999_999.99, "Price is too large")
	.nullable()
	.optional();

const editableFields = {
	vendor_sku: optionalText(100),
	contract_price: money,
	lead_time_days: z
		.number()
		.int("Lead time must be a whole number of days")
		.min(0)
		.max(365, "Lead time must be 365 days or fewer")
		.nullable()
		.optional(),
	min_order_qty: z.number().min(0).max(9_999_999.99).nullable().optional(),
	notes: optionalText(2000),
	is_preferred: z.boolean().optional(),
};

const upsertSupplierItemSchema = z.object({
	supplier_id: z.string().uuid(),
	inventory_item_id: z.string().uuid(),
	...editableFields,
});

const updateSupplierItemSchema = z.object(editableFields);

export type UpsertSupplierItemInput = z.input<typeof upsertSupplierItemSchema>;
export type UpdateSupplierItemInput = z.input<typeof updateSupplierItemSchema>;

export interface ListSupplierItemsParams {
	supplier_id?: string;
	inventory_item_id?: string;
}

export const getSupplierItems = async (
	params: ListSupplierItemsParams = {},
): Promise<SupplierItem[]> => {
	const response = await api.get<ApiResponse<SupplierItem[]>>("/supplier-items", {
		params: queryParams({ ...params }),
	});
	return response.data.data || [];
};

export const upsertSupplierItem = async (data: UpsertSupplierItemInput): Promise<SupplierItem> => {
	const parsed = upsertSupplierItemSchema.parse(data);
	const response = await api.post<ApiResponse<SupplierItem>>("/supplier-items", parsed);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to save supplier price");
	}
	return response.data.data!;
};

export const updateSupplierItem = async (
	id: string,
	data: UpdateSupplierItemInput,
): Promise<SupplierItem> => {
	const parsed = updateSupplierItemSchema.parse(data);
	const response = await api.patch<ApiResponse<SupplierItem>>(`/supplier-items/${id}`, parsed);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update supplier price");
	}
	return response.data.data!;
};

export const preferSupplierItem = async (id: string): Promise<SupplierItem> => {
	const response = await api.post<ApiResponse<SupplierItem>>(`/supplier-items/${id}/prefer`, {});
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to set preferred supplier");
	}
	return response.data.data!;
};

export const deleteSupplierItem = async (id: string): Promise<{ id: string }> => {
	const response = await api.delete<ApiResponse<{ id: string }>>(`/supplier-items/${id}`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to remove supplier price");
	}
	return response.data.data || { id };
};
