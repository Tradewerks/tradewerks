import axios from "axios";
import { z } from "zod";
import { api, queryParams } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	Supplier,
	SupplierBatch,
	SupplierDetail,
	SupplierMergeResult,
	SupplierMovementsPage,
} from "../types/suppliers";

// ============================================================================
// VALIDATION SCHEMAS
// ============================================================================

// Mirrors backend/src/lib/validate/suppliers.ts. Blank optional fields become
// null so clearing a field in the edit form actually clears it server-side.
const optionalText = (max: number) =>
	z
		.string()
		.max(max, `Must be at most ${max} characters`)
		.nullable()
		.optional()
		.transform((v) => (v == null ? v : v.trim() === "" ? null : v.trim()));

const optionalEmail = z.preprocess(
	(v) => (typeof v === "string" && v.trim() === "" ? null : v),
	z.string().email("Must be a valid email").max(255).nullable().optional(),
);

const createSupplierSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Name is required")
		.max(200, "Name must be at most 200 characters"),
	account_number: optionalText(100),
	contact_name: optionalText(200),
	phone: optionalText(50),
	email: optionalEmail,
	notes: optionalText(5000),
	is_active: z.boolean().optional(),
});

const updateSupplierSchema = createSupplierSchema.partial();

export type CreateSupplierInput = z.input<typeof createSupplierSchema>;
export type UpdateSupplierInput = z.input<typeof updateSupplierSchema>;

export interface ListSuppliersParams {
	search?: string;
	/** "true" (default) hides deactivated vendors; merge losers live under "all". */
	active?: "true" | "false" | "all";
	include_usage?: boolean;
}

/**
 * A name collision, carrying the vendor that already owns the name.
 *
 * Thrown rather than returned so the picker can adopt the existing supplier
 * instead of making the user retype a spelling the org already has.
 */
export class SupplierConflictError extends Error {
	readonly existing: Supplier | null;

	constructor(message: string, existing: Supplier | null) {
		super(message);
		this.name = "SupplierConflictError";
		this.existing = existing;
	}
}

function rethrowConflict(error: unknown): never {
	if (axios.isAxiosError(error) && error.response?.status === 409) {
		const body = error.response.data as ApiResponse<never> | undefined;
		throw new SupplierConflictError(
			body?.error?.message || "Supplier already exists",
			(body?.error?.details as Supplier | undefined) ?? null,
		);
	}
	throw error;
}

// ============================================================================
// SUPPLIERS API
// ============================================================================

export const getSuppliers = async (params: ListSuppliersParams = {}): Promise<Supplier[]> => {
	const response = await api.get<ApiResponse<Supplier[]>>("/suppliers", {
		params: queryParams({
			search: params.search,
			active: params.active,
			include_usage: params.include_usage ? "true" : undefined,
		}),
	});
	return response.data.data || [];
};

export const createSupplier = async (data: CreateSupplierInput): Promise<Supplier> => {
	const parsed = createSupplierSchema.parse(data);
	try {
		const response = await api.post<ApiResponse<Supplier>>("/suppliers", parsed);
		if (!response.data.success) {
			throw new Error(response.data.error?.message || "Failed to create supplier");
		}
		return response.data.data!;
	} catch (error) {
		rethrowConflict(error);
	}
};

export const updateSupplier = async (id: string, data: UpdateSupplierInput): Promise<Supplier> => {
	const parsed = updateSupplierSchema.parse(data);
	try {
		const response = await api.patch<ApiResponse<Supplier>>(`/suppliers/${id}`, parsed);
		if (!response.data.success) {
			throw new Error(response.data.error?.message || "Failed to update supplier");
		}
		return response.data.data!;
	} catch (error) {
		rethrowConflict(error);
	}
};

export const mergeSuppliers = async (
	sourceId: string,
	targetId: string,
): Promise<SupplierMergeResult> => {
	const response = await api.post<ApiResponse<SupplierMergeResult>>(
		`/suppliers/${sourceId}/merge`,
		{ target_id: targetId },
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to merge suppliers");
	}
	return response.data.data!;
};

export const getSupplier = async (id: string): Promise<SupplierDetail> => {
	const response = await api.get<ApiResponse<SupplierDetail>>(`/suppliers/${id}`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch supplier");
	}
	return response.data.data!;
};

// created_after stays out of the params here — unlike the item ledger, the
// vendor ledger has no range control on the detail page yet.
export const getSupplierMovements = async (
	id: string,
	cursor?: string,
	limit?: number,
): Promise<SupplierMovementsPage> => {
	const response = await api.get<ApiResponse<SupplierMovementsPage>>(
		`/suppliers/${id}/movements`,
		{ params: queryParams({ cursor, limit }) },
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch purchase history");
	}
	return response.data.data!;
};

export const getSupplierBatches = async (id: string): Promise<SupplierBatch[]> => {
	const response = await api.get<ApiResponse<{ batches: SupplierBatch[] }>>(
		`/suppliers/${id}/batches`,
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to fetch lots");
	}
	return response.data.data!.batches;
};
