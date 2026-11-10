import { useMutation, useQueryClient } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import {
	getAllQuotes,
	getQuoteById,
	getQuotesByClientId,
	getQuotesByRequestId,
	createQuote,
	updateQuote,
	deleteQuote,
	sendQuote,
	rejectQuote,
	reviseQuote,
	cancelQuote,
	addLineItem,
	updateLineItem,
	deleteLineItem,
	getQuoteNotes,
	createQuoteNote,
	updateQuoteNote,
	deleteQuoteNote,
	getQuoteStatistics,
} from "../api/quotes";
import type {
	CreateQuoteInput,
	UpdateQuoteInput,
	CreateQuoteLineItemInput,
	UpdateQuoteLineItemInput,
	CreateQuoteNoteInput,
	UpdateQuoteNoteInput,
} from "../types/quotes";

const useQuery = moduleQuery("quotes");

// ============================================================================
// Queries
// ============================================================================

export const useAllQuotesQuery = () => {
	return useQuery({
		queryKey: ["quotes"],
		queryFn: getAllQuotes,
	});
};

export const useQuoteByIdQuery = (id: string) => {
	return useQuery({
		queryKey: ["quotes", id],
		queryFn: () => getQuoteById(id),
		enabled: !!id,
	});
};

export const useQuotesByClientIdQuery = (clientId: string) => {
	return useQuery({
		queryKey: ["clients", clientId, "quotes"],
		queryFn: () => getQuotesByClientId(clientId),
		enabled: !!clientId,
	});
};

export const useQuotesByRequestIdQuery = (requestId: string) => {
	return useQuery({
		queryKey: ["requests", requestId, "quotes"],
		queryFn: () => getQuotesByRequestId(requestId),
		enabled: !!requestId,
	});
};

export const useQuoteNotesQuery = (quoteId: string) => {
	return useQuery({
		queryKey: ["quotes", quoteId, "notes"],
		queryFn: () => getQuoteNotes(quoteId),
		enabled: !!quoteId,
	});
};

export const useQuoteStatisticsQuery = (clientId?: string) => {
	return useQuery({
		queryKey: ["quotes", "statistics", clientId],
		queryFn: () => getQuoteStatistics(clientId),
	});
};

// ============================================================================
// Mutations - Quote CRUD
// ============================================================================

export const useCreateQuoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (input: CreateQuoteInput) => createQuote(input),
		onSuccess: (newQuote) => {
			queryClient.invalidateQueries({ queryKey: ["quotes"] });

			if (newQuote.client_id) {
				queryClient.invalidateQueries({
					queryKey: ["clients", newQuote.client_id, "quotes"],
				});

				queryClient.invalidateQueries({
					queryKey: ["clients", newQuote.client_id],
				});
				queryClient.invalidateQueries({
					queryKey: ["clients"],
				});
			}

			if (newQuote.request_id) {
				queryClient.invalidateQueries({
					queryKey: ["requests", newQuote.request_id, "quotes"],
				});

				queryClient.invalidateQueries({
					queryKey: ["requests", newQuote.request_id],
				});

				queryClient.invalidateQueries({
					queryKey: ["requests"],
				});
			}

			queryClient.setQueryData(["quotes", newQuote.id], newQuote);
			queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
	});
};

export const useUpdateQuoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateQuoteInput }) =>
			updateQuote(id, data),
		onSuccess: (updatedQuote) => {
			queryClient.invalidateQueries({ queryKey: ["quotes"] });

			if (updatedQuote.client_id) {
				queryClient.invalidateQueries({
					queryKey: ["clients", updatedQuote.client_id, "quotes"],
				});
			}

			if (updatedQuote.request_id) {
				queryClient.invalidateQueries({
					queryKey: ["requests", updatedQuote.request_id, "quotes"],
				});
			}

			queryClient.setQueryData(["quotes", updatedQuote.id], updatedQuote);
			// Status changes (e.g. "Create Without Sending" Draft -> Issued) can
			// flip whether a dispute is openable; the disabled reason on "Open
			// Dispute" is read from this cache, same as useUpdateInvoiceMutation.
			queryClient.invalidateQueries({ queryKey: ["disputes", "quote", updatedQuote.id] });
		},
	});
};

export const useDeleteQuoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, hardDelete }: { id: string; hardDelete?: boolean }) =>
			deleteQuote(id, hardDelete),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({ queryKey: ["quotes"] });

			queryClient.removeQueries({ queryKey: ["quotes", variables.id] });
		},
	});
};

// ============================================================================
// Mutations - Quote Actions
// ============================================================================

export const useSendQuoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, recipientEmail }: { id: string; recipientEmail: string }) =>
			sendQuote(id, recipientEmail),
		onSuccess: (updatedQuote) => {
			queryClient.setQueryData(["quotes", updatedQuote.id], updatedQuote);
			queryClient.invalidateQueries({ queryKey: ["quotes"] });

			if (updatedQuote.client_id) {
				queryClient.invalidateQueries({
					queryKey: ["clients", updatedQuote.client_id, "quotes"],
				});
			}

			if (updatedQuote.request_id) {
				queryClient.invalidateQueries({
					queryKey: ["requests", updatedQuote.request_id, "quotes"],
				});
			}

			queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			queryClient.invalidateQueries({ queryKey: ["disputes", "quote", updatedQuote.id] });
		},
		// A draft is finalized before the email goes out, so a failed send can still have
		// moved it to Created.
		onError: (_err, { id }) => {
			queryClient.invalidateQueries({ queryKey: ["quotes", id] });
		},
	});
};

export const useRejectQuoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, rejectionReason }: { id: string; rejectionReason?: string }) =>
			rejectQuote(id, rejectionReason),
		onSuccess: (updatedQuote) => {
			queryClient.invalidateQueries({
				queryKey: ["quotes", updatedQuote.id],
			});
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			// Both Rejected and Cancelled are lost buckets in the funnel and
			// drop out of the pipeline's OPEN_STATUSES, so the reports move.
			queryClient.invalidateQueries({ queryKey: ["reports"] });
			queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			queryClient.invalidateQueries({ queryKey: ["disputes", "quote", updatedQuote.id] });
		},
	});
};

export const useReviseQuoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id }: { id: string }) => reviseQuote(id),
		onSuccess: (_replacement, { id }) => {
			// The original moves to Revised and a new quote appears, so both
			// the detail and every list have to refresh.
			queryClient.invalidateQueries({ queryKey: ["quotes", id] });
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			// Revising an approved quote pushes its request back to Quoted,
			// and Revised leaves the funnel's open statuses. The client- and
			// request-scoped quote lists (["clients", cid, "quotes"] etc.) are
			// reached by these prefixes — create/update/delete invalidate the
			// same pair, and the rewrite of this hook had dropped them (DW-28).
			queryClient.invalidateQueries({ queryKey: ["requests"] });
			queryClient.invalidateQueries({ queryKey: ["clients"] });
			queryClient.invalidateQueries({ queryKey: ["reports"] });
			queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			queryClient.invalidateQueries({ queryKey: ["disputes", "quote", id] });
		},
	});
};

export const useCancelQuoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, reason }: { id: string; reason?: string }) => cancelQuote(id, reason),
		onSuccess: (updatedQuote) => {
			queryClient.invalidateQueries({
				queryKey: ["quotes", updatedQuote.id],
			});
			queryClient.invalidateQueries({ queryKey: ["quotes"] });
			// Both Rejected and Cancelled are lost buckets in the funnel and
			// drop out of the pipeline's OPEN_STATUSES, so the reports move.
			queryClient.invalidateQueries({ queryKey: ["reports"] });
			queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
			queryClient.invalidateQueries({ queryKey: ["disputes", "quote", updatedQuote.id] });
		},
	});
};

// ============================================================================
// Mutations - Line Items
// ============================================================================

export const useAddLineItemMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			quoteId,
			data,
		}: {
			quoteId: string;
			data: CreateQuoteLineItemInput;
		}) => addLineItem(quoteId, data),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["quotes", variables.quoteId],
			});
		},
	});
};

export const useUpdateLineItemMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			quoteId,
			lineItemId,
			data,
		}: {
			quoteId: string;
			lineItemId: string;
			data: UpdateQuoteLineItemInput;
		}) => updateLineItem(quoteId, lineItemId, data),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["quotes", variables.quoteId],
			});
		},
	});
};

export const useDeleteLineItemMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ quoteId, lineItemId }: { quoteId: string; lineItemId: string }) =>
			deleteLineItem(quoteId, lineItemId),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["quotes", variables.quoteId],
			});
		},
	});
};

// ============================================================================
// Mutations - Notes
// ============================================================================

export const useCreateQuoteNoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ quoteId, data }: { quoteId: string; data: CreateQuoteNoteInput }) =>
			createQuoteNote(quoteId, data),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["quotes", variables.quoteId, "notes"],
			});
			queryClient.invalidateQueries({
				queryKey: ["quotes", variables.quoteId],
			});
		},
	});
};

export const useUpdateQuoteNoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			quoteId,
			noteId,
			data,
		}: {
			quoteId: string;
			noteId: string;
			data: UpdateQuoteNoteInput;
		}) => updateQuoteNote(quoteId, noteId, data),
		onSuccess: async (_, variables) => {
			await queryClient.invalidateQueries({
				queryKey: ["quotes", variables.quoteId, "notes"],
			});
		},
	});
};

export const useDeleteQuoteNoteMutation = () => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ quoteId, noteId }: { quoteId: string; noteId: string }) =>
			deleteQuoteNote(quoteId, noteId),
		onSuccess: (_, variables) => {
			queryClient.invalidateQueries({
				queryKey: ["quotes", variables.quoteId, "notes"],
			});
		},
	});
};
