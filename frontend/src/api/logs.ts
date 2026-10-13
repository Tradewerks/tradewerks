import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";
import type { ActivityLog, ChangeScope } from "../types/logs";

export interface RecentLogsResult {
	data: ActivityLog[];
	hasMore: boolean;
}

export const getRecentLogs = async (limit = 25, cursor?: string, userId?: string): Promise<RecentLogsResult> => {
	const params = new URLSearchParams({ limit: String(limit) });
	if (cursor) params.set("cursor", cursor);
	if (userId) params.set("userId", userId);
	const response = await api.get<ApiResponse<ActivityLog[]>>(`/logs/recent?${params}`);
	return {
		data: response.data.data || [],
		hasMore: (response.data.meta as Record<string, unknown>)?.hasMore === true,
	};
};

type ScopeKey<S extends ChangeScope = ChangeScope> = S extends S
	? `${S["kind"]}:${S["type"]}`
	: never;

const CHANGE_PATHS: Record<ScopeKey, (id: string) => string> = {
	"actor:dispatcher": (id) => `/dispatchers/${id}/changes`,
	"actor:technician": (id) => `/technicians/${id}/changes`,
	"entity:job": (id) => `/jobs/${id}/changes`,
	"entity:invoice": (id) => `/invoices/${id}/changes`,
	"entity:quote": (id) => `/quotes/${id}/changes`,
	"entity:request": (id) => `/requests/${id}/changes`,
	"entity:project": (id) => `/projects/${id}/changes`,
	"entity:client": (id) => `/clients/${id}/changes`,
	"entity:recurring_plan": (id) => `/recurring-plans/${id}/changes`,
	"entity:vehicle": (id) => `/vehicles/${id}/changes`,
	"entity:timesheet": (id) => `/timesheets/weeks/${id}/changes`,
};

export interface ChangeHistoryResult {
	data: ActivityLog[];
	hasMore: boolean;
	total: number;
}

export const getChangeHistory = async (
	scope: ChangeScope,
	limit = 20,
): Promise<ChangeHistoryResult> => {
	const path = CHANGE_PATHS[`${scope.kind}:${scope.type}` as ScopeKey](scope.id);
	const response = await api.get<ApiResponse<ActivityLog[]>>(`${path}?limit=${limit}`);
	if (!response.data.success) {
		throw new Error(response.data.error?.message ?? "Failed to load change history");
	}
	const meta = response.data.meta as Record<string, unknown> | undefined;
	const data = response.data.data ?? [];
	return {
		data,
		hasMore: meta?.hasMore === true,
		total: typeof meta?.total === "number" ? meta.total : data.length,
	};
};
