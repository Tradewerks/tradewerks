import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type {
	CustomerEvent,
	CustomerEventSetting,
	UpdateCustomerEventSetting,
} from "../types/customerComms";
import type {
	EmailTemplate,
	TemplatePreviewContext,
	UpsertTemplateInput,
} from "../types/emailTemplates";

export const getCustomerCommsSettings = async (): Promise<CustomerEventSetting[]> => {
	const response = await api.get<ApiResponse<{ events: CustomerEventSetting[] }>>(
		"/customer-comms/settings"
	);
	return response.data.data?.events ?? [];
};

export const updateCustomerCommsSetting = async (
	event: CustomerEvent,
	data: UpdateCustomerEventSetting
): Promise<CustomerEventSetting> => {
	const response = await api.put<ApiResponse<CustomerEventSetting>>(
		`/customer-comms/settings/${event}`,
		data
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to save setting");
	}
	return response.data.data!;
};

export const getCustomerTemplate = async (event: CustomerEvent): Promise<EmailTemplate> => {
	const response = await api.get<ApiResponse<EmailTemplate>>(
		`/customer-comms/templates/${event}`
	);
	if (!response.data.data) throw new Error("Failed to load message");
	return response.data.data;
};

export const updateCustomerTemplate = async (
	event: CustomerEvent,
	data: UpsertTemplateInput
): Promise<EmailTemplate> => {
	const response = await api.put<ApiResponse<EmailTemplate>>(
		`/customer-comms/templates/${event}`,
		data
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to save message");
	}
	return response.data.data!;
};

export const resetCustomerTemplate = async (event: CustomerEvent): Promise<EmailTemplate> => {
	const response = await api.post<ApiResponse<EmailTemplate>>(
		`/customer-comms/templates/${event}/reset`
	);
	if (!response.data.success) {
		throw new Error(response.data.error?.message || "Failed to reset message");
	}
	return response.data.data!;
};

export const getCustomerTemplateContext = async (): Promise<TemplatePreviewContext> => {
	const response = await api.get<ApiResponse<TemplatePreviewContext>>(
		"/customer-comms/templates/context"
	);
	if (!response.data.data) throw new Error("Failed to load preview context");
	return response.data.data;
};
