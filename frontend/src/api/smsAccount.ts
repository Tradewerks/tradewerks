import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";

export type SmsAccountStatus =
	| "draft"
	| "submitted"
	| "brand_pending"
	| "campaign_pending"
	| "active"
	| "failed"
	| "suspended";

export interface SmsAddress {
	street: string;
	street_secondary?: string;
	city: string;
	region: string;
	postal_code: string;
	iso_country: "US" | "CA";
}

/** Mirrors SmsRegistrationForm in backend/src/services/sms/provider.ts. */
export interface SmsRegistration {
	legal_name: string;
	dba?: string;
	ein?: string;
	entity_type: string;
	vertical: string;
	address: SmsAddress;
	website: string;
	support_email: string;
	support_phone: string;
	rep_name: string;
	rep_title: string;
	rep_email: string;
	rep_phone: string;
	sole_prop_mobile?: string;
	privacy_url: string;
	terms_url: string;
	area_code: string;
}

export type SmsRegistrationDraft = Partial<Omit<SmsRegistration, "address">> & {
	address?: Partial<SmsAddress>;
};

export interface SmsAccount {
	status: SmsAccountStatus;
	phone_number: string | null;
	failure_reason: string | null;
	registration: SmsRegistrationDraft | null;
	submitted_at: string | null;
	usage: { used: number; limit: number | null };
}

export const getSmsAccount = async (): Promise<SmsAccount> => {
	const response = await api.get<ApiResponse<SmsAccount>>("/sms-account");
	if (!response.data.data) throw new Error("Failed to load text messaging");
	return response.data.data;
};

export const saveSmsRegistration = async (data: SmsRegistrationDraft): Promise<SmsAccount> => {
	const response = await api.put<ApiResponse<SmsAccount>>("/sms-account/registration", data);
	return response.data.data!;
};

export const submitSmsRegistration = async (data: SmsRegistration): Promise<SmsAccount> => {
	const response = await api.post<ApiResponse<SmsAccount>>("/sms-account/submit", data);
	return response.data.data!;
};
