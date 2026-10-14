import { QueryClient, type DefaultOptions } from "@tanstack/react-query";
import { CACHE_TIME, REFETCH_ON_FOCUS, STALE_TIME } from "../config";

const defaultOptions: DefaultOptions = {
	queries: {
		staleTime: STALE_TIME,
		gcTime: CACHE_TIME,
		refetchOnWindowFocus: REFETCH_ON_FOCUS,
	},
};

export const queryClient = new QueryClient({
	defaultOptions,
});
