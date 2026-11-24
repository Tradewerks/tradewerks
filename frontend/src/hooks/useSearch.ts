import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { searchAll, type SearchEntityType } from "../api/search";
import { qk } from "../lib/queryKeys";
import { useDebouncedValue } from "./useDebouncedValue";

export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MIN_CHARS = 2;

export const useSearchQuery = (
	text: string,
	opts: { types?: readonly SearchEntityType[]; limit?: number } = {},
) => {
	const q = useDebouncedValue(text.trim(), SEARCH_DEBOUNCE_MS);
	const result = useQuery({
		queryKey: qk.search.query(q, opts.types),
		queryFn: () => searchAll(q, opts),
		enabled: q.length >= SEARCH_MIN_CHARS,
		staleTime: 30_000,
		placeholderData: keepPreviousData,
	});
	// True between a keystroke and the request it will trigger, so callers don't
	// flash "No results" for a query that hasn't been sent yet.
	return { ...result, isSettling: q !== text.trim() && text.trim().length >= SEARCH_MIN_CHARS };
};
