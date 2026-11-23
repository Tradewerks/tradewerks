import type { VehicleStockItem } from "../types/vehicles";
import { dateLocale } from "../i18n";

export function getStockHealth(item: VehicleStockItem): "out" | "low" | "ok" {
	const onHand = Number(item.qty_on_hand);
	const min = Number(item.qty_min ?? 0);
	if (onHand === 0 && min > 0) return "out";
	if (onHand < min) return "low";
	return "ok";
}

export function resolveItemName(stockItemId: string, stockItems: VehicleStockItem[]): string {
	return stockItems.find((s) => s.id === stockItemId)?.inventory_item.name ?? stockItemId;
}

export function formatRestockDate(iso: string): string {
	return new Date(iso).toLocaleString(dateLocale(), {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
