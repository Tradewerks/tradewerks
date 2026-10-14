import { isAxiosError } from "axios";
import { z } from "zod";
import { api, queryParams } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
    Purchase,
	PurchaseDetail,
	PurchaseStatus,
	PurchaseSort,
} from "../types/purchases";
import { isStorableStockQty } from "../components/inventory/stockQtyPrecision";

// Backend returns errors as { error: { message } } with a non-2xx status, so
// axios rejects before we can read the body. Re-throw with the real message.
function toError(err: unknown, fallback: string): Error {
	if (isAxiosError(err)) {
		return new Error(err.response?.data?.error?.message || err.message || fallback);
	}
	return err instanceof Error ? err : new Error(fallback);
}

// ============================================================================
// VALIDATION SCHEMAS — mirror backend/src/lib/validate/purchases.ts
// ============================================================================

const STOCK_QTY_MESSAGE = "Amount must have at most 2 decimal places and be at most 99,999,999.99";

const money = (label: string) =>
	z
		.number()
		.min(0, `${label} must be non-negative`)
		.refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE });

const signedMoney = (label: string) =>
	z
		.number()
		.refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE })
		.describe(label);

const positiveMoney = (label: string) =>
	z
		.number()
		.positive(`${label} must be positive`)
		.refine(isStorableStockQty, { message: STOCK_QTY_MESSAGE });

// Matches item name cap
export const DESCRIPTION_MAX = 255;
export const VENDOR_NAME_MAX = 120;
export const NOTE_MAX = 2000;

const allocationSchema = z.object({
	job_id: z.string().uuid(),
	job_visit_id: z.string().uuid().nullable().optional(),
});

/** Job allocation only valid on a non_stock line — same rule as the backend. */
const lineSchema = z
	.object({
		description: z.string().trim().min(1, "Item is required").max(DESCRIPTION_MAX),
		quantity: positiveMoney("Quantity"),
		unit_price: signedMoney("Unit price"),
		line_total: signedMoney("Line total").optional(),
		inventory_item_id: z.string().uuid().nullable().optional(),
		disposition: z.enum(["receive", "non_stock"]).nullable().optional(),
		disposition_vehicle_id: z.string().uuid().nullable().optional(),
		job_id: z.string().uuid().nullable().optional(),
		sort_order: z.number().int().min(0).optional(),
	})
	.superRefine((l, ctx) => {
		const negative = l.unit_price < 0 || (l.line_total != null && l.line_total < 0);
		if (negative && l.disposition === "receive") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["disposition"],
				message: "A negative line cannot be received into stock",
			});
		}
		if (l.job_id != null && l.disposition !== "non_stock") {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["job_id"],
				message: "A job allocation is only valid on a non_stock line",
			});
		}
	});

export const createPurchaseSchema = z.object({
	vendor_name: z.string().trim().min(1, "Vendor name is required").max(VENDOR_NAME_MAX),
	supplier_id: z.string().uuid("Supplier is required"),
	purchased_at: z.coerce.date().optional(),
	tax_group_id: z.string().uuid().nullable().optional(),
	tax_amount: money("Tax amount").optional(),
	allocations: z.array(allocationSchema).max(50).optional(),
	lines: z.array(lineSchema).min(1, "At least one line is required").max(200),
});

export const updatePurchaseSchema = z.object({
	vendor_name: z.string().trim().min(1, "Vendor name is required").max(VENDOR_NAME_MAX),
	supplier_id: z.string().uuid("Supplier is required"),
	purchased_at: z.coerce.date().optional(),
	tax_group_id: z.string().uuid().nullable().optional(),
	tax_amount: money("Tax amount").optional(),
	allocations: z.array(allocationSchema).max(50).optional(),
});

/** Replaces the whole line set — no partial-line-update path exists. */
export const replaceLinesSchema = z.object({
	lines: z.array(lineSchema).min(1, "At least one line is required").max(200),
});

export const cancelPurchaseSchema = z.object({
	cancellation_reason: z.string().optional(),
});

export const receivePurchaseSchema = z.object({
	lines: z
		.array(
			z.object({
				id: z.string().uuid(),
				quantity_received: positiveMoney("Quantity received"),
				disposition_vehicle_id: z.string().uuid().nullable().optional(),
				location: z.string().max(255).nullable().optional(),
			}),
		)
		.min(1, "At least one line must be received"),
});

export type CreatePurchaseInput = z.input<typeof createPurchaseSchema>;
export type UpdatePurchaseInput = z.input<typeof updatePurchaseSchema>;
export type ReplacePurchaseLinesInput = z.input<typeof replaceLinesSchema>;
export type CancelPurchaseInput = z.input<typeof cancelPurchaseSchema>;
export type ReceivePurchaseInput = z.input<typeof receivePurchaseSchema>;

export interface ListPurchasesParams {
      status?: PurchaseStatus | "open" | "all";
      kind?: "purchase" | "refund" | "all";
      supplier_id?: string;
      job_id?: string;
      /** Vendor name or any line description. */
      search?: string;
      sort?: PurchaseSort;
      offset?: number;
      limit?: number;
      /** ISO dates, matched against submitted_at. */
      date_from?: string;
      date_to?: string;
}

export const getPurchase = async (id: string) => {
	try {
		const response = await api.get<ApiResponse<PurchaseDetail>>(`/purchases/${id}`);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to get purchase");
		return response.data.data!;
	} catch (err) {
		throw toError(err, "Failed to get purchase");
	}
}

export const getPurchases = async (params: ListPurchasesParams = {}) => {
	try {
		const response = await api.get<ApiResponse<{ purchases: Purchase[]; total: number; offset: number }>>(
			"/purchases",
			{ params: queryParams({ ...params }) }
		);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to list purchases");
		return response.data.data!;
	} catch (err) {
		throw toError(err, "Failed to list purchases");
	}
}

export const createPurchase = async (data: CreatePurchaseInput) => {
	try {
		const response = await api.post<ApiResponse<{ purchase: Purchase }>>("/purchases", data);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to create purchase");
		return response.data.data!.purchase;
	} catch (err) {
		throw toError(err, "Failed to create purchase");
	}
}

export const updatePurchase = async (id: string, data: UpdatePurchaseInput) => {
	try {
		const response = await api.patch<ApiResponse<{ purchase: Purchase }>>(`/purchases/${id}`, data);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to update purchase");
		return response.data.data!.purchase;
	} catch (err) {
		throw toError(err, "Failed to update purchase");
	}
}

export const replacePurchaseLines = async (id: string, data: ReplacePurchaseLinesInput) => {
	try {
		const response = await api.put<ApiResponse<{ purchase: Purchase }>>(`/purchases/${id}/lines`, data);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to replace purchase lines");
		return response.data.data!.purchase;
	} catch (err) {
		throw toError(err, "Failed to replace purchase lines");
	}
}

export const orderPurchase = async (id: string) => {
	try {
		const response = await api.post<ApiResponse<{ purchase: Purchase }>>(`/purchases/${id}/order`);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to order purchase");
		return response.data.data!.purchase;
	} catch (err) {
		throw toError(err, "Failed to order purchase");
	}
}

export const cancelPurchase = async (id: string, data: CancelPurchaseInput = {}) => {
	try {
		const response = await api.post<ApiResponse<{ purchase: Purchase }>>(`/purchases/${id}/cancel`, data);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to cancel purchase");
		return response.data.data!.purchase;
	} catch (err) {
		throw toError(err, "Failed to cancel purchase");
	}
}

export const deletePurchase = async (id: string) => {
	try {
		const response = await api.delete<ApiResponse<{deleted: boolean}>>(`/purchases/${id}`);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to delete purchase");
		return response.data.data!.deleted;
	} catch (err) {
		throw toError(err, "Failed to delete purchase");
	}
}

export const downloadPurchaseOrderPdf = async (id: string, docNumber: string): Promise<void> => {
	const response = await api.get(`/purchases/${id}/pdf`, { responseType: "blob" });
	const url = URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = `${docNumber}.pdf`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}; 

export const receivePurchase = async (id: string, data: ReceivePurchaseInput) => {
	try {
		const response = await api.post<ApiResponse<{ purchase: Purchase; warnings: string[] }>>(`/purchases/${id}/receive`, data);
		if (response.data.error) throw new Error(response.data.error.message || "Failed to receive purchase");
		return response.data.data!;
	} catch (err) {
		throw toError(err, "Failed to receive purchase");
	}
}
