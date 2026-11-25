import {
	useMutation,
	useQuery,
	useQueryClient,
	type UseMutationResult,
	type UseQueryResult,
} from "@tanstack/react-query";
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
	GenerateInvoiceInput,
	GenerateInvoiceResponse,
	OverlapWarning,
} from "../types/invoices";
import * as invoiceApi from "../api/invoices";
import { qk } from "../lib/queryKeys";

// ============================================================================
// INVOICE QUERIES
// ============================================================================

// Under the invoices prefix so every invoice mutation and the record:changed socket refresh it.
export const useInvoicesSummaryQuery = (): UseQueryResult<invoiceApi.InvoicesSummary, Error> => {
	return useQuery({
		queryKey: [...qk.invoices.all, "summary"],
		queryFn: invoiceApi.getInvoicesSummary,
	});
};

export const useInvoiceByIdQuery = (id: string): UseQueryResult<Invoice, Error> => {
	return useQuery({
		queryKey: ["invoices", id],
		queryFn: () => invoiceApi.getInvoiceById(id),
		enabled: !!id,
	});
};

export const useInvoicesByClientIdQuery = (clientId: string): UseQueryResult<Invoice[], Error> => {
	return useQuery({
		queryKey: ["clients", clientId, "invoices"],
		queryFn: () => invoiceApi.getInvoicesByClientId(clientId),
		enabled: !!clientId,
	});
};

export const useInvoicesByJobIdQuery = (jobId: string): UseQueryResult<Invoice[], Error> => {
	return useQuery({
		queryKey: ["jobs", jobId, "invoices"],
		queryFn: () => invoiceApi.getInvoicesByJobId(jobId),
		enabled: !!jobId,
	});
};

export const useInvoicesByVisitIdQuery = (jobId: string, visitId: string): UseQueryResult<Invoice[], Error> => {
	return useQuery({
		queryKey: ["jobs", jobId, "visits", visitId, "invoices"],
		queryFn: () => invoiceApi.getInvoicesByVisitId(jobId, visitId),
		enabled: !!jobId && !!visitId,
	});
};

// ============================================================================
// INVOICE MUTATIONS
// ============================================================================

export const useCreateInvoiceMutation = (): UseMutationResult<
	Invoice,
	Error,
	CreateInvoiceInput
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: invoiceApi.createInvoice,
		onSuccess: (newInvoice) => {
			// Invalidate list views so the new invoice appears
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			void queryClient.invalidateQueries({
				queryKey: ["clients", newInvoice.client_id, "invoices"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["clients", newInvoice.client_id],
			});

			if (newInvoice.recurring_plan_id) {
				void queryClient.invalidateQueries({
					queryKey: ["recurringPlans", newInvoice.recurring_plan_id],
				});
			}

			// Invalidate job and visit caches so billing badges and "Billed on"
			// sections refresh without a manual page reload.
			for (const ij of newInvoice.jobs ?? []) {
				void queryClient.invalidateQueries({ queryKey: ["jobs", ij.job.id] });
				void queryClient.invalidateQueries({ queryKey: ["jobs", ij.job.id, "visits"] });
				void queryClient.invalidateQueries({ queryKey: ["jobs", ij.job.id, "invoices"] });
			}
			for (const iv of newInvoice.visits ?? []) {
				void queryClient.invalidateQueries({ queryKey: ["jobVisits", iv.visit.id] });
			}
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });

			// Prime the detail cache so navigating to the invoice is instant
			queryClient.setQueryData(["invoices", newInvoice.id], newInvoice);
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
	});
};

export const useUpdateInvoiceMutation = (): UseMutationResult<
	Invoice,
	Error,
	{ id: string; updates: UpdateInvoiceInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, updates }) => invoiceApi.updateInvoice(id, updates),
		onSuccess: (updatedInvoice, variables) => {
			// No setQueryData: the PATCH response is narrower than the detail GET and predates the tax lock, so the detail refetch is the source of truth.
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.id],
			});
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			void queryClient.invalidateQueries({
				queryKey: ["clients", updatedInvoice.client_id, "invoices"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["clients", updatedInvoice.client_id],
			});
			// Voiding an adjustment reopens outcomes on the invoice it adjusts,
			// and those arrive with that invoice's disputes.
			void queryClient.invalidateQueries({ queryKey: ["disputes"] });

			// If the invoice is linked to a recurring plan, the plan summary
			// may show derived financials that need to refresh.
			if (updatedInvoice.recurring_plan_id) {
				void queryClient.invalidateQueries({
					queryKey: [
						"recurringPlans",
						updatedInvoice.recurring_plan_id,
					],
				});
			}
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
	});
};

export const useDeleteInvoiceMutation = (): UseMutationResult<
	{ id: string },
	Error,
	{ id: string; clientId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id }) => invoiceApi.deleteInvoice(id),
		onSuccess: (_, variables) => {
			// Remove the detail entry first so any in-flight navigations get a
			// clean miss rather than serving a deleted invoice briefly
			queryClient.removeQueries({ queryKey: ["invoices", variables.id] });

			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId, "invoices"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["clients", variables.clientId],
			});
		},
	});
};

// ============================================================================
// PAYMENT QUERIES
// ============================================================================

export const useInvoicePaymentsQuery = (
	invoiceId: string
): UseQueryResult<InvoicePayment[], Error> => {
	return useQuery({
		queryKey: ["invoices", invoiceId, "payments"],
		queryFn: () => invoiceApi.getInvoicePayments(invoiceId),
		enabled: !!invoiceId,
	});
};

// ============================================================================
// PAYMENT MUTATIONS
// ============================================================================

export const useCreateInvoicePaymentMutation = (): UseMutationResult<
	InvoicePayment,
	Error,
	{ invoiceId: string; data: CreateInvoicePaymentInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ invoiceId, data }) =>
			invoiceApi.createInvoicePayment(invoiceId, data),
		onSuccess: (_, variables) => {
			// Payment creation triggers backend recalc of amount_paid / balance_due
			// / status on the parent invoice. Invalidate the full invoice so the
			// InvoiceDetailPage re-fetches with updated totals and status badge.
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId],
			});
			// Invalidate the list so payment progress / status is current in
			// the invoices table view as well.
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			// Money applied mid-dispute closes both voiding outcomes (D7).
			void queryClient.invalidateQueries({
				queryKey: ["disputes", "invoice", variables.invoiceId],
			});
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
	});
};

export const useDeleteInvoicePaymentMutation = (): UseMutationResult<
	{ id: string },
	Error,
	{ invoiceId: string; paymentId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ invoiceId, paymentId }) =>
			invoiceApi.deleteInvoicePayment(invoiceId, paymentId),
		onSuccess: (_, variables) => {
			// Same as create — backend resyncs amount_paid / balance_due / status.
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId],
			});
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			void queryClient.invalidateQueries({
				queryKey: ["disputes", "invoice", variables.invoiceId],
			});
		},
	});
};

/**
 * A refund writes a negative payment row, so the same caches move as a payment:
 * amount_paid, balance_due and status are all recalculated backend-side and a
 * refunded invoice can fall back out of Paid.
 */
export const useRecordRefundMutation = (): UseMutationResult<
	InvoicePayment,
	Error,
	{ invoiceId: string; data: RecordRefundInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ invoiceId, data }) => invoiceApi.recordRefund(invoiceId, data),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId],
			});
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			void queryClient.invalidateQueries({
				queryKey: ["disputes", "invoice", variables.invoiceId],
			});
			// A refund moves amount_paid and balance_due, which is what every
			// receivables figure is computed from.
			void queryClient.invalidateQueries({ queryKey: ["reports"] });
			void queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
		},
	});
};

// ============================================================================
// NOTE QUERIES
// ============================================================================

export const useInvoiceNotesQuery = (invoiceId: string): UseQueryResult<InvoiceNote[], Error> => {
	return useQuery({
		queryKey: ["invoices", invoiceId, "notes"],
		queryFn: () => invoiceApi.getInvoiceNotes(invoiceId),
		enabled: !!invoiceId,
	});
};

// ============================================================================
// NOTE MUTATIONS
// ============================================================================

export const useCreateInvoiceNoteMutation = (): UseMutationResult<
	InvoiceNote,
	Error,
	{ invoiceId: string; data: CreateInvoiceNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ invoiceId, data }) => invoiceApi.createInvoiceNote(invoiceId, data),
		onSuccess: (_, variables) => {
			// Notes are embedded in the invoice object — invalidate both the
			// standalone notes cache and the parent invoice detail.
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId, "notes"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId],
			});
		},
	});
};

export const useUpdateInvoiceNoteMutation = (): UseMutationResult<
	InvoiceNote,
	Error,
	{ invoiceId: string; noteId: string; data: UpdateInvoiceNoteInput }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ invoiceId, noteId, data }) =>
			invoiceApi.updateInvoiceNote(invoiceId, noteId, data),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId, "notes"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId],
			});
		},
	});
};

export const useDeleteInvoiceNoteMutation = (): UseMutationResult<
	{ message: string },
	Error,
	{ invoiceId: string; noteId: string }
> => {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ invoiceId, noteId }) =>
			invoiceApi.deleteInvoiceNote(invoiceId, noteId),
		onSuccess: (_, variables) => {
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId, "notes"],
			});
			void queryClient.invalidateQueries({
				queryKey: ["invoices", variables.invoiceId],
			});
		},
	});
};

// ============================================================================
// PIPELINE MUTATIONS
// ============================================================================

export const useOverlapCheckMutation = (): UseMutationResult<
	{ warnings: OverlapWarning[] },
	Error,
	string[]
> => {
	return useMutation({
		mutationFn: async (visitIds: string[]) => {
			const result = await invoiceApi.overlapCheck(visitIds);
			return { warnings: result.warnings };
		},
	});
};

export const useGenerateInvoiceMutation = (): UseMutationResult<
	GenerateInvoiceResponse,
	Error,
	GenerateInvoiceInput
> => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: GenerateInvoiceInput) => invoiceApi.generateInvoice(input),
		onSuccess: (data) => {
			queryClient.setQueryData(["invoices", data.invoice.id], data.invoice);
			void queryClient.invalidateQueries({ queryKey: ["invoices"] });
			if (data.invoice.recurring_plan_id) {
				void queryClient.invalidateQueries({
					queryKey: ["recurringPlans", data.invoice.recurring_plan_id],
				});
			}
			for (const ij of data.invoice.jobs ?? []) {
				void queryClient.invalidateQueries({ queryKey: ["jobs", ij.job.id] });
				void queryClient.invalidateQueries({ queryKey: ["jobs", ij.job.id, "visits"] });
				void queryClient.invalidateQueries({ queryKey: ["jobs", ij.job.id, "invoices"] });
			}
			for (const iv of data.invoice.visits ?? []) {
				void queryClient.invalidateQueries({ queryKey: ["jobVisits", iv.visit.id] });
			}
			void queryClient.invalidateQueries({ queryKey: ["jobs"] });
			void queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
		},
	});
};
