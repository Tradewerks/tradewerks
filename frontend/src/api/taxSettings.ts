import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";

export interface TaxSettings {
	tax_mode: "auto" | "manual";
	effective_tax_mode: "auto" | "manual";
	auto_entitled: boolean;
	tax_registered_states: string[];
	org_state: string | null;
	qb_passthrough_required: boolean;
	/** Org flat rate (0-1), auto mode's last fallback. */
	legacy_rate: number;
}

export interface AutoSwitchPreview {
	default_group_lines: number;
	quote_lines: number;
	job_lines: number;
	visit_lines: number;
	invoice_lines: number;
	default_group_drafts: number;
	quote_drafts: number;
	job_drafts: number;
	visit_drafts: number;
	invoice_drafts: number;
}

export interface TaxSettingsUpdate {
	tax_mode?: "auto" | "manual";
	tax_registered_states?: string[];
}

export type TaxSettingsUpdateResult = TaxSettings & {
	cleared_default_lines: number;
	recompute_queued: number;
};

export type TaxReviewKind = "quote" | "job" | "invoice";

export const getTaxSettings = async (): Promise<TaxSettings> => {
	const response = await api.get<ApiResponse<TaxSettings>>("/tax/settings");
	return response.data.data!;
};

export const getAutoSwitchPreview = async (): Promise<AutoSwitchPreview> => {
	const response = await api.get<ApiResponse<AutoSwitchPreview>>(
		"/tax/settings/auto-switch-preview",
	);
	return response.data.data!;
};

export const updateTaxSettings = async (
	data: TaxSettingsUpdate,
): Promise<TaxSettingsUpdateResult> => {
	const response = await api.put<ApiResponse<TaxSettingsUpdateResult>>("/tax/settings", data);
	return response.data.data!;
};

const REVIEW_PATH: Record<TaxReviewKind, string> = {
	quote: "quotes",
	job: "jobs",
	invoice: "invoices",
};

export const acknowledgeTaxReview = async (kind: TaxReviewKind, id: string) => {
	const response = await api.post<
		ApiResponse<{ id: string; tax_review_ack_by: string; tax_review_ack_at: string }>
	>(`/${REVIEW_PATH[kind]}/${id}/tax-review/acknowledge`);
	return response.data.data!;
};
