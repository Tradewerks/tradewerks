import { useEffect, useRef } from "react";
import { useLocation, useNavigationType, useSearchParams } from "react-router-dom";
import { listParamsFromSearch } from "./usePagedList";
import { resolveDateRange, type DateRangeValue } from "../util/dateRangeUtils";

/**
 * A picker range as the server's from/to. `to` is exclusive there, so it is the
 * next local midnight rather than the picker's 23:59:59.999.
 */
export function dateRangeToParams(value: DateRangeValue): { from?: string; to?: string } {
	const range = resolveDateRange(value);
	if (!range) return {};
	const { end } = range;
	return {
		from: range.start.toISOString(),
		to: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).toISOString(),
	};
}

/**
 * URL-backed page and page size for a server-paged list. `filters` is everything
 * else that narrows the result (already in its final server form): when the user
 * changes it, the page falls back to 1, since page N of the old filter is not
 * page N of the new one. The URL is corrected in an effect, but the returned page
 * is already 1 on that render so no request goes out for the stale page.
 * Back/Forward also change the filters, but the entry they land on already holds
 * the right page, so a filter change that arrives together with a POP location
 * change is left alone. (useNavigationType stays "POP" after arriving, so the
 * location key is what tells a later state-driven change, like typed search, apart.)
 */
export function useListPaging(filters: unknown) {
	const [searchParams, setSearchParams] = useSearchParams();
	const navigationType = useNavigationType();
	const locationKey = useLocation().key;
	const { page: urlPage, limit } = listParamsFromSearch(searchParams);

	const filterKey = JSON.stringify(filters);
	const seenKey = useRef(filterKey);
	const lastLocationKey = useRef(locationKey);
	const poppedHere = navigationType === "POP" && lastLocationKey.current !== locationKey;
	const filtersChanged = seenKey.current !== filterKey && !poppedHere;

	const write = (change: (next: URLSearchParams) => void, replace = true) =>
		setSearchParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				change(next);
				return next;
			},
			{ replace }
		);

	useEffect(() => {
		lastLocationKey.current = locationKey;
		if (seenKey.current === filterKey) return;
		seenKey.current = filterKey;
		if (!poppedHere && urlPage !== 1) write((next) => next.delete("page"));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filterKey, locationKey]);

	// Pushed, so Back steps through pages; the filter-change reset above replaces.
	const setPage = (page: number) =>
		write((next) => (page <= 1 ? next.delete("page") : next.set("page", String(page))), false);
	const setLimit = (size: number) =>
		write((next) => {
			next.delete("page");
			next.set("limit", String(size));
		});

	const page = filtersChanged ? 1 : urlPage;

	// ReportPagination counts pages from 0.
	const paginationProps = (total: number, isFetching?: boolean) => ({
		page: page - 1,
		pageSize: limit,
		total,
		hasMore: page * limit < total,
		onPageChange: (p: number) => setPage(p + 1),
		onPageSizeChange: setLimit,
		isFetching,
	});

	return { page, limit, setPage, setLimit, paginationProps };
}
