import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	Invoice,
	CreateInvoiceInput,
	UpdateInvoiceInput,
	InvoicePayment,
	CreateInvoicePaymentInput,
	RecordRefundInput,
	InvoiceNote,
	CreateInvoiceNoteInput,
	UpdateInvoiceNoteInput,
	OverlapWarning,
	GenerateInvoiceInput,
	GenerateInvoiceResponse,
} from "../types/invoices";

// ============================================================================
// INVOICE API
// ============================================================================

export const getAllInvoices = async (): Promise<Invoice[]> => {
	const response = await api.get<ApiResponse<Invoice[]>>("/invoices");
	return response.data.data || [];
};

export const getInvoiceById = async (id: string): Promise<Invoice> => {
	if (!id) throw new Error("Invoice ID is required");

	const response = await api.get<ApiResponse<Invoice>>(`/invoices/${id}`);

	if (!response.data.data) throw new Error("Invoice not found");

	return response.data.data;
};

export const getInvoicesByClientId = async (clientId: string): Promise<Invoice[]> => {
	const response = await api.get<ApiResponse<Invoice[]>>(`/clients/${clientId}/invoices`);
	return response.data.data || [];
};

export const getInvoicesByJobId = async (jobId: string): Promise<Invoice[]> => {
	const response = await api.get<ApiResponse<Invoice[]>>(`/jobs/${jobId}/invoices`);
	return response.data.data || [];
};

export const getInvoicesByVisitId = async (jobId: string, visitId: string): Promise<Invoice[]> => {
	const response = await api.get<ApiResponse<Invoice[]>>(`/jobs/${jobId}/visits/${visitId}/invoices`);
	return response.data.data || [];
};

export const sendInvoice = async (id: string, recipientEmail: string): Promise<Invoice> => {
	const response = await api.post<ApiResponse<Invoice>>(`/invoices/${id}/send`, {
		recipient_email: recipientEmail,
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to send invoice");
	}

	return response.data.data!;
};

export const createInvoice = async (input: CreateInvoiceInput): Promise<Invoice> => {
	const response = await api.post<ApiResponse<Invoice>>("/invoices", input);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create invoice");
	}

	return response.data.data!;
};

export const updateInvoice = async (id: string, updates: UpdateInvoiceInput): Promise<Invoice> => {
	const response = await api.patch<ApiResponse<Invoice>>(`/invoices/${id}`, updates);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update invoice");
	}

	return response.data.data!;
};

export const deleteInvoice = async (id: string): Promise<{ id: string }> => {
	const response = await api.delete<ApiResponse<{ id: string }>>(`/invoices/${id}`);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete invoice");
	}

	return response.data.data || { id };
};

// ============================================================================
// PAYMENT API
// ============================================================================

export const getInvoicePayments = async (invoiceId: string): Promise<InvoicePayment[]> => {
	const response = await api.get<ApiResponse<InvoicePayment[]>>(
		`/invoices/${invoiceId}/payments`
	);
	return response.data.data || [];
};

export const createInvoicePayment = async (
	invoiceId: string,
	input: CreateInvoicePaymentInput
): Promise<InvoicePayment> => {
	const response = await api.post<ApiResponse<InvoicePayment>>(
		`/invoices/${invoiceId}/payments`,
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to record payment");
	}

	return response.data.data!;
};

export const deleteInvoicePayment = async (
	invoiceId: string,
	paymentId: string
): Promise<{ id: string }> => {
	const response = await api.delete<ApiResponse<{ id: string }>>(
		`/invoices/${invoiceId}/payments/${paymentId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete payment");
	}

	return response.data.data || { id: paymentId };
};

/**
 * Records a refund as a negative payment row. `amount` is sent positive — the
 * sign is the backend's business. The refundable ceiling is enforced there and
 * comes back as a 422 naming the amount actually paid.
 */
export const recordRefund = async (
	invoiceId: string,
	input: RecordRefundInput
): Promise<InvoicePayment> => {
	const response = await api.post<ApiResponse<InvoicePayment>>(
		`/invoices/${invoiceId}/refunds`,
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to record refund");
	}

	return response.data.data!;
};

// ============================================================================
// NOTE API
// ============================================================================

export const getInvoiceNotes = async (invoiceId: string): Promise<InvoiceNote[]> => {
	const response = await api.get<ApiResponse<InvoiceNote[]>>(`/invoices/${invoiceId}/notes`);
	return response.data.data || [];
};

export const createInvoiceNote = async (
	invoiceId: string,
	input: CreateInvoiceNoteInput
): Promise<InvoiceNote> => {
	const response = await api.post<ApiResponse<InvoiceNote>>(
		`/invoices/${invoiceId}/notes`,
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create note");
	}

	return response.data.data!;
};

export const updateInvoiceNote = async (
	invoiceId: string,
	noteId: string,
	input: UpdateInvoiceNoteInput
): Promise<InvoiceNote> => {
	const response = await api.put<ApiResponse<InvoiceNote>>(
		`/invoices/${invoiceId}/notes/${noteId}`,
		input
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update note");
	}

	return response.data.data!;
};

// ============================================================================
// INVOICE PDF
// ============================================================================

export const downloadInvoicePdf = async (id: string, invoiceNumber: string): Promise<void> => {
	const response = await api.get(`/invoices/${id}/pdf`, { responseType: "blob" });
	const url = URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = `${invoiceNumber}.pdf`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
};

export const deleteInvoiceNote = async (
	invoiceId: string,
	noteId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/invoices/${invoiceId}/notes/${noteId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete note");
	}

	return response.data.data || { message: "Note deleted successfully" };
};

// ============================================================================
// PIPELINE API
// ============================================================================

export const overlapCheck = async (
	visitIds: string[],
): Promise<{ warnings: OverlapWarning[] }> => {
	const response = await api.post<ApiResponse<{ warnings: OverlapWarning[] }>>(
		"/invoices/overlap-check",
		{ visit_ids: visitIds },
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Overlap check failed");
	}
	return response.data.data!;
};

export const generateInvoice = async (
	input: GenerateInvoiceInput,
): Promise<GenerateInvoiceResponse> => {
	const response = await api.post<ApiResponse<GenerateInvoiceResponse>>(
		"/invoices/generate",
		input,
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to generate invoice");
	}
	return response.data.data!;
};
