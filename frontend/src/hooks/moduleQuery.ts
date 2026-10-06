import { useQuery } from "@tanstack/react-query";
import { readCachedEntitlements, useEntitlements } from "./useEntitlements";
import { moduleState } from "../lib/permissionAccess";

/**
 * A `useQuery` for a hook file whose data belongs to one module. Core pages mount
 * these hooks too (create forms, dashboard widgets), and without the module every
 * one of those requests would only come back 403. A module the org switched off
 * stays readable, so only `not_in_plan` stops the request.
 */
export function moduleQuery(moduleKey: string): typeof useQuery {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const useModuleQuery = (options: any, client?: any) => {
		// While the first entitlements request is in flight the module's state is not
		// known. Firing anyway sends a request that is refused and then retried, so
		// go by the last saved snapshot and hold the query when there is none.
		const { data, isLoading } = useEntitlements();
		const known = data ?? (isLoading ? readCachedEntitlements() : undefined);
		const readable =
			isLoading && !known ? false : moduleState(known, moduleKey) !== "not_in_plan";
		const own = options.enabled;
		return useQuery({ ...options, enabled: readable ? (own ?? true) : false }, client);
	};
	return useModuleQuery as typeof useQuery;
}
