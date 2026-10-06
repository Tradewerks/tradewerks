import { useMutation, useQueryClient } from "@tanstack/react-query";
import { moduleQuery } from "./moduleQuery";
import { getDisputes, getOpenDisputes, openDispute, resolveDispute } from "../api/disputes";
import { useAuthStore } from "../auth/authStore";
import { qk } from "../lib/queryKeys";
import { DISPUTE_VIEW_PERMISSIONS, hasAnyPermission } from "../lib/permissionGates";
import type { DisputeKind, OpenDisputeInput, ResolveDisputeInput } from "../types/disputes";

const useQuery = moduleQuery("disputes");

const disputeKey = (kind: DisputeKind, documentId: string) => ["disputes", kind, documentId];
const documentQueryKey = (kind: DisputeKind) => (kind === "quote" ? "quotes" : "invoices");

export const useDisputesQuery = (kind: DisputeKind, documentId: string) =>
	useQuery({
		queryKey: disputeKey(kind, documentId),
		queryFn: () => getDisputes(kind, documentId),
		enabled: Boolean(documentId),
	});

/**
 * Resolving (or opening) a dispute changes the underlying quote/invoice's status
 * too, so its cache needs to refresh alongside the dispute list. useQuotes.ts's
 * mutations invalidate both the specific detail key (["quotes", id]) and the
 * broad list key (["quotes"]) explicitly rather than relying on prefix-match
 * alone — mirror that convention here for both document kinds.
 */
const invalidateBoth = (
	queryClient: ReturnType<typeof useQueryClient>,
	kind: DisputeKind,
	documentId: string,
) => {
	queryClient.invalidateQueries({ queryKey: disputeKey(kind, documentId) });
	const docKey = documentQueryKey(kind);
	queryClient.invalidateQueries({ queryKey: [docKey, documentId] });
	queryClient.invalidateQueries({ queryKey: [docKey] });

	// Everything below is reached by a resolution's side effects, and none of
	// it prefix-matches [docKey]. useCreateInvoiceMutation invalidates the same
	// job/visit keys for the same reason: Issue Adjustment writes delta lines
	// carrying source_job_id/source_visit_id and syncBilledAmounts rewrites
	// invoice_job.billed_amount, so job profitability reads stale without this.
	// Revise & Resend additionally moves a quote's request back to Quoted and
	// creates a replacement that client-scoped lists have to pick up.
	queryClient.invalidateQueries({ queryKey: ["jobs"] });
	queryClient.invalidateQueries({ queryKey: ["jobVisits"] });
	queryClient.invalidateQueries({ queryKey: ["clients"] });
	queryClient.invalidateQueries({ queryKey: ["requests"] });
	// Opening a dispute moves an invoice out of the ageing buckets into
	// disputedTotal and resolving moves it back, so AR changes on both.
	queryClient.invalidateQueries({ queryKey: ["reports"] });
	queryClient.invalidateQueries({ queryKey: ["activity-feed"] });
	queryClient.invalidateQueries({ queryKey: qk.disputes.open });
};

export const useOpenDisputeMutation = (kind: DisputeKind, documentId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (input: OpenDisputeInput) => openDispute(kind, documentId, input),
		onSuccess: () => invalidateBoth(queryClient, kind, documentId),
	});
};

export const useResolveDisputeMutation = (kind: DisputeKind, documentId: string) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: ({ disputeId, ...input }: ResolveDisputeInput & { disputeId: string }) =>
			resolveDispute(kind, documentId, disputeId, input),
		onSuccess: () => invalidateBoth(queryClient, kind, documentId),
	});
};

export const useOpenDisputesQuery = (clientId?: string) => {
	const user = useAuthStore((s) => s.user);
	return useQuery({
		queryKey: qk.disputes.openList(clientId),
		queryFn: () => getOpenDisputes(clientId),
		enabled: hasAnyPermission(user, DISPUTE_VIEW_PERMISSIONS),
	});
};
