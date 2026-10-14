import { cloneElement, type ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import ConsumptionTrendChart from "../ConsumptionTrendChart";
import StockLevelChart from "../StockLevelChart";
import StockMovementList from "../StockMovementList";
import UsageReport from "../UsageReport";
import TrackingSummaryStats from "../TrackingSummaryStats";
import ReorderHealthMini from "../ReorderHealthMini";
import StockPlacementCard from "../StockPlacementCard";
import type { InventoryItem } from "../../../../types/inventory";

// Every detail card must route a query error into a failed-read state instead
// of falling through to its empty state, because "No history yet" / a row of
// zeros is a false claim about data that is still there — not proof there's
// nothing to show. Each card says the read failed and offers a retry wired to
// the query's refetch.

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
const forecastQuery = vi.fn();
const movementsQuery = vi.fn();
const usageQuery = vi.fn();
const trackingSummaryQuery = vi.fn();

vi.mock("../../../../hooks/useInventory", () => ({
	useItemConsumptionTrendQuery: (...a: unknown[]) => consumptionQuery(...a),
	useItemValueHistoryQuery: (...a: unknown[]) => valueHistoryQuery(...a),
	useItemForecastQuery: (...a: unknown[]) => forecastQuery(...a),
	useInventoryMovementsQuery: (...a: unknown[]) => movementsQuery(...a),
	useItemUsageQuery: (...a: unknown[]) => usageQuery(...a),
}));
vi.mock("../../../../hooks/useTracking", () => ({
	useTrackingSummaryQuery: (...a: unknown[]) => trackingSummaryQuery(...a),
	useItemVehicleStockQuery: () => ({ data: undefined, isLoading: false }),
}));

const refetch = vi.fn();
const failed = () => ({ data: undefined, isLoading: false, isError: true, refetch });

const item = {
	id: "i1",
	name: "Widget",
	unit: "each",
	quantity: 4,
	is_serialized: true,
	is_batch_tracked: false,
} as InventoryItem;

beforeEach(() => {
	vi.clearAllMocks();
	consumptionQuery.mockReturnValue(failed());
	valueHistoryQuery.mockReturnValue(failed());
	forecastQuery.mockReturnValue(failed());
	movementsQuery.mockReturnValue(failed());
	usageQuery.mockReturnValue(failed());
	trackingSummaryQuery.mockReturnValue(failed());
});

async function expectErrorWithRetry(what: RegExp) {
	expect(screen.getByText(what)).toBeInTheDocument();
	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(refetch).toHaveBeenCalledTimes(1);
}

describe("detail cards on a failed read", () => {
	it("StockLevelChart says the read failed instead of 'No history yet'", async () => {
		render(<StockLevelChart itemId="i1" unit="each" lowStockThreshold={null} />);
		expect(screen.queryByText("No history yet")).not.toBeInTheDocument();
		await expectErrorWithRetry(/Couldn't load stock level history/);
	});

	it("ConsumptionTrendChart says the read failed instead of 'Not enough history yet'", async () => {
		render(<ConsumptionTrendChart itemId="i1" unit="each" bucket="month" />);
		expect(screen.queryByText("Not enough history yet")).not.toBeInTheDocument();
		await expectErrorWithRetry(/Couldn't load the consumption trend/);
	});

	it("StockMovementList says the read failed instead of 'No stock movements yet'", async () => {
		render(
			<MemoryRouter>
				<StockMovementList itemId="i1" />
			</MemoryRouter>,
		);
		expect(screen.queryByText(/No stock movements yet/)).not.toBeInTheDocument();
		await expectErrorWithRetry(/Couldn't load stock history/);
	});

	it("UsageReport says the read failed instead of 'No usage yet'", async () => {
		render(
			<MemoryRouter>
				<UsageReport itemId="i1" />
			</MemoryRouter>,
		);
		expect(screen.queryByText("No usage yet")).not.toBeInTheDocument();
		await expectErrorWithRetry(/Couldn't load usage by job/);
	});

	it("TrackingSummaryStats says the read failed instead of tiling zeros", async () => {
		render(<TrackingSummaryStats item={item} />);
		expect(screen.queryByText("0")).not.toBeInTheDocument();
		await expectErrorWithRetry(/Couldn't load the tracking summary/);
	});

	it("ReorderHealthMini says the forecast is unavailable instead of 'No signal yet'", async () => {
		render(<ReorderHealthMini itemId="i1" onViewHistory={vi.fn()} />);
		expect(screen.queryByText(/No signal yet|Not forecast/)).not.toBeInTheDocument();
		expect(screen.getByText("Reorder health unavailable")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(refetch).toHaveBeenCalledTimes(1);
	});

	it("StockPlacementCard fails on the source it actually reads (tracking summary for a tracked item)", async () => {
		render(
			<MemoryRouter>
				<StockPlacementCard item={item} archived={false} onViewAll={vi.fn()} />
			</MemoryRouter>,
		);
		await expectErrorWithRetry(/Couldn't load stock placement/);
	});
});

describe("StockLevelChart under a range", () => {
	const valueHistory = (
		quantities: number[],
		over: Partial<{ openingQuantity: number | null; windowStart: string | null }> = {},
	) => ({
		data: {
			unitBasis: { units: ["each"], unit: "each", mixed: false },
			points: quantities.map((quantity, i) => ({
				date: `2026-03-0${i + 1}T00:00:00.000Z`,
				quantity,
				value: null,
			})),
			currentCost: null,
			costUsed: null,
			costBasis: null,
			truncated: false,
			openingQuantity: null,
			windowStart: null,
			hasNegative: false,
			...over,
		},
		isLoading: false,
		isError: false,
		refetch,
	});
	const RANGE_START = Date.parse("2026-02-01T00:00:00.000Z");
	const xDomain: [number, number] = [RANGE_START, Date.parse("2026-03-10T00:00:00.000Z")];
	const stepCount = (container: HTMLElement) =>
		(container.querySelector(".recharts-area-curve")?.getAttribute("d") ?? "").split("L").length - 1;

	it("anchors the series at the range start with the opening level, so stock doesn't appear from nothing", () => {
		valueHistoryQuery.mockReturnValue(valueHistory([10, 4]));
		const unanchored = render(
			<StockLevelChart itemId="i1" unit="each" lowStockThreshold={null} />,
		);
		const plain = stepCount(unanchored.container);
		unanchored.unmount();

		valueHistoryQuery.mockReturnValue(
			valueHistory([10, 4], { openingQuantity: 7, windowStart: "2026-03-01T00:00:00.000Z" }),
		);
		const anchored = render(
			<StockLevelChart
				itemId="i1"
				unit="each"
				lowStockThreshold={null}
				createdAfter="2026-02-01T00:00:00.000Z"
				xDomain={xDomain}
			/>,
		);
		// One more point → one more step (two L segments) in the step path.
		expect(stepCount(anchored.container)).toBe(plain + 2);
	});

	it("uses range-aware copy when nothing moved in the range", () => {
		valueHistoryQuery.mockReturnValue(valueHistory([]));
		render(
			<StockLevelChart
				itemId="i1"
				unit="each"
				lowStockThreshold={null}
				createdAfter="2026-02-01T00:00:00.000Z"
				xDomain={xDomain}
			/>,
		);
		expect(screen.getByText("No movements in this range")).toBeInTheDocument();
		expect(screen.queryByText("No history yet")).not.toBeInTheDocument();
	});

	it("keeps 'No history yet' for an item with no ledger at all", () => {
		valueHistoryQuery.mockReturnValue(valueHistory([]));
		render(<StockLevelChart itemId="i1" unit="each" lowStockThreshold={null} />);
		expect(screen.getByText("No history yet")).toBeInTheDocument();
	});
});
