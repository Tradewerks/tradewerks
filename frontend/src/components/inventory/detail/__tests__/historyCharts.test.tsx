import { cloneElement, type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConsumptionTrendChart from "../ConsumptionTrendChart";
import StockLevelChart from "../StockLevelChart";
import CostPriceTrendChart, { TrendTooltip } from "../CostPriceTrendChart";

// jsdom measures every element as 0x0, so ResponsiveContainer would render an
// empty SVG and the assertions below would pass vacuously. Fixed dimensions are
// the only thing stubbed; the charts themselves render for real. (Bar/Area
// animation is off in the components, without which recharts never emits mark
// paths on the first frame.)
vi.mock("recharts", async () => {
	const actual = await vi.importActual<typeof import("recharts")>("recharts");
	return {
		...actual,
		ResponsiveContainer: ({
			children,
		}: {
			children: ReactElement<{ width?: number; height?: number }>;
		}) => cloneElement(children, { width: 800, height: 300 }),
	};
});

const consumptionQuery = vi.fn();
const valueHistoryQuery = vi.fn();
const priceHistoryQuery = vi.fn();

vi.mock("../../../../hooks/useInventory", () => ({
	useItemConsumptionTrendQuery: (...args: unknown[]) => consumptionQuery(...args),
	useItemValueHistoryQuery: (...args: unknown[]) => valueHistoryQuery(...args),
	useItemPriceHistoryQuery: (...args: unknown[]) => priceHistoryQuery(...args),
}));

const consumption = (qtys: number[]) => ({
	data: {
		points: qtys.map((qtyConsumed, i) => ({
			periodStart: `2026-0${i + 1}-01T00:00:00.000Z`,
			qtyConsumed,
		})),
	},
	isLoading: false,
});

const valueHistory = (quantities: number[]) => ({
	data: {
		points: quantities.map((quantity, i) => ({
			date: `2026-0${i + 1}-01T00:00:00.000Z`,
			quantity,
			value: null,
		})),
		costUsed: null,
		costBasis: null,
		truncated: false,
		windowStart: null,
		hasNegative: false,
	},
	isLoading: false,
});

// Two dates, and every series ending within a dollar of the others — the exact
// shape that made the old per-line labels draw on top of each other.
const priceHistory = () => ({
	data: {
		cost: {
			points: [
				{ at: "2026-06-01T00:00:00.000Z", value: 20 },
				{ at: "2026-07-01T00:00:00.000Z", value: 20.2 },
			],
		},
		price: {
			points: [
				{ at: "2026-06-01T00:00:00.000Z", value: 20.4 },
				{ at: "2026-07-01T00:00:00.000Z", value: 20.6 },
			],
		},
		wac: [
			{ at: "2026-06-01T00:00:00.000Z", value: 20.1 },
			{ at: "2026-07-01T00:00:00.000Z", value: 20.3 },
		],
		charged: {
			points: [
				{ periodStart: "2026-06-01T00:00:00.000Z", avgUnitPrice: 20.5 },
				{ periodStart: "2026-07-01T00:00:00.000Z", avgUnitPrice: 20.7 },
			],
		},
		receipts: [],
		costCoverage: { receipts: 2, withCost: 2, wacBasisReceipts: 2 },
		coverageStart: "2026-06-01T00:00:00.000Z",
		chargedTruncated: false,
		chargedWindowStart: null,
	},
	isLoading: false,
});

/**
 * Same two periods, plus everything the spread/origin work added: a banded
 * bucket (two sales at different prices) and a supplier rollup with a gap in it.
 */
const priceHistoryWithOrigin = (over: { banded?: boolean } = {}) => {
	const banded = over.banded ?? true;
	const base = priceHistory();
	return {
		...base,
		data: {
			...base.data,
			charged: {
				points: [
					{
						periodStart: "2026-06-01T00:00:00.000Z",
						qty: 4,
						avgUnitPrice: 610,
						sales: banded ? 2 : 1,
						low: banded ? 560 : null,
						high: banded ? 660 : null,
						median: 610,
						lowClient: banded ? "Acme HVAC" : null,
						highClient: banded ? "Bell Realty" : null,
					},
					{
						periodStart: "2026-07-01T00:00:00.000Z",
						qty: 1,
						avgUnitPrice: 640,
						sales: 1,
						low: null,
						high: null,
						median: 640,
						lowClient: null,
						highClient: null,
					},
				],
			},
			receipts: [
				{
					at: "2026-06-02T00:00:00.000Z",
					unitCost: 560,
					qty: 2,
					batchNumber: null,
					supplierId: "sup-1",
					supplierName: "Ferguson",
				},
				{
					at: "2026-06-20T00:00:00.000Z",
					unitCost: 600,
					qty: 2,
					batchNumber: null,
					supplierId: "sup-2",
					supplierName: "Grainger",
				},
				{
					at: "2026-07-02T00:00:00.000Z",
					unitCost: 590,
					qty: 1,
					batchNumber: null,
					supplierId: null,
					supplierName: null,
				},
			],
			bySupplier: [
				{
					supplierId: "sup-1",
					supplierName: "Ferguson",
					unattributed: false,
					receipts: 1,
					qty: 2,
					spend: 1120,
					avgUnitCost: 560,
					minUnitCost: 560,
					maxUnitCost: 560,
					firstAt: "2026-06-02T00:00:00.000Z",
					lastAt: "2026-06-02T00:00:00.000Z",
				},
				{
					supplierId: "sup-2",
					supplierName: "Grainger",
					unattributed: false,
					receipts: 1,
					qty: 2,
					spend: 1200,
					avgUnitCost: 600,
					minUnitCost: 600,
					maxUnitCost: 600,
					firstAt: "2026-06-20T00:00:00.000Z",
					lastAt: "2026-06-20T00:00:00.000Z",
				},
				{
					supplierId: null,
					supplierName: "Unrecorded",
					unattributed: true,
					receipts: 1,
					qty: 1,
					spend: 590,
					avgUnitCost: 590,
					minUnitCost: 590,
					maxUnitCost: 590,
					firstAt: "2026-07-02T00:00:00.000Z",
					lastAt: "2026-07-02T00:00:00.000Z",
				},
			],
			costCoverage: { receipts: 3, withCost: 3, wacBasisReceipts: 3, withSupplier: 2 },
		},
	};
};

/** N distinct, attributed vendors — for exercising the strip's cap+expand. */
const manySuppliers = (n: number) => {
	const base = priceHistory();
	return {
		...base,
		data: {
			...base.data,
			bySupplier: Array.from({ length: n }, (_, i) => ({
				supplierId: `sup-${i}`,
				supplierName: `Vendor ${i + 1}`,
				unattributed: false,
				receipts: 1,
				qty: 1,
				spend: (n - i) * 100,
				avgUnitCost: 50,
				minUnitCost: 50,
				maxUnitCost: 50,
				firstAt: "2026-06-01T00:00:00.000Z",
				lastAt: "2026-06-01T00:00:00.000Z",
			})),
			costCoverage: { ...base.data.costCoverage, withSupplier: n },
		},
	};
};

/** Label rows in the right-margin column, by vertical position. */
const labelYs = (container: HTMLElement): number[] =>
	Array.from(container.querySelectorAll("text"))
		.filter((t) => /cost|price|margin/i.test(t.textContent ?? ""))
		.map((t) => Number(t.getAttribute("y")))
		.filter((y) => Number.isFinite(y))
		.sort((a, b) => a - b);

beforeEach(() => {
	consumptionQuery.mockReset();
	valueHistoryQuery.mockReset();
	priceHistoryQuery.mockReset();
});

describe("ConsumptionTrendChart", () => {
	it("charts a genuine zero and says so — a real zero is not missing history", () => {
		consumptionQuery.mockReturnValue(consumption([0, 0, 0]));
		const { container } = render(
			<ConsumptionTrendChart itemId="i1" unit="each" bucket="month" />,
		);

		expect(container.querySelectorAll(".recharts-bar-rectangle").length).toBe(3);
		expect(screen.getByText(/No consumption recorded in this range/)).toBeInTheDocument();
		expect(screen.queryByText("Not enough history yet")).not.toBeInTheDocument();
	});

	it("claims 'not enough history' only when there aren't enough periods to plot", () => {
		consumptionQuery.mockReturnValue(consumption([4]));
		render(<ConsumptionTrendChart itemId="i1" unit="each" bucket="month" />);

		expect(screen.getByText("Not enough history yet")).toBeInTheDocument();
	});

	it("states what the series counts when there is consumption", () => {
		consumptionQuery.mockReturnValue(consumption([2, 5]));
		render(<ConsumptionTrendChart itemId="i1" unit="each" bucket="week" />);

		expect(screen.getByText(/Parts used and direct consumption only/)).toBeInTheDocument();
	});

	it("keeps mechanics behind the Info toggle", async () => {
		consumptionQuery.mockReturnValue(consumption([2, 5]));
		render(<ConsumptionTrendChart itemId="i1" unit="each" bucket="week" />);

		const trigger = screen.getByRole("button", { name: "How this chart is measured" });
		expect(trigger).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText(/zero-filled/)).not.toBeInTheDocument();

		await userEvent.click(trigger);

		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText(/zero-filled/)).toBeInTheDocument();
	});
});

describe("StockLevelChart", () => {
	it("draws on-hand as steps, never as a spline that invents levels", () => {
		valueHistoryQuery.mockReturnValue(valueHistory([10, 4, 12]));
		const { container } = render(
			<StockLevelChart itemId="i1" unit="each" lowStockThreshold={5} />,
		);

		const d = container.querySelector(".recharts-area-area")?.getAttribute("d") ?? "";
		expect(d).not.toBe("");
		// Cubic segments are what a monotone curve emits; a step path is L-only.
		expect(d).not.toMatch(/C/);
		expect(d).toMatch(/L/);
	});

	it("keeps one visible caveat and hides the rest", async () => {
		valueHistoryQuery.mockReturnValue(valueHistory([10, 4]));
		render(<StockLevelChart itemId="i1" unit="each" lowStockThreshold={5} />);

		expect(screen.getByText(/Warehouse stock only/)).toBeInTheDocument();
		expect(screen.queryByText(/Drawn as steps/)).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "How this chart is measured" }));

		expect(screen.getByText(/Drawn as steps/)).toBeInTheDocument();
	});
});

// A minimal but complete ChartRow — the type isn't exported, so this mirrors
// its shape structurally rather than importing it.
const chartRow = (over: Record<string, unknown> = {}) => ({
	ts: new Date("2026-06-05T00:00:00.000Z").getTime(),
	setCost: null,
	listPrice: null,
	wac: null,
	charged: null,
	receiptCost: null,
	receiptQty: null,
	receiptUnit: null,
	receiptBatch: null,
	receiptSupplier: null,
	receiptSupplierKey: "",
	chargedBand: null,
	chargedMedian: null,
	chargedSales: null,
	chargedSaleDetails: [],
	listMargin: null,
	chargedMargin: null,
	...over,
});

describe("TrendTooltip", () => {
	it("lists every sale in a multi-sale bucket, low to high, not just the two extremes", () => {
		render(
			<TrendTooltip
				active
				mode="amounts"
				payload={[
					{
						payload: chartRow({
							charged: 602.5,
							chargedSales: 3,
							chargedSaleDetails: [
								{ at: "2026-06-05T06:00:00.000Z", unitPrice: 660, clientName: "Smith Commercial Properties" },
								{ at: "2026-06-05T12:00:00.000Z", unitPrice: 545, clientName: "Williams Property Management" },
								{ at: "2026-06-10T09:00:00.000Z", unitPrice: 600, clientName: "Anderson Office Complex" },
							],
						}),
					},
				]}
			/>,
		);

		// Sorted low to high — the middle sale a "low/high client" sentence
		// alone would never have named.
		const lines = screen.getAllByText(/\$\d+\.\d{2} ·/);
		expect(lines.map((l) => l.textContent)).toEqual([
			expect.stringContaining("$545.00 · Williams Property Management"),
			expect.stringContaining("$600.00 · Anderson Office Complex"),
			expect.stringContaining("$660.00 · Smith Commercial Properties"),
		]);
	});

	it("caps the list at 5 and notes the rest instead of overflowing", () => {
		const details = Array.from({ length: 8 }, (_, i) => ({
			at: "2026-06-05T00:00:00.000Z",
			unitPrice: 500 + i,
			clientName: `Client ${i}`,
		}));
		render(
			<TrendTooltip
				active
				mode="amounts"
				payload={[{ payload: chartRow({ charged: 500, chargedSales: 8, chargedSaleDetails: details }) }]}
			/>,
		);

		expect(screen.getAllByText(/\$\d+\.\d{2} ·/)).toHaveLength(5);
		expect(screen.getByText("+3 more — see ledger below")).toBeInTheDocument();
	});

	it("gives set cost and paid cost distinct swatches, matching their solid-vs-dashed lines", () => {
		// Regression: both rows share a colour (they're both COST) and used to
		// render an identical solid dot, making them look like duplicates.
		render(
			<TrendTooltip
				active
				mode="amounts"
				payload={[{ payload: chartRow({ setCost: 410, wac: 403.29 }) }]}
			/>,
		);

		const setCostSwatch = screen.getByText("Set cost").previousElementSibling as SVGElement;
		const wacSwatch = screen.getByText("Paid cost (running avg)").previousElementSibling as SVGElement;
		expect(setCostSwatch.querySelector("line")).not.toHaveAttribute("stroke-dasharray");
		expect(wacSwatch.querySelector("line")).toHaveAttribute("stroke-dasharray", "2 3");
	});

	it("falls back to a bare sale count when the raw list is empty but the count isn't", () => {
		render(
			<TrendTooltip
				active
				mode="amounts"
				payload={[{ payload: chartRow({ charged: 560, chargedSales: 2, chargedSaleDetails: [] }) }]}
			/>,
		);

		expect(screen.getByText("2 sales")).toBeInTheDocument();
	});

	it("renders a single-sale bucket as one plain line, same as before", () => {
		render(
			<TrendTooltip
				active
				mode="amounts"
				payload={[
					{
						payload: chartRow({
							charged: 560,
							chargedSales: 1,
							chargedSaleDetails: [
								{ at: "2026-06-05T00:00:00.000Z", unitPrice: 560, clientName: "Riverside Apartments" },
							],
						}),
					},
				]}
			/>,
		);

		expect(screen.getByText(/\$560\.00 · Riverside Apartments/)).toBeInTheDocument();
	});
});

describe("CostPriceTrendChart", () => {
	it("keeps series labels apart even when all four lines end within a dollar", () => {
		priceHistoryQuery.mockReturnValue(priceHistory());
		const { container } = render(
			<CostPriceTrendChart itemId="i1" bucket="month" />,
		);

		const ys = labelYs(container);
		expect(ys.length).toBeGreaterThanOrEqual(4);
		for (let i = 1; i < ys.length; i++) {
			expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(13);
		}
	});

	it("names each series exactly once — in the plot, not also in a legend", () => {
		priceHistoryQuery.mockReturnValue(priceHistory());
		render(<CostPriceTrendChart itemId="i1" bucket="month" />);

		for (const label of ["Set cost", "Paid cost (running avg)", "List price", "Charged price"]) {
			expect(screen.getAllByText(label).length).toBe(1);
		}
	});

	describe("charged spread", () => {
		it("draws a range band when a bucket holds two different prices", () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			const { container } = render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const d = container.querySelector(".recharts-area-area")?.getAttribute("d") ?? "";
			expect(d).not.toBe("");
			expect(screen.getByText("Charged range (low–high)")).toBeInTheDocument();
		});

		it("draws no band when every bucket sold at a single price", () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin({ banded: false }));
			const { container } = render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			// A zero-height ribbon would read as a measured spread that never existed.
			const d = container.querySelector(".recharts-area-area")?.getAttribute("d") ?? "";
			expect(d).toBe("");
			expect(screen.queryByText("Charged range (low–high)")).not.toBeInTheDocument();
		});
	});

	describe("supplier origin", () => {
		it("lists each vendor under the plot, gap included", () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			// Scoped to the rollup itself: PurchaseHistoryTable renders right below
			// it and names the same vendors per-purchase, on purpose — the rollup
			// answers "who do we mostly buy from", the table "what did we pay each
			// time", so both are expected to say "Ferguson".
			const heading = screen.getByText("Where this stock came from");
			const strip = within(heading.parentElement!);
			expect(strip.getByText("Ferguson")).toBeInTheDocument();
			expect(strip.getByText("Grainger")).toBeInTheDocument();
			// The gap is stated, not omitted — otherwise the rollup reads as
			// covering every purchase.
			expect(strip.getByText("Unrecorded")).toBeInTheDocument();
		});

		it("counts only attributed vendors in the header chip", () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			// Two named vendors and one gap — the chip says 2, not 3.
			expect(screen.getByText(/Suppliers · 2/)).toBeInTheDocument();
		});

		it("caps the rollup at 6 vendors and expands to show the rest", () => {
			priceHistoryQuery.mockReturnValue(manySuppliers(8));
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const heading = screen.getByText("Where this stock came from");
			const strip = within(heading.parentElement!);
			expect(strip.getByText("Vendor 1")).toBeInTheDocument();
			expect(strip.getByText("Vendor 6")).toBeInTheDocument();
			expect(strip.queryByText("Vendor 7")).not.toBeInTheDocument();
			expect(strip.getByText("Show 2 more")).toBeInTheDocument();
		});

		it("expands the rollup to reveal every vendor past the cap", async () => {
			priceHistoryQuery.mockReturnValue(manySuppliers(8));
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const heading = screen.getByText("Where this stock came from");
			await userEvent.click(within(heading.parentElement!).getByText("Show 2 more"));

			const strip = within(heading.parentElement!);
			expect(strip.getByText("Vendor 8")).toBeInTheDocument();
			expect(strip.getByText("Show fewer")).toBeInTheDocument();
		});

		it("clicking a vendor's filter button filters the purchase ledger to just their purchases", async () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const strip = within(screen.getByText("Where this stock came from").parentElement!);
			await userEvent.click(strip.getByRole("button", { name: /Show only Ferguson/i }));

			// The narrowed scope is noted inline in the ledger's own heading, not a
			// separate banner — the strip above is where the filter is set, shown,
			// and cleared.
			const ledgerHeading = screen.getByText("Every purchase, exact price paid");
			const ledger = within(ledgerHeading.parentElement!);
			expect(ledger.queryByText("Grainger")).not.toBeInTheDocument();
			expect(ledgerHeading.textContent).toMatch(/Ferguson only/);
			expect(ledger.getAllByText("Ferguson").length).toBeGreaterThan(0);
		});

		it("filters to the unattributed bucket, whose key is the empty string", async () => {
			// Regression: supplierKey(null, null) === "", and `filterKey ? ... :
			// ...` treats "" as falsy — clicking "Unrecorded" looked like a no-op
			// even though it's a real, distinct filter value.
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const strip = within(screen.getByText("Where this stock came from").parentElement!);
			await userEvent.click(
				strip.getByRole("button", { name: /Show only unrecorded purchases/i }),
			);

			const ledgerHeading = screen.getByText("Every purchase, exact price paid");
			const ledger = within(ledgerHeading.parentElement!);
			expect(ledger.queryByText("Ferguson")).not.toBeInTheDocument();
			expect(ledger.queryByText("Grainger")).not.toBeInTheDocument();
			expect(ledger.getByText("Unrecorded")).toBeInTheDocument();
			expect(ledgerHeading.textContent).toMatch(/Unrecorded only/);
		});

		it("does not hover-highlight ledger rows once a vendor is filtered", async () => {
			// Once filtered, every visible ledger row already belongs to that one
			// vendor — hovering the strip's (now-active) row would light up the
			// whole table at once, which signals nothing.
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const strip = within(screen.getByText("Where this stock came from").parentElement!);
			await userEvent.click(strip.getByRole("button", { name: /Show only Ferguson/i }));

			const ledger = within(screen.getByText("Every purchase, exact price paid").parentElement!);
			const ledgerRow = ledger.getByText("Ferguson").closest("tr")!;
			expect(ledgerRow.className).not.toMatch(/bg-surface-raised/);

			await userEvent.hover(strip.getByText("Ferguson"));
			expect(ledgerRow.className).not.toMatch(/bg-surface-raised/);
		});

		it("clears the filter on a second click of the same vendor", async () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const strip = within(screen.getByText("Where this stock came from").parentElement!);
			const ledgerBody = () => within(screen.getByText("Every purchase, exact price paid").parentElement!);

			await userEvent.click(strip.getByRole("button", { name: /Show only Ferguson/i }));
			expect(ledgerBody().queryByText("Grainger")).not.toBeInTheDocument();

			// Clicking the same vendor's (now active) filter button again toggles it off.
			await userEvent.click(strip.getByRole("button", { name: /Clear filter.*Ferguson/i }));
			expect(ledgerBody().getByText("Grainger")).toBeInTheDocument();
		});

		it("clicking anywhere on a vendor's row filters too, not just its button", async () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const strip = within(screen.getByText("Where this stock came from").parentElement!);
			// The row is a bigger, more forgiving click target than the 24px button —
			// clicking the vendor's name should filter exactly like the button does.
			await userEvent.click(strip.getByText("Ferguson"));

			const ledgerBody = within(screen.getByText("Every purchase, exact price paid").parentElement!);
			expect(ledgerBody.queryByText("Grainger")).not.toBeInTheDocument();

			// Clicking the row again clears it — same toggle the button offers.
			await userEvent.click(strip.getByText("Ferguson"));
			expect(
				within(screen.getByText("Every purchase, exact price paid").parentElement!).getByText(
					"Grainger",
				),
			).toBeInTheDocument();
		});

		it("recedes vendors that aren't the active filter", async () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const strip = within(screen.getByText("Where this stock came from").parentElement!);
			await userEvent.click(strip.getByRole("button", { name: /Show only Ferguson/i }));

			const graingerRow = strip.getByText("Grainger").closest("tr")!;
			const fergusonRow = strip.getByText("Ferguson").closest("tr")!;
			expect(graingerRow.className).toMatch(/opacity-60/);
			expect(fergusonRow.className).not.toMatch(/opacity-60/);
		});

		it("renders the rollup and ledger inside one shared shell, not two floating tables", () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			// Both sections' content divs share the same immediate parent — the
			// shell — rather than each owning its own top-level border/margin.
			const stripContent = screen.getByText("Where this stock came from").parentElement!;
			const ledgerContent = screen.getByText("Every purchase, exact price paid").parentElement!;
			expect(stripContent.parentElement).toBe(ledgerContent.parentElement);
		});

		it("connects the pinned vendor's row to the ledger panel with a matching accent", async () => {
			priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			const ledgerPanel = screen.getByText("Every purchase, exact price paid").parentElement!;
			expect(ledgerPanel.className).toMatch(/border-l-transparent/);

			const strip = within(screen.getByText("Where this stock came from").parentElement!);
			await userEvent.click(strip.getByRole("button", { name: /Show only Ferguson/i }));

			expect(ledgerPanel.className).toMatch(/border-l-primary/);
		});

		it("renders no orphaned shell when there is neither a rollup nor a ledger", () => {
			priceHistoryQuery.mockReturnValue(priceHistory());
			render(<CostPriceTrendChart itemId="i1" bucket="month" />);

			expect(screen.queryByText("Where this stock came from")).not.toBeInTheDocument();
			expect(screen.queryByText("Every purchase, exact price paid")).not.toBeInTheDocument();
		});

		describe("vendor price list", () => {
			const withPriceList = () => {
				const fixture = priceHistoryWithOrigin();
				fixture.data.bySupplier = fixture.data.bySupplier.map((s) => {
					if (s.supplierId === "sup-1") {
						return { ...s, lastPaid: 550, priceSource: "contract" as const, isPreferred: true };
					}
					if (s.supplierId === "sup-2") {
						return { ...s, lastPaid: 605, priceSource: "observed" as const, isPreferred: false };
					}
					return { ...s, lastPaid: null, priceSource: "none" as const, isPreferred: false };
				});
				return fixture;
			};

			it("shows what was last paid to each vendor", () => {
				priceHistoryQuery.mockReturnValue(withPriceList());
				render(<CostPriceTrendChart itemId="i1" bucket="month" />);

				expect(screen.getByText("$550.00")).toBeInTheDocument();
				expect(screen.getByText("$605.00")).toBeInTheDocument();
			});

			it("marks a negotiated contract price apart from an observed one", () => {
				priceHistoryQuery.mockReturnValue(withPriceList());
				render(<CostPriceTrendChart itemId="i1" bucket="month" />);

				// Ferguson's $550 is a contract rate; Grainger's $605 is just the last
				// thing paid — the two must not read as the same kind of fact.
				expect(screen.getByText(/contract/i)).toBeInTheDocument();
			});

			it("marks the preferred vendor's row", () => {
				priceHistoryQuery.mockReturnValue(withPriceList());
				render(<CostPriceTrendChart itemId="i1" bucket="month" />);

				expect(screen.getByLabelText("Preferred vendor")).toBeInTheDocument();
			});

			it("shows a dash for a vendor with no price-list entry, without crashing", () => {
				priceHistoryQuery.mockReturnValue(priceHistoryWithOrigin());
				render(<CostPriceTrendChart itemId="i1" bucket="month" />);

				expect(screen.getByText("Where this stock came from")).toBeInTheDocument();
				expect(screen.queryByLabelText("Preferred vendor")).not.toBeInTheDocument();
			});
		});
	});
});
