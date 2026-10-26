import type { Vehicle, StockHealthStatus, ReadinessState } from "../../types/vehicles";

export const HEALTH_CONFIG: Record<StockHealthStatus, {
	borderColor: string;
	rowBg: string;
}> = {
	ok:  { borderColor: "border-l-success", rowBg: "" },
	low: { borderColor: "border-l-warning", rowBg: "bg-warning/5" },
	out: { borderColor: "border-l-error",   rowBg: "bg-error/5" },
};

export const READINESS_CONFIG: Partial<Record<ReadinessState, { label: string; className: string }>> = {
	unknown:      { label: "Unknown",  className: "text-text-muted border-border bg-surface-raised" },
	auto_ready:   { label: "Ready",    className: "text-success border-success/40 bg-success/10" },
	needs_action: { label: "",         className: "text-warning border-warning/40 bg-warning/10" },
	confirmed:    { label: "Ready ✓",  className: "text-success border-success/40 bg-success/10" },
	not_applicable: { label: "No visits", className: "text-text-muted border-border bg-surface-raised" },
};

export function getStockCounts(vehicle: Vehicle) {
	const items = vehicle.stock_items ?? [];
	let out = 0;
	let low = 0;
	let ok = 0;
	for (const i of items) {
		const onHand = Number(i.qty_on_hand);
		const min = Number(i.qty_min);
		if (onHand === 0 && min > 0) out++;
		else if (onHand < min) low++;
		else ok++;
	}
	return { out, low, ok, total: items.length };
}

export function getStockHealth(vehicle: Vehicle): StockHealthStatus {
	const { out, low } = getStockCounts(vehicle);
	if (out > 0) return "out";
	if (low > 0) return "low";
	return "ok";
}
