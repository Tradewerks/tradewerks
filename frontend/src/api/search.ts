import { api } from "./axiosClient";
import type { ApiResponse } from "../types/api";

export type SearchEntityType =
	| "client"
	| "job"
	| "quote"
	| "request"
	| "invoice"
	| "visit"
	| "technician"
	| "contact"
	| "project"
	| "inventory_item"
	| "recurring_plan";

export interface SearchHit {
	id: string;
	type: SearchEntityType;
	label: string;
	sublabel?: string;
	status?: string;
	route: string;
}

export interface SearchOutcome {
	hits: SearchHit[];
	truncated: boolean;
	types: SearchEntityType[];
}

export const searchAll = async (
	q: string,
	opts: { types?: readonly SearchEntityType[]; limit?: number } = {},
): Promise<SearchOutcome> => {
	const params: Record<string, string | number> = { q };
	if (opts.types?.length) params.types = opts.types.join(",");
	if (opts.limit != null) params.limit = opts.limit;
	const response = await api.get<ApiResponse<SearchOutcome>>("/search", { params });
	if (!response.data.data) throw new Error("Search failed");
	return response.data.data;
};
