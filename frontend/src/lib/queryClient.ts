import { MutationCache, QueryClient, type DefaultOptions } from "@tanstack/react-query";
import { CACHE_TIME, REFETCH_ON_FOCUS, STALE_TIME } from "../config";
import { useToastStore } from "../stores/toastStore";
import { errorMessage } from "../util/util";
import { isConflict } from "./apiErrors";

/** HTTP status of an axios error (`response.status`) or a typed error that carries `status`. */
const statusOf = (error: unknown): number | undefined => {
	const e = error as { status?: unknown; response?: { status?: unknown } } | null;
	const status = e?.response?.status ?? e?.status;
	return typeof status === "number" ? status : undefined;
};

// A 4xx will not heal on retry; only network/5xx failures are worth two more tries.
export function shouldRetry(failureCount: number, error: unknown): boolean {
	const status = statusOf(error);
	if (status !== undefined && status >= 400 && status < 500) return false;
	return failureCount < 2;
}

// Mutations that render their own error UI set `meta: { silentError: true }`; a
// ConflictError is answered by the conflict dialog, never a toast.
export const createMutationCache = (): MutationCache =>
	new MutationCache({
		onError: (error, _variables, _context, mutation) => {
			if (mutation.options.meta?.silentError === true || isConflict(error)) return;
			useToastStore.getState().push("error", errorMessage(error, "Something went wrong"));
		},
	});

const defaultOptions: DefaultOptions = {
	queries: {
		staleTime: STALE_TIME,
		gcTime: CACHE_TIME,
		refetchOnWindowFocus: REFETCH_ON_FOCUS,
		retry: shouldRetry,
	},
	mutations: { retry: false },
};

export const queryClient = new QueryClient({
	defaultOptions,
	mutationCache: createMutationCache(),
});
