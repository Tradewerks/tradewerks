import { api } from "./axiosClient";

export type RequestStatus = "open" | "approved" | "declined" | "withdrawn";
export interface UpgradeRequest {
	id: string;
	organization_id: string;
	requested_by_id: string;
	requested_by_name: string;
	requested_plan_key: string | null;
	requested_plan_label: string | null;
	requested_modules: { key: string; label: string }[];
	note: string | null;
	status: RequestStatus;
	resolution_note: string | null;
	resolved_at: string | null;
	created_at: string;
}
export interface RequestableTier {
	key: string;
	label: string;
	modules: { key: string; label: string }[];
}

export const listUpgradeRequests = async (): Promise<UpgradeRequest[]> =>
	(await api.get("/org/entitlements/upgrade-requests")).data.data;
export const fileUpgradeRequest = async (b: {
	planKey?: string;
	modules?: string[];
	note?: string;
}): Promise<UpgradeRequest> => (await api.post("/org/entitlements/upgrade-requests", b)).data.data;
export const withdrawUpgradeRequest = async (id: string): Promise<void> => {
	await api.post(`/org/entitlements/upgrade-requests/${id}/withdraw`);
};
export const getRequestableTiers = async (): Promise<RequestableTier[]> =>
	(await api.get("/org/entitlements/tiers")).data.data;
