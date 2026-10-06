import { api } from "./axiosClient";
import type { EntitlementsData } from "../lib/permissionAccess";

export interface DisablePreview {
	module: string;
	warning: string | null;
	dependents: string[];
	blocker: { count: number; message: string } | null;
}

export const getEntitlements = async (): Promise<EntitlementsData> =>
	(await api.get("/org/entitlements")).data.data;

export const getDisablePreview = async (key: string): Promise<DisablePreview> =>
	(await api.get(`/org/entitlements/modules/${key}/disable-preview`)).data.data;

export const updateModuleChoices = async (
	choices: Record<string, boolean>,
): Promise<EntitlementsData> =>
	(await api.patch("/org/entitlements/modules", { choices })).data.data;
