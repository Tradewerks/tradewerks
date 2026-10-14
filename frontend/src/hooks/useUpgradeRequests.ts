import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	fileUpgradeRequest,
	getRequestableTiers,
	listUpgradeRequests,
	withdrawUpgradeRequest,
} from "../api/upgradeRequests";

export const UPGRADE_REQUESTS_QUERY_KEY = ["upgrade-requests"] as const;

export const useUpgradeRequests = (enabled: boolean) =>
	useQuery({ queryKey: UPGRADE_REQUESTS_QUERY_KEY, queryFn: listUpgradeRequests, enabled });
export const useRequestableTiers = (enabled: boolean) =>
	useQuery({
		queryKey: [...UPGRADE_REQUESTS_QUERY_KEY, "tiers"],
		queryFn: getRequestableTiers,
		enabled,
	});

function useRequestMutation<A, R>(fn: (a: A) => Promise<R>) {
	const qc = useQueryClient();
	return useMutation({
		mutationFn: fn,
		onSettled: () => qc.invalidateQueries({ queryKey: UPGRADE_REQUESTS_QUERY_KEY }),
	});
}
export const useFileUpgradeRequest = () => useRequestMutation(fileUpgradeRequest);
export const useWithdrawUpgradeRequest = () => useRequestMutation(withdrawUpgradeRequest);
