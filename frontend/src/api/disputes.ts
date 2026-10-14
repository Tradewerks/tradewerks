import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	Dispute,
	DisputeKind,
	DisputeList,
	OpenDisputeInput,
	OpenDisputeList,
	ResolveDisputeInput,
} from "../types/disputes";

const base = (kind: DisputeKind, documentId: string) =>
	kind === "quote" ? `/quotes/${documentId}/disputes` : `/invoices/${documentId}/disputes`;

export const getDisputes = async (
	kind: DisputeKind,
	documentId: string,
): Promise<DisputeList> => {
	const response = await api.get<ApiResponse<DisputeList>>(base(kind, documentId));
	return (
		response.data.data ?? {
			disputes: [],
			open_refusal: null,
			sold_refusal: null,
			void_refusal: null,
		}
	);
};

export const openDispute = async (
	kind: DisputeKind,
	documentId: string,
	input: OpenDisputeInput,
): Promise<Dispute> => {
	const response = await api.post<ApiResponse<Dispute>>(base(kind, documentId), input);
	if (!response.data.data) throw new Error("Failed to open dispute");
	return response.data.data;
};

export const resolveDispute = async (
	kind: DisputeKind,
	documentId: string,
	disputeId: string,
	input: ResolveDisputeInput,
): Promise<Dispute> => {
	const response = await api.post<ApiResponse<Dispute>>(
		`${base(kind, documentId)}/${disputeId}/resolve`,
		input,
	);
	if (!response.data.data) throw new Error("Failed to resolve dispute");
	return response.data.data;
};

export const getOpenDisputes = async (clientId?: string): Promise<OpenDisputeList> => {
	const response = await api.get<ApiResponse<OpenDisputeList>>("/disputes/open", {
		params: clientId ? { client_id: clientId } : undefined,
	});
	return response.data.data ?? { items: [], counts: { quote: 0, invoice: 0 }, total: 0 };
};
