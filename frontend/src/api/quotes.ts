import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	Quote,
	CreateQuoteInput,
	UpdateQuoteInput,
	QuoteLineItem,
	CreateQuoteLineItemInput,
	UpdateQuoteLineItemInput,
	QuoteNote,
	CreateQuoteNoteInput,
	UpdateQuoteNoteInput,
	QuoteStatistics,
} from "../types/quotes";


// ============================================================================
// QUOTE API
// ============================================================================

export const getAllQuotes = async (): Promise<Quote[]> => {
	const response = await api.get<ApiResponse<Quote[]>>("/quotes");
	return response.data.data || [];
};

export const getQuoteById = async (id: string): Promise<Quote> => {
	const response = await api.get<ApiResponse<Quote>>(`/quotes/${id}`);

	if (!response.data.data) {
		throw new Error("Quote not found");
	}

	return response.data.data;
};

export const getQuotesByClientId = async (clientId: string): Promise<Quote[]> => {
	const response = await api.get<ApiResponse<Quote[]>>(`/clients/${clientId}/quotes`);
	return response.data.data || [];
};

export const getQuotesByRequestId = async (requestId: string): Promise<Quote[]> => {
	const response = await api.get<ApiResponse<Quote[]>>(`/requests/${requestId}/quotes`);
	return response.data.data || [];
};

export const createQuote = async (input: CreateQuoteInput): Promise<Quote> => {
	const response = await api.post<ApiResponse<Quote>>("/quotes", input);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create quote");
	}

	return response.data.data!;
};

export const updateQuote = async (id: string, data: UpdateQuoteInput): Promise<Quote> => {
	const response = await api.put<ApiResponse<Quote>>(`/quotes/${id}`, data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update quote");
	}

	return response.data.data!;
};

export const deleteQuote = async (id: string, hardDelete?: boolean): Promise<{ id: string }> => {
	const url = hardDelete ? `/quotes/${id}?hard_delete=true` : `/quotes/${id}`;
	const response = await api.delete<ApiResponse<{ id: string }>>(url);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete quote");
	}

	return response.data.data || { id };
};

// ============================================================================
// QUOTE ACTIONS
// ============================================================================

export const sendQuote = async (id: string, recipientEmail: string): Promise<Quote> => {
	const response = await api.post<ApiResponse<Quote>>(`/quotes/${id}/send`, {
		recipient_email: recipientEmail,
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to send quote");
	}

	return response.data.data!;
};

export const rejectQuote = async (id: string, rejectionReason?: string): Promise<Quote> => {
	const response = await api.post<ApiResponse<Quote>>(`/quotes/${id}/reject`, {
		rejection_reason: rejectionReason,
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to reject quote");
	}

	return response.data.data!;
};

/**
 * Supersedes a quote with a fresh revision. Bodyless: the server decides what
 * the replacement contains, and which statuses may be revised from.
 */
export const reviseQuote = async (id: string): Promise<{ id: string; quote_number: string }> => {
	const response = await api.post<ApiResponse<{ id: string; quote_number: string }>>(
		`/quotes/${id}/revise`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to revise quote");
	}

	return response.data.data!;
};

export const cancelQuote = async (id: string, reason?: string): Promise<Quote> => {
	const response = await api.post<ApiResponse<Quote>>(`/quotes/${id}/cancel`, {
		reason: reason,
	});

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to cancel quote");
	}

	return response.data.data!;
};

// ============================================================================
// QUOTE LINE ITEMS API
// ============================================================================

export const getQuoteLineItems = async (quoteId: string): Promise<QuoteLineItem[]> => {
	const response = await api.get<ApiResponse<QuoteLineItem[]>>(
		`/quotes/${quoteId}/line-items`
	);
	return response.data.data || [];
};

export const addLineItem = async (
	quoteId: string,
	data: CreateQuoteLineItemInput
): Promise<QuoteLineItem> => {
	const response = await api.post<ApiResponse<QuoteLineItem>>(
		`/quotes/${quoteId}/line-items`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to add line item");
	}

	return response.data.data!;
};

export const updateLineItem = async (
	quoteId: string,
	lineItemId: string,
	data: UpdateQuoteLineItemInput
): Promise<QuoteLineItem> => {
	const response = await api.put<ApiResponse<QuoteLineItem>>(
		`/quotes/${quoteId}/line-items/${lineItemId}`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update line item");
	}

	return response.data.data!;
};

export const deleteLineItem = async (
	quoteId: string,
	lineItemId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/quotes/${quoteId}/line-items/${lineItemId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete line item");
	}

	return response.data.data || { message: "Line item deleted successfully" };
};

// ============================================================================
// QUOTE NOTES API
// ============================================================================

export const getQuoteNotes = async (quoteId: string): Promise<QuoteNote[]> => {
	const response = await api.get<ApiResponse<QuoteNote[]>>(`/quotes/${quoteId}/notes`);
	return response.data.data || [];
};

export const getQuoteNoteById = async (quoteId: string, noteId: string): Promise<QuoteNote> => {
	const response = await api.get<ApiResponse<QuoteNote>>(
		`/quotes/${quoteId}/notes/${noteId}`
	);

	if (!response.data.data) {
		throw new Error("Quote note not found");
	}

	return response.data.data;
};

export const createQuoteNote = async (
	quoteId: string,
	data: CreateQuoteNoteInput
): Promise<QuoteNote> => {
	const response = await api.post<ApiResponse<QuoteNote>>(`/quotes/${quoteId}/notes`, data);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to create quote note");
	}

	return response.data.data!;
};

export const updateQuoteNote = async (
	quoteId: string,
	noteId: string,
	data: UpdateQuoteNoteInput
): Promise<QuoteNote> => {
	const response = await api.put<ApiResponse<QuoteNote>>(
		`/quotes/${quoteId}/notes/${noteId}`,
		data
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to update quote note");
	}

	return response.data.data!;
};

export const deleteQuoteNote = async (
	quoteId: string,
	noteId: string
): Promise<{ message: string }> => {
	const response = await api.delete<ApiResponse<{ message: string }>>(
		`/quotes/${quoteId}/notes/${noteId}`
	);

	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to delete quote note");
	}

	return response.data.data || { message: "Quote note deleted successfully" };
};

// ============================================================================
// QUOTE PDF
// ============================================================================

export const downloadQuotePdf = async (id: string, quoteNumber: string): Promise<void> => {
	const response = await api.get(`/quotes/${id}/pdf`, { responseType: "blob" });
	const url = URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
	const a = document.createElement("a");
	a.href = url;
	a.download = `${quoteNumber}.pdf`;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
};

// ============================================================================
// QUOTE STATISTICS API
// ============================================================================

export const getQuoteStatistics = async (clientId?: string): Promise<QuoteStatistics> => {
	const url = clientId ? `/quotes/statistics?client_id=${clientId}` : "/quotes/statistics";
	const response = await api.get<ApiResponse<QuoteStatistics>>(url);

	if (!response.data.data) {
		throw new Error("Failed to fetch quote statistics");
	}

	return response.data.data;
};
