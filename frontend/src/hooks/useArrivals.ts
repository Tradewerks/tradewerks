import { useQuery } from "@tanstack/react-query";
import { getArrivals } from "../api/arrivals";
import { qk } from "../lib/queryKeys";

// The tracker pushes arrivals:updated every minute (useSocketQuerySync); the
// interval only covers a dropped socket.
const REFETCH_MS = 60_000;

export const useArrivalBoardQuery = (enabled = true) =>
	useQuery({
		queryKey: qk.arrivals.board,
		queryFn: () => getArrivals(),
		refetchInterval: REFETCH_MS,
		staleTime: 15_000,
		enabled,
	});

export const useVisitArrivalsQuery = (visitId: string | undefined) =>
	useQuery({
		queryKey: qk.arrivals.visit(visitId ?? ""),
		queryFn: () => getArrivals({ visitId }),
		refetchInterval: REFETCH_MS,
		staleTime: 15_000,
		enabled: !!visitId,
	});
