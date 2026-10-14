import { isAxiosError } from "axios";
import { z } from "zod";
import { api, queryParams } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	FieldPurchase,
	FieldPurchaseDetail,
	FieldPurchaseCaptureLocation,
	FieldPurchaseExtraction,
	FieldPurchaseGrant,
	FieldPurchaseStatus,
	FieldPurchaseSummary,
	LimitCheckResult,
	MyFieldPurchaseAuthority,
	SubmitResult,
} from "../types/fieldPurchases";

// ============================================================================
// VALIDATION SCHEMAS — mirror backend/src/lib/validate/fieldPurchases.ts
// ============================================================================

const money = z.number().min(0).multipleOf(0.01, "At most two decimal places");
const positiveMoney = z.number().positive().multipleOf(0.01, "At most two decimal places");
/**
 * A line may be negative: a printed trade discount is a negative price on one line.
 * Only lines — every other caller of `money` means non-negative, and a negative
 * receipt total is a misread.
 */
const signedMoney = z.number().multipleOf(0.01, "At most two decimal places");

/** Which jobs a receipt covers. What each owes follows from the lines, not from here. */
const allocationSchema = z.object({
	job_id: z.string().uuid(),
	// The visit the charge lands on. Parsed here as well as on the server, or the
	// schema would strip it on the way out and the purchase would never bill.
	job_visit_id: z.string().uuid().nullable().optional(),
});

const grantSchema = z
	.object({
		technician_id: z.string().uuid(),
		per_transaction_limit: positiveMoney,
		daily_limit: positiveMoney.nullable().optional(),
		weekly_limit: positiveMoney.nullable().optional(),
		per_job_limit: positiveMoney.nullable().optional(),
		notes: z.string().max(2000).nullable().optional(),
	})
	.superRefine((d, ctx) => {
		// Mirrored from the server so the form can say so without a round trip: a
		// daily ceiling under the per-transaction one makes every legal purchase
		// breach it.
		if (d.daily_limit != null && d.daily_limit < d.per_transaction_limit) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["daily_limit"],
				message: "Daily limit cannot be below the per-transaction limit",
			});
		}
		if (d.weekly_limit != null && d.daily_limit != null && d.weekly_limit < d.daily_limit) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["weekly_limit"],
				message: "Weekly limit cannot be below the daily limit",
			});
		}
	});

const createPurchaseSchema = z.object({
	reason: z.string().max(2000).nullable().optional(),
	estimated_amount: positiveMoney.nullable().optional(),
	allocations: z.array(allocationSchema).min(1, "Pick at least one job"),
});

const lineSchema = z.object({
	description: z.string().trim().min(1, "Description is required").max(200),
	quantity: positiveMoney,
	unit_price: signedMoney,
	line_total: signedMoney.optional(),
	inventory_item_id: z.string().uuid().nullable().optional(),
	disposition: z.enum(["receive", "non_stock"]).nullable().optional(),
	disposition_vehicle_id: z.string().uuid().nullable().optional(),
	// The job this line served. Sent only on a split receipt; with one job the
	// server assigns it rather than asking the obvious.
	job_id: z.string().uuid().nullable().optional(),
	sort_order: z.number().int().min(0).optional(),
	// The technician's confirmation of this line, sent with the line rather than
	// as a second errand. Mandatory verification is unchanged.
	acknowledged: z.boolean().optional(),
	// Mirrors the server's lineSchema exactly and must keep tracking it: zod strips
	// unknown keys, so a field added only on one side is silently dropped on the
	// way through this parse.
	ocr_confidence: z.number().min(0).max(1).nullable().optional(),
});

export type UpsertGrantInput = z.input<typeof grantSchema>;
export type CreatePurchaseInput = z.input<typeof createPurchaseSchema>;

export type FieldPurchaseSort = "newest" | "oldest" | "amount_desc" | "amount_asc";

export interface ListPurchasesParams {
	status?: FieldPurchaseStatus | "open" | "with_tech" | "decided" | "all";
	technician_id?: string;
	job_id?: string;
	flagged?: "true" | "false";
	kind?: "purchase" | "refund" | "all";
	/** Technician name, vendor, or any line description. */
	search?: string;
	/** ISO dates, matched against submitted_at (created_at while unsubmitted). */
	date_from?: string;
	date_to?: string;
	sort?: FieldPurchaseSort;
	offset?: number;
	limit?: number;
}

/** `total` is the match count before the page cap, so the UI can admit truncation. */
export interface FieldPurchasePage {
	items: FieldPurchase[];
	total: number;
}

export interface ReceiptCapture {
	file: File;
	captured_at?: string;
	capture_lat?: number;
	capture_lng?: number;
	capture_accuracy_m?: number;
}

function unwrap<T>(response: { data: ApiResponse<T> }, fallback: string): T {
	if (!response.data.success) throw new Error(response.data.error?.message || fallback);
	return response.data.data!;
}

// A 4xx rejects the axios promise before unwrap() ever sees the body, so without
// this every controlled refusal - unverified lines, a duplicate receipt, a second
// signer who is also the reviewer - reaches the technician as "Request failed with
// status code 400".
async function call<T>(request: Promise<{ data: ApiResponse<T> }>, fallback: string): Promise<T> {
	return (await callWithMeta(request, fallback)).data;
}

/** Same handling, `meta` kept: paging needs `meta.total`, which `data` cannot carry. */
async function callWithMeta<T>(
	request: Promise<{ data: ApiResponse<T> }>,
	fallback: string
): Promise<{ data: T; meta: ApiResponse<T>["meta"] }> {
	try {
		const response = await request;
		return { data: unwrap(response, fallback), meta: response.data.meta };
	} catch (err) {
		if (isAxiosError(err)) throw new Error(err.response?.data?.error?.message || fallback);
		throw err;
	}
}

// ============================================================================
// GRANTS
// ============================================================================

export const getGrants = async (): Promise<FieldPurchaseGrant[]> => {
	return call(
		api.get<ApiResponse<FieldPurchaseGrant[]>>("/field-purchases/grants"),
		"Failed to load authorizations"
	);
};

export const upsertGrant = async (data: UpsertGrantInput): Promise<FieldPurchaseGrant> => {
	const parsed = grantSchema.parse(data);
	return call(
		api.post<ApiResponse<FieldPurchaseGrant>>("/field-purchases/grants", parsed),
		"Failed to save authorization"
	);
};

export const revokeGrant = async (
	id: string,
	reason?: string | null
): Promise<FieldPurchaseGrant> => {
	return call(
		api.post<ApiResponse<FieldPurchaseGrant>>(`/field-purchases/grants/${id}/revoke`, {
			reason: reason ?? null,
		}),
		"Failed to revoke authorization"
	);
};

// ============================================================================
// TECHNICIAN PRE-FLIGHT
// ============================================================================

export const getMyAuthority = async (): Promise<MyFieldPurchaseAuthority> => {
	return call(
		api.get<ApiResponse<MyFieldPurchaseAuthority>>("/field-purchases/my-grant"),
		"Failed to load your purchase authority"
	);
};

/** Answers "may I spend this, and will it need pre-approval?" before the counter. */
/** POST for a body, not because it writes: a split asks about every job at once. */
export const checkLimit = async (
	amount: number,
	jobs?: { job_id: string; amount: number }[],
	/** The purchase being checked, so its own counted spend is left out. */
	purchaseId?: string
): Promise<LimitCheckResult> => {
	return call(
		api.post<ApiResponse<LimitCheckResult>>("/field-purchases/limit-check", {
			amount,
			...(jobs?.length ? { jobs } : {}),
			...(purchaseId ? { purchase_id: purchaseId } : {}),
		}),
		"Failed to check your limit"
	);
};

// ============================================================================
// PURCHASES
// ============================================================================

export const getPurchases = async (
	params: ListPurchasesParams = {}
): Promise<FieldPurchasePage> => {
	const { data: items, meta } = await callWithMeta(
		api.get<ApiResponse<FieldPurchase[]>>("/field-purchases", {
			params: queryParams({
				status: params.status,
				technician_id: params.technician_id,
				job_id: params.job_id,
				flagged: params.flagged,
				kind: params.kind,
				search: params.search,
				date_from: params.date_from,
				date_to: params.date_to,
				sort: params.sort,
				offset: params.offset,
				limit: params.limit,
			}),
		}),
		"Failed to load purchases"
	);
	// An older server that does not send `total` is not truncating either.
	return { items, total: meta?.total ?? items.length };
};

export const getPurchasesSummary = async (): Promise<FieldPurchaseSummary> => {
	return call(
		api.get<ApiResponse<FieldPurchaseSummary>>("/field-purchases/summary"),
		"Failed to load the field purchase summary"
	);
};

export const getPurchase = async (id: string): Promise<FieldPurchaseDetail> => {
	return call(
		api.get<ApiResponse<FieldPurchaseDetail>>(`/field-purchases/${id}`),
		"Failed to load purchase"
	);
};

/** The receipt's own reading, kept whether or not the purchase took it. */
export const getExtraction = async (id: string): Promise<FieldPurchaseExtraction> => {
	return call(
		api.get<ApiResponse<FieldPurchaseExtraction>>(`/field-purchases/${id}/extraction`),
		"Failed to load what the receipt read"
	);
};

/**
 * The captured coordinates, fetched only when a reviewer asks to compare them
 * against the vendor. 403s without `view_field_purchase_location`.
 */
export const getCaptureLocation = async (id: string): Promise<FieldPurchaseCaptureLocation> => {
	return call(
		api.get<ApiResponse<FieldPurchaseCaptureLocation>>(
			`/field-purchases/${id}/capture-location`
		),
		"Failed to load where the receipt was photographed"
	);
};

export const createPurchase = async (data: CreatePurchaseInput): Promise<FieldPurchase> => {
	const parsed = createPurchaseSchema.parse(data);
	return call(
		api.post<ApiResponse<FieldPurchase>>("/field-purchases", parsed),
		"Failed to start purchase"
	);
};

export const deletePurchase = async (id: string): Promise<void> => {
	await call(
		api.delete<ApiResponse<{ deleted: boolean }>>(`/field-purchases/${id}`),
		"Failed to delete purchase"
	);
};

/** A reviewer correcting which job one line served. The charge moves with it. */
export const assignLineJob = async (
	id: string,
	lineId: string,
	jobId: string
): Promise<FieldPurchase> => {
	return call(
		api.patch<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/lines/${lineId}/job`, {
			job_id: jobId,
		}),
		"Failed to move that line to another job"
	);
};

/** Links a supplier onto a purchase of any status — unlike editing the sheet, not locked once decided. */
export const linkSupplier = async (id: string, supplierId: string): Promise<FieldPurchase> => {
	return call(
		api.patch<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/supplier`, {
			supplier_id: supplierId,
		}),
		"Failed to link that supplier"
	);
};

export const uploadReceipt = async (
	id: string,
	capture: ReceiptCapture
): Promise<FieldPurchase> => {
	const form = new FormData();
	form.append("image", capture.file);
	if (capture.captured_at) form.append("captured_at", capture.captured_at);
	if (capture.capture_lat != null) form.append("capture_lat", String(capture.capture_lat));
	if (capture.capture_lng != null) form.append("capture_lng", String(capture.capture_lng));
	if (capture.capture_accuracy_m != null) {
		form.append("capture_accuracy_m", String(Math.round(capture.capture_accuracy_m)));
	}
	return call(
		api.post<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/receipt`, form, {
			headers: { "Content-Type": "multipart/form-data" },
		}),
		"Failed to upload receipt"
	);
};

export const requestPreauth = async (
	id: string,
	estimatedAmount: number,
	reason?: string | null,
	sheet?: SubmitSheetInput
): Promise<FieldPurchase> => {
	return call(
		api.post<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/preauth`, {
			estimated_amount: positiveMoney.parse(estimatedAmount),
			reason: reason ?? null,
			// Not validated here the way submit's sheet is: this button is
			// deliberately ungated on a finished sheet, so the caller decides what's
			// safe to send (see TechnicianPurchaseDetailPage's onRequestPreauth).
			...(sheet && { sheet }),
		}),
		"Failed to request pre-approval"
	);
};

export const decidePreauth = async (
	id: string,
	approve: boolean,
	note?: string | null
): Promise<FieldPurchase> => {
	return call(
		api.post<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/preauth-decision`, {
			approve,
			note: note ?? null,
		}),
		"Failed to record the decision"
	);
};

/** Re-reads the receipt already in storage; the tech never re-photographs it. */
export const retryOcr = async (id: string): Promise<void> => {
	await call(
		api.post<ApiResponse<{ started: boolean }>>(`/field-purchases/${id}/ocr/retry`, {}),
		"Could not start reading the receipt"
	);
};

const submitSheetSchema = z.object({
	vendor_name: z.string().max(120).nullable().optional(),
	purchased_at: z.string().optional(),
	tax_amount: money.optional(),
	total: money.optional(),
	// Sent only when the split has more than one job; a single-job purchase is
	// rebalanced to its own total server-side.
	allocations: z.array(allocationSchema).optional(),
	lines: z.array(lineSchema).max(100).optional(),
});

export type SubmitSheetInput = z.input<typeof submitSheetSchema>;

/**
 * The sheet and the submit are one call, so a receipt survives one round trip
 * instead of three, and the confirmations a technician gives per line arrive
 * atomically with everything else instead of racing a separate lines save.
 */
export const submitPurchase = async (
	id: string,
	sheet?: SubmitSheetInput
): Promise<SubmitResult> => {
	const body = sheet ? submitSheetSchema.parse(sheet) : {};
	return call(
		api.post<ApiResponse<SubmitResult>>(`/field-purchases/${id}/submit`, body),
		"Failed to submit purchase"
	);
};

/** For the technician who can reach the flow but has no ceiling to spend under. */
export const requestGrant = async (): Promise<void> => {
	await call(
		api.post<ApiResponse<{ requested: true }>>("/field-purchases/my-grant/request", {}),
		"Could not send the request"
	);
};

export const secondSignoff = async (
	id: string,
	approve: boolean,
	note?: string | null
): Promise<FieldPurchase> => {
	return call(
		api.post<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/second-signoff`, {
			approve,
			note: note ?? null,
		}),
		"Failed to record the sign-off"
	);
};

export const createRefund = async (
	parentPurchaseId: string,
	reason?: string | null
): Promise<FieldPurchase> => {
	return call(
		api.post<ApiResponse<FieldPurchase>>("/field-purchases/refunds", {
			parent_purchase_id: parentPurchaseId,
			reason: reason ?? null,
		}),
		"Failed to start the refund"
	);
};

/** Asserts the money actually came back, which is days after the approval. */
export const settleRefund = async (id: string): Promise<FieldPurchase> => {
	return call(
		api.post<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/settle`, {}),
		"Failed to settle the refund"
	);
};

export const reviewPurchase = async (
	id: string,
	decision: "approve" | "query" | "reject",
	note?: string | null
): Promise<FieldPurchase> => {
	return call(
		api.post<ApiResponse<FieldPurchase>>(`/field-purchases/${id}/review`, {
			decision,
			note: note ?? null,
		}),
		"Failed to record the review"
	);
};
