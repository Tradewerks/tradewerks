import { describe, it, expect } from "vitest";
import {
	buildRunwayRows,
	offChartBreakdown,
	hasReorderChartContent,
	PLOT_WINDOW_DAYS,
} from "../reorderChart";
import type { ReorderForecastRow } from "../../types/reports";

/**
 * A forecast row with everything the chart needs, overridable per case. The
 * defaults describe a plottable warning item so each test only states the field
 * it is actually about.
 */
const row = (over: Partial<ReorderForecastRow> = {}): ReorderForecastRow => ({
	itemId: "item-1",
	itemName: "Widget",
	sku: null,
	category: null,
	unit: "each",
	currentQuantity: 20,
	warehouseQuantity: 20,
	vehicleQuantity: 0,
	qtyConsumed: 40,
	avgDailyUsage: 2,
	// Single-unit by default, so a case that cares about a unit break has to say
	// so — and every other case is asserting behaviour on a clean series.
	consumptionBasis: { units: ["each"], unit: "each", mixed: false },
	observedDays: 20,
	daysOfStock: 10,
	projectedStockoutDate: "2026-08-13T00:00:00.000Z",
	lowStockThreshold: 5,
	belowReorderPoint: false,
	severity: "warning",
	// No vendor by default — these cases are about runway geometry, and a case
	// that cares about a supplier says so.
	preferredSupplierId: null,
	preferredSupplierName: null,
	vendorSku: null,
	preferredUnitPrice: null,
	priceSource: "none",
	vendorSource: "none",
	shortfallQty: null,
	estimatedShortfallCost: null,
	...over,
});

describe("buildRunwayRows", () => {
	it("ranks worst runway first", () => {
		const rows = buildRunwayRows([
			row({ itemId: "a", itemName: "Slow", daysOfStock: 18 }),
			row({ itemId: "b", itemName: "Urgent", daysOfStock: 3, severity: "critical" }),
			row({ itemId: "c", itemName: "Mid", daysOfStock: 9 }),
		]);
		expect(rows.map((r) => r.itemId)).toEqual(["b", "c", "a"]);
		expect(rows[0].days).toBe(3);
	});

	it("breaks runway ties on name so refetches can't reshuffle pages", () => {
		const rows = buildRunwayRows([
			row({ itemId: "z", itemName: "Zeta", daysOfStock: 5 }),
			row({ itemId: "a", itemName: "Alpha", daysOfStock: 5 }),
		]);
		expect(rows.map((r) => r.name)).toEqual(["Alpha", "Zeta"]);
	});

	it("excludes items further out than the plot window", () => {
		const rows = buildRunwayRows([
			row({ itemId: "in", daysOfStock: PLOT_WINDOW_DAYS }),
			row({ itemId: "out", daysOfStock: PLOT_WINDOW_DAYS + 1, severity: "healthy" }),
		]);
		expect(rows.map((r) => r.itemId)).toEqual(["in"]);
	});

	it("plots a healthy item inside the window — every band gets a bar", () => {
		const rows = buildRunwayRows([row({ daysOfStock: 25, severity: "healthy" })]);
		expect(rows).toHaveLength(1);
		expect(rows[0].severity).toBe("healthy");
	});

	it("excludes items with no measured usage rate", () => {
		const rows = buildRunwayRows([
			row({
				avgDailyUsage: 0,
				daysOfStock: null,
				projectedStockoutDate: null,
				severity: "warning",
			}),
		]);
		expect(rows).toHaveLength(0);
	});

	it("rounds the runway to whole days and carries belowReorderPoint through", () => {
		const rows = buildRunwayRows([row({ daysOfStock: 6.4, belowReorderPoint: true })]);
		expect(rows[0].days).toBe(6);
		expect(rows[0].belowReorderPoint).toBe(true);
	});

	it("never plots a row whose rate was withheld for a unit break", () => {
		// A bar's length is a runway in days off a units/day rate. With no single
		// denomination there is no such rate — and the alternative failures here are
		// a zero-length bar or a bar drawn from a summed `each + box`, both of which
		// look like measurements.
		const rows = buildRunwayRows([
			row({
				itemId: "broken-unit",
				qtyConsumed: null,
				avgDailyUsage: null,
				consumptionBasis: { units: ["box", "each"], unit: null, mixed: true },
				daysOfStock: null,
				projectedStockoutDate: null,
			}),
			row({ itemId: "clean", daysOfStock: 6 }),
		]);

		expect(rows.map((r) => r.itemId)).toEqual(["clean"]);
		expect(rows[0].usage).toBe(2);
	});
});

describe("offChartBreakdown", () => {
	it("counts a rate-less at-risk item as noRate", () => {
		const counts = offChartBreakdown([
			row({
				avgDailyUsage: 0,
				daysOfStock: null,
				projectedStockoutDate: null,
				severity: "warning",
			}),
		]);
		expect(counts).toEqual({ mixedUnits: 0, noRate: 1, beyondWindow: 0 });
	});

	it("counts a below-reorder-point item past the window as beyondWindow, not noRate", () => {
		const counts = offChartBreakdown([
			row({ daysOfStock: 45, belowReorderPoint: true, severity: "critical" }),
		]);
		expect(counts).toEqual({ mixedUnits: 0, noRate: 0, beyondWindow: 1 });
	});

	// A unit break withholds the rate server-side. The row still has to be COUNTED
	// somewhere — dropping a below-reorder-point item from a reorder report because
	// its unit changed is worse than not plotting it — but not in `noRate`, which
	// tells a dispatcher to wait for consumption that has in fact already happened.
	it("counts a withheld-rate item as mixedUnits, not noRate", () => {
		const counts = offChartBreakdown([
			row({
				qtyConsumed: null,
				avgDailyUsage: null,
				consumptionBasis: { units: ["box", "each"], unit: null, mixed: true },
				daysOfStock: null,
				projectedStockoutDate: null,
				severity: "critical",
			}),
		]);
		expect(counts).toEqual({ mixedUnits: 1, noRate: 0, beyondWindow: 0 });
	});

	it("keeps a measured zero apart from a withheld rate", () => {
		const counts = offChartBreakdown([
			row({
				itemId: "idle",
				avgDailyUsage: 0,
				daysOfStock: null,
				projectedStockoutDate: null,
				severity: "warning",
			}),
			row({
				itemId: "broken-unit",
				qtyConsumed: null,
				avgDailyUsage: null,
				consumptionBasis: { units: ["box", "each"], unit: null, mixed: true },
				daysOfStock: null,
				projectedStockoutDate: null,
				severity: "warning",
			}),
		]);
		expect(counts).toEqual({ mixedUnits: 1, noRate: 1, beyondWindow: 0 });
	});

	it("ignores plotted items and items that aren't at risk", () => {
		const counts = offChartBreakdown([
			row({ itemId: "plotted", daysOfStock: 4, severity: "critical" }),
			row({ itemId: "far-healthy", daysOfStock: 90, severity: "healthy" }),
			row({
				itemId: "no-signal",
				avgDailyUsage: 0,
				daysOfStock: null,
				projectedStockoutDate: null,
				severity: "unknown",
			}),
		]);
		expect(counts).toEqual({ mixedUnits: 0, noRate: 0, beyondWindow: 0 });
	});
});

describe("hasReorderChartContent", () => {
	it("is true when something plots", () => {
		expect(hasReorderChartContent([row({ daysOfStock: 12 })])).toBe(true);
	});

	it("is true when nothing plots but an at-risk item needs the off-chart note", () => {
		expect(
			hasReorderChartContent([
				row({
					avgDailyUsage: 0,
					daysOfStock: null,
					projectedStockoutDate: null,
					severity: "critical",
				}),
			]),
		).toBe(true);
	});

	it("is false when nothing plots and nothing is at risk", () => {
		expect(
			hasReorderChartContent([
				row({ daysOfStock: 120, severity: "healthy" }),
				row({
					avgDailyUsage: 0,
					daysOfStock: null,
					projectedStockoutDate: null,
					severity: "unknown",
				}),
			]),
		).toBe(false);
	});
});
