import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";

export interface OrganizationDeletionSummary {
	name: string;
	users: number;
	clients: number;
	jobs: number;
	invoices: number;
	quickbooksConnected: boolean;
}

// What deleting the signed-in account would do. The admin's account takes the
// whole organization with it; anyone else's is scrubbed and the org keeps its records.
export type AccountDeletionPreview =
	| { kind: "user"; confirmation: string; organization: { name: string }; blockers: string[] }
	| { kind: "organization"; confirmation: string; organization: OrganizationDeletionSummary; blockers: string[] };

export const getAccountDeletionPreview = async () =>
	(await api.get<ApiResponse<AccountDeletionPreview>>("/account/deletion")).data.data!;

export const deleteAccount = async (input: { password: string; confirmation: string }) =>
	(await api.post<ApiResponse<{ kind: "user" | "organization" }>>("/account/delete", input)).data.data!;
