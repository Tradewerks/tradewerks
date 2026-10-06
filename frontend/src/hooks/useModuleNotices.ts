import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	dismissUntrackedStockNotice,
	getUntrackedStockNotice,
	type StockNoticeModule,
} from "../api/moduleNotices";
import { moduleQuery } from "./moduleQuery";

const useQuery = moduleQuery("inventory");
const key = (module: StockNoticeModule) => ["moduleNotices", "untrackedStock", module] as const;

export const useUntrackedStockNotice = (module: StockNoticeModule) =>
	useQuery({
		queryKey: key(module),
		queryFn: () => getUntrackedStockNotice(module),
		staleTime: 60_000,
	});

export const useDismissUntrackedStockNotice = (module: StockNoticeModule) => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (on: string) => dismissUntrackedStockNotice(module, on),
		onSuccess: () => queryClient.setQueryData(key(module), null),
	});
};
