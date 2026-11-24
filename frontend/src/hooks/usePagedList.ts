import { keepPreviousData, useQuery, type QueryKey } from "@tanstack/react-query";
import type { ApiResponse } from "../types/api";
import { DEFAULT_LIST_LIMIT, type ListParams, type PagedResult } from "../types/paging";

/**
 * One page of a server-paged list. `key` is the caller's qk prefix; params are
 * appended as the trailing segment so prefix invalidation still reaches every
 * page and filter combination.
 */
export function usePagedList<T>(
	key: QueryKey,
	fetcher: (params: ListParams) => Promise<PagedResult<T>>,
	params: ListParams
) {
	return useQuery({
		queryKey: [...key, params],
		queryFn: () => fetcher(params),
		// Paging or filtering keeps the current rows visible instead of flashing empty.
		placeholderData: keepPreviousData,
	});
}

export function pagedResultFrom<T>(body: ApiResponse<T[]>, params: ListParams): PagedResult<T> {
	const rows = body.data ?? [];
	return {
		rows,
		total: body.meta?.count ?? rows.length,
		page: body.meta?.page ?? params.page,
		limit: body.meta?.limit ?? params.limit,
	};
}

function positiveInt(raw: string | null, fallback: number): number {
	if (!raw || !/^\d+$/.test(raw)) return fallback;
	const n = Number(raw);
	return n >= 1 ? n : fallback;
}

// A malformed page, limit or dir in a shared or hand-edited URL falls back to its
// default. sort, status and from/to pass through as written, so a bad value there
// (or a limit over the server's 200) still gets a 400 from the server.
export function listParamsFromSearch(sp: URLSearchParams): ListParams {
	const p: ListParams = {
		page: positiveInt(sp.get("page"), 1),
		limit: positiveInt(sp.get("limit"), DEFAULT_LIST_LIMIT),
	};
	const sort = sp.get("sort");
	if (sort) p.sort = sort;
	const dir = sp.get("dir");
	if (dir === "asc" || dir === "desc") p.dir = dir;
	const q = sp.get("q")?.trim();
	if (q) p.q = q;
	const status = (sp.get("status") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (status.length) p.status = status;
	const from = sp.get("from");
	if (from) p.from = from;
	const to = sp.get("to");
	if (to) p.to = to;
	return p;
}

const LIST_KEYS = ["page", "limit", "sort", "dir", "q", "status", "from", "to"];

// `page` is always written: its presence is what opts a request into the paged shape.
// `base` carries the page's other URL params (tab, selected id) through untouched;
// its list keys are cleared first so a removed filter does not linger.
export function listParamsToSearch(p: ListParams, base?: URLSearchParams): URLSearchParams {
	const sp = new URLSearchParams(base);
	for (const key of LIST_KEYS) sp.delete(key);
	sp.set("page", String(p.page));
	if (p.limit !== DEFAULT_LIST_LIMIT) sp.set("limit", String(p.limit));
	if (p.sort) sp.set("sort", p.sort);
	if (p.dir) sp.set("dir", p.dir);
	if (p.q) sp.set("q", p.q);
	if (p.status?.length) sp.set("status", p.status.join(","));
	if (p.from) sp.set("from", p.from);
	if (p.to) sp.set("to", p.to);
	return sp;
}
