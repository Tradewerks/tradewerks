import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as api from "../api/customerComms";
import type { CustomerEvent, UpdateCustomerEventSetting } from "../types/customerComms";
import type { UpsertTemplateInput } from "../types/emailTemplates";
import { moduleQuery } from "./moduleQuery";

const useModuleQuery = moduleQuery("customer_comms");
const SETTINGS_KEY = ["customer-comms", "settings"] as const;
const templateKey = (event: CustomerEvent) => ["customer-comms", "template", event] as const;

export const useCustomerCommsSettings = () =>
	useModuleQuery({ queryKey: SETTINGS_KEY, queryFn: api.getCustomerCommsSettings });

export const useUpdateCustomerCommsSetting = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			event,
			data,
		}: {
			event: CustomerEvent;
			data: UpdateCustomerEventSetting;
		}) => api.updateCustomerCommsSetting(event, data),
		onSuccess: () => qc.invalidateQueries({ queryKey: SETTINGS_KEY }),
	});
};

export const useCustomerTemplate = (event: CustomerEvent | null) =>
	useQuery({
		queryKey: templateKey(event ?? "visit_confirmed"),
		queryFn: () => api.getCustomerTemplate(event!),
		enabled: !!event,
	});

export const useUpdateCustomerTemplate = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: ({
			event,
			data,
		}: {
			event: CustomerEvent;
			data: UpsertTemplateInput;
		}) => api.updateCustomerTemplate(event, data),
		onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: templateKey(v.event) }),
	});
};

export const useResetCustomerTemplate = () => {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: (event: CustomerEvent) => api.resetCustomerTemplate(event),
		onSuccess: (_d, event) => qc.invalidateQueries({ queryKey: templateKey(event) }),
	});
};

export const useCustomerTemplateContext = () =>
	useQuery({
		queryKey: ["customer-comms", "template-context"],
		queryFn: api.getCustomerTemplateContext,
		staleTime: 5 * 60 * 1000,
	});
