import { useQuery } from "@tanstack/react-query";
import { getEntitlements } from "../api/entitlements";
import { useAuthStore } from "../auth/authStore";
import { moduleState, type EntitlementsData, type ModuleState } from "../lib/permissionAccess";

export const ENTITLEMENTS_QUERY_KEY = ["entitlements"] as const;
export const ENTITLEMENTS_STORAGE_KEY = "entitlements:last";

export const readCachedEntitlements = (): EntitlementsData | undefined => {
	try {
		const raw = localStorage.getItem(ENTITLEMENTS_STORAGE_KEY);
		return raw ? (JSON.parse(raw) as EntitlementsData) : undefined;
	} catch {
		return undefined;
	}
};

export function useEntitlements() {
	const loggedIn = useAuthStore((s) => !!s.user);
	const query = useQuery({
		queryKey: ENTITLEMENTS_QUERY_KEY,
		enabled: loggedIn,
		staleTime: 60_000,
		refetchOnWindowFocus: true,
		queryFn: async () => {
			const data = await getEntitlements();
			try {
				localStorage.setItem(ENTITLEMENTS_STORAGE_KEY, JSON.stringify(data));
			} catch {
				/* private mode: the cache is a convenience only */
			}
			return data;
		},
	});
	return {
		data: query.data ?? (query.isError ? readCachedEntitlements() : undefined),
		/** False while `data` is the stored snapshot shown after a failed fetch. */
		fromServer: query.data !== undefined,
		isLoading: query.isLoading,
	};
}

export function useModule(key: string): ModuleState {
	return moduleState(useEntitlements().data, key);
}

/** For `enabled:` on a query that reads a module's data: false once the module is known not to be on. */
export function useModuleOn(key: string): boolean {
	return useModule(key) === "on";
}
