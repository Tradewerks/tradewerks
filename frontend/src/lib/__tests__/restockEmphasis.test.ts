import { describe, expect, test } from "vitest";
import {
	effectiveRestockMode,
	emptyVehicleStockCopy,
	vehicleStockTabOrder,
} from "../restockEmphasis";

describe("vehicleStockTabOrder", () => {
	test("self-serve (and loading) keeps Warehouse Restock before requests", () => {
		const order = ["stock", "restock", "alerts", "maintenance", "activity"];
		expect(vehicleStockTabOrder("tech_self_serve")).toEqual(order);
		expect(vehicleStockTabOrder(undefined)).toEqual(order);
	});

	test("dispatch prepared leads with the requests tab after Stock", () => {
		expect(vehicleStockTabOrder("dispatch_prepared")).toEqual([
			"stock",
			"alerts",
			"restock",
			"maintenance",
			"activity",
		]);
	});

	test("every mode keeps every tab (emphasis, never a gate) and the alerts deep-link key", () => {
		for (const mode of ["tech_self_serve", "dispatch_prepared", undefined] as const) {
			const order = vehicleStockTabOrder(mode);
			expect([...order].sort()).toEqual([
				"activity",
				"alerts",
				"maintenance",
				"restock",
				"stock",
			]);
		}
	});
});

describe("emptyVehicleStockCopy", () => {
	test("a tech who can stock is told to add items", () => {
		expect(emptyVehicleStockCopy(true)).toEqual({
			title: "No items on this vehicle yet",
			description:
				"Add the parts this vehicle carries to start tracking its stock.",
		});
	});

	test("a tech who cannot stock is told who sets the list up", () => {
		expect(emptyVehicleStockCopy(false).description).toBe(
			"Dispatch sets up this vehicle's stock list. Ask them to add the parts it carries."
		);
	});
});

describe("effectiveRestockMode", () => {
	test("a loaded mode wins regardless of error state", () => {
		expect(effectiveRestockMode("dispatch_prepared", false)).toBe("dispatch_prepared");
		expect(effectiveRestockMode("dispatch_prepared", true)).toBe("dispatch_prepared");
	});

	test("still loading stays undefined", () => {
		expect(effectiveRestockMode(undefined, false)).toBeUndefined();
	});

	test("a failed org fetch falls back to the self-serve default", () => {
		expect(effectiveRestockMode(undefined, true)).toBe("tech_self_serve");
	});
});
