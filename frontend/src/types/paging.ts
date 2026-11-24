export interface PagedResult<T> {
	rows: T[];
	total: number;
	page: number;
	limit: number;
}

export type SortDir = "asc" | "desc";

export interface ListParams {
	page: number;
	limit: number;
	sort?: string;
	dir?: SortDir;
	q?: string;
	status?: string[];
	from?: string;
	to?: string;
}

export const DEFAULT_LIST_LIMIT = 50;
