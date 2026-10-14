import { api } from "./axiosClient";

export type StockNoticeModule = "inventory" | "vehicle_stock";

export interface UntrackedStockNotice {
	module: StockNoticeModule;
	off: string;
	on: string;
	visits: { id: string; job_id: string; name: string | null; completed_at: string }[];
}

export const getUntrackedStockNotice = async (
	module: StockNoticeModule
): Promise<UntrackedStockNotice | null> =>
	(await api.get("/org/entitlements/notices/untracked-stock", { params: { module } })).data
		.data;

export const dismissUntrackedStockNotice = async (
	module: StockNoticeModule,
	on: string
): Promise<void> => {
	await api.post("/org/entitlements/notices/untracked-stock/dismiss", { module, on });
};
