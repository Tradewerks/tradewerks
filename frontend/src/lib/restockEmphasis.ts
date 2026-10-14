import type { RestockMode } from "../api/org";

// restock_mode is emphasis only: these helpers reorder and reword, they never
// remove a tab or an action. Permissions decide capability.

// While loading, undefined keeps the emphasis neutral. A failed org fetch would leave
// it undefined forever and the action row would never offer Fill, so fall back to
// the backend default instead of letting a missing mode act as a gate.
export function effectiveRestockMode(
	mode: RestockMode | undefined,
	isError: boolean
): RestockMode | undefined {
	return mode ?? (isError ? "tech_self_serve" : undefined);
}

export type VehicleStockTab = "stock" | "restock" | "alerts" | "maintenance" | "activity";

export function vehicleStockTabOrder(mode: RestockMode | undefined): VehicleStockTab[] {
	return mode === "dispatch_prepared"
		? ["stock", "alerts", "restock", "maintenance", "activity"]
		: ["stock", "restock", "alerts", "maintenance", "activity"];
}

export function emptyVehicleStockCopy(canStock: boolean): { title: string; description: string } {
	return {
		title: "No items on this vehicle yet",
		description: canStock
			? "Add the parts this vehicle carries to start tracking its stock."
			: "Dispatch sets up this vehicle's stock list. Ask them to add the parts it carries.",
	};
}
