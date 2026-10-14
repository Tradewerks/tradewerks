import { cloneElement, type ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ReorderPriorityChart from "../ReorderPriorityChart";
import type { ReorderForecastRow } from "../../../types/reports";

// jsdom reports every element as 0x0, so ResponsiveContainer would render an
// empty SVG and every assertion below would be vacuously true without this.
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({
			children,
		}: {
			children: ReactElement<{ width?: number; height?: number }>;
		}) => cloneElement(children, { width: 800, height: 400 }),
	};
});

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
	// No vendor by default — these cases are about the chart's geometry, and a
	// case that cares about a supplier says so.
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

/**
 * Bars in top-down order. jsdom can't measure SVG text, so assertions use bar
 * geometry and fill color instead of label text.
 */
const barsTopDown = (container: HTMLElement): { width: number; fill: string }[] =>
	Array.from(container.querySelectorAll(".recharts-bar-rectangle path"))
		.map((path) => ({
			y: Number(path.getAttribute("y") ?? 0),
			width: Number(path.getAttribute("width") ?? 0),
			fill: path.getAttribute("fill") ?? "",
		}))
		.sort((a, b) => a.y - b.y)
		.map(({ width, fill }) => ({ width, fill }));

const barCount = (container: HTMLElement): number =>
	container.querySelectorAll(".recharts-bar-rectangle").length;

/** One end-of-bar runway label per bar — the value without a hover. */
const runwayLabelCount = (container: HTMLElement): number =>
	container.querySelectorAll(".recharts-label-list text").length;

const renderChart = (data: ReorderForecastRow[]) =>
	render(
		<MemoryRouter>
			<ReorderPriorityChart data={data} />
		</MemoryRouter>,
	);

describe("ReorderPriorityChart", () => {
	it("puts the worst runway at the top", () => {
		const { container } = renderChart([
			row({ itemId: "a", itemName: "Slow", daysOfStock: 25, severity: "healthy" }),
			row({ itemId: "b", itemName: "Urgent", daysOfStock: 3, severity: "critical" }),
			row({ itemId: "c", itemName: "Mid", daysOfStock: 9, severity: "warning" }),
		]);
		const bars = barsTopDown(container);
		expect(bars.map((b) => b.fill)).toEqual([
			"var(--color-chart-error)",
			"var(--color-chart-warning)",
			"var(--color-chart-success)",
		]);
		// Shortest runway on top, and bar length rises with the runway.
		expect(bars[0].width).toBeLessThan(bars[1].width);
		expect(bars[1].width).toBeLessThan(bars[2].width);
	});

	it("labels every bar with its runway, so the value never needs a hover", () => {
		const { container } = renderChart([
			row({ itemId: "a", daysOfStock: 4 }),
			row({ itemId: "b", daysOfStock: 9 }),
		]);
		expect(runwayLabelCount(container)).toBe(barCount(container));
		expect(barCount(container)).toBe(2);
	});

	it("always states how days of stock is derived", () => {
		renderChart([row()]);
		expect(screen.getByText(/Days of stock = org-wide on hand/)).toBeInTheDocument();
	});

	it("names both reasons an at-risk item can be missing from the bars", () => {
		renderChart([
			row({ itemId: "plotted", daysOfStock: 5, severity: "critical" }),
			row({
				itemId: "no-rate",
				avgDailyUsage: 0,
				daysOfStock: null,
				projectedStockoutDate: null,
				severity: "warning",
			}),
			row({
				itemId: "far",
				daysOfStock: 45,
				belowReorderPoint: true,
				severity: "critical",
			}),
		]);
		expect(screen.getByText(/\+1 need attention with no usage rate/)).toBeInTheDocument();
		expect(
			screen.getByText(/\+1 below reorder point with more than 30 days of stock/),
		).toBeInTheDocument();
	});

	it("pages the set instead of squeezing every item into one card", async () => {
		const data = Array.from({ length: 12 }, (_, i) =>
			row({
				itemId: `i${i}`,
				itemName: `Item ${String(i).padStart(2, "0")}`,
				daysOfStock: i + 1,
			}),
		);
		const { container } = renderChart(data);

		expect(screen.getByText("1–10 of 12")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Previous items" })).toBeDisabled();
		expect(barCount(container)).toBe(10);

		await userEvent.click(screen.getByRole("button", { name: "Next items" }));

		expect(screen.getByText("11–12 of 12")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next items" })).toBeDisabled();
		expect(barCount(container)).toBe(2);
	});

	it("hides the pager when everything fits on one page", () => {
		renderChart([row()]);
		expect(screen.queryByRole("button", { name: "Next items" })).not.toBeInTheDocument();
	});
});
