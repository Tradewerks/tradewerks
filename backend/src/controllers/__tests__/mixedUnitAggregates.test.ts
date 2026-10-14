import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	getItemUsage,
	getItemConsumptionTrend,
	getItemValueHistory,
	getItemPriceHistory,
} from "../inventoryController.js";
import { getInventoryReorderForecast, getInventoryReport } from "../reportsController.js";
import { db } from "../../db.js";
import { Prisma } from "../../../generated/prisma/client.js";

/**
 * Mixed-unit READ behaviour across every aggregate that sums `stock_movement.qty`.
 * A ledger spanning a unit change isn't summable, so each aggregate flags the
 * series via a shared `UnitBasis` and withholds the total instead of mixing
 * denominations. Each case is paired with a clean single-unit run, and the item's
 * own `unit` is always a third value the ledger never used.
 */
vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		inventory_item: { findFirst: vi.fn(), findMany: vi.fn() },
		log: { findMany: vi.fn() },
		stock_movement: { findMany: vi.fn(), groupBy: vi.fn() },
		// The forecast now attaches a preferred vendor per row; these fixtures
		// have no vendors, so an empty list is the truthful stub.
		supplier_item: { findMany: vi.fn().mockResolvedValue([]) },
		$queryRaw: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/lowStockAlerts.js", () => ({
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/socketService.js", () => ({ emitInventoryUpdated: vi.fn() }));
vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: vi.fn(),
	InsufficientStockError: class extends Error {},
	getOrCreateBatch: vi.fn(),
	InsufficientBatchStockError: class extends Error {},
	TrackingValidationError: class extends Error {},
	lockInventoryRows: vi.fn(),
}));
vi.mock("../../services/inventoryTracking.js", () => ({
	shortCode: vi.fn(() => "LOT-TEST"),
	buildTrackingInputs: vi.fn(),
	TrackingValidationError: class extends Error {},
	lockBatchRows: vi.fn(),
	lockSerialRows: vi.fn(),
}));

const mockDb = vi.mocked(db) as unknown as {
	inventory_item: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
	log: { findMany: ReturnType<typeof vi.fn> };
	stock_movement: { findMany: ReturnType<typeof vi.fn>; groupBy: ReturnType<typeof vi.fn> };
	$queryRaw: ReturnType<typeof vi.fn>;
};

const ORG = "org-1";
const ITEM = "item-1";

// Deliberately a third value no movement below uses, so a basis derived from the
// item instead of the stamped rows would show up as a failure.
const ITEM_UNIT = "pallet";

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.inventory_item.findFirst.mockResolvedValue({
		id: ITEM,
		unit: ITEM_UNIT,
		cost: 4,
		unit_price: 9,
		is_active: true,
		created_at: new Date("2026-01-01T00:00:00.000Z"),
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /inventory/:id/usage — SUM(qty) per job + client
// ─────────────────────────────────────────────────────────────────────────────
describe("getItemUsage — mixed units", () => {
	const usageRow = (overrides: Record<string, unknown> = {}) => ({
		jobId: "job-1",
		jobNumber: "J-1",
		jobName: "Rooftop swap",
		clientId: "client-1",
		clientName: "Acme",
		qtyConsumed: 12,
		units: ["each"],
		lastConsumedAt: new Date("2026-06-01T00:00:00.000Z"),
		...overrides,
	});

	it("totals a single-unit group and reports its unit", async () => {
		mockDb.$queryRaw.mockResolvedValue([usageRow()]);

		const result = await getItemUsage(ITEM, ORG);

		expect(result.usage![0].qtyConsumed).toBe(12);
		expect(result.usage![0].unitBasis).toEqual({ units: ["each"], unit: "each", mixed: false });
		expect(result.unitBasis).toEqual({ units: ["each"], unit: "each", mixed: false });
	});

	it("withholds a group's total when that group spans a unit change", async () => {
		mockDb.$queryRaw.mockResolvedValue([usageRow({ units: ["box", "each"] })]);

		const result = await getItemUsage(ITEM, ORG);

		expect(result.usage![0].qtyConsumed).toBeNull();
		expect(result.usage![0].unitBasis.mixed).toBe(true);
		expect(result.usage![0].unitBasis.units).toEqual(["box", "each"]);
	});

	// The case a per-row-only flag would miss: both totals are individually true, but
	// the column stacks 12 each against 3 box, so the page needs its own flag.
	it("flags the page when rows are individually clean but disagree with each other", async () => {
		mockDb.$queryRaw.mockResolvedValue([
			usageRow({ jobId: "job-1", units: ["each"], qtyConsumed: 12 }),
			usageRow({ jobId: "job-2", units: ["box"], qtyConsumed: 3 }),
		]);

		const result = await getItemUsage(ITEM, ORG);

		expect(result.usage!.map((u) => u.qtyConsumed)).toEqual([12, 3]);
		expect(result.unitBasis).toEqual({ units: ["box", "each"], unit: null, mixed: true });
	});

	it("never reports the item's current unit as the basis", async () => {
		mockDb.$queryRaw.mockResolvedValue([usageRow()]);

		const result = await getItemUsage(ITEM, ORG);

		expect(result.unitBasis.units).not.toContain(ITEM_UNIT);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /inventory/:id/consumption-trend — SUM(qty) per bucket
// ─────────────────────────────────────────────────────────────────────────────
describe("getItemConsumptionTrend — mixed units", () => {
	const buckets = (qtys: number[], units: string[] | null) =>
		qtys.map((qtyConsumed, i) => ({
			periodStart: new Date(Date.UTC(2026, i, 1)),
			qtyConsumed,
			units,
		}));

	it("totals every bucket when the whole window is one unit", async () => {
		mockDb.$queryRaw.mockResolvedValue(buckets([4, 0, 7], ["each"]));

		const result = await getItemConsumptionTrend(ITEM, ORG);

		expect(result.points!.map((p) => p.qtyConsumed)).toEqual([4, 0, 7]);
		expect(result.unitBasis).toEqual({ units: ["each"], unit: "each", mixed: false });
	});

	it("withholds the WHOLE series on a unit break, not just the seam bucket", async () => {
		mockDb.$queryRaw.mockResolvedValue(buckets([4, 0, 7], ["box", "each"]));

		const result = await getItemConsumptionTrend(ITEM, ORG);

		// Nulls, never zeroes: this series is zero-filled, so 0 already means "nothing
		// was consumed" and cannot double as "cannot be totalled".
		expect(result.points!.map((p) => p.qtyConsumed)).toEqual([null, null, null]);
		expect(result.unitBasis.mixed).toBe(true);
		// The buckets themselves survive — the chart still has an axis to explain
		// itself over, rather than collapsing to a bare empty state.
		expect(result.points).toHaveLength(3);
		expect(result.points![0].periodStart).toBe("2026-01-01T00:00:00.000Z");
	});

	it("treats a window with no movements as unmixed rather than unknown", async () => {
		mockDb.$queryRaw.mockResolvedValue(buckets([0, 0], null));

		const result = await getItemConsumptionTrend(ITEM, ORG);

		expect(result.points!.map((p) => p.qtyConsumed)).toEqual([0, 0]);
		expect(result.unitBasis).toEqual({ units: [], unit: null, mixed: false });
	});

	it("derives the basis from stamped rows, not the item's current unit", async () => {
		mockDb.$queryRaw.mockResolvedValue(buckets([4], ["each"]));

		const result = await getItemConsumptionTrend(ITEM, ORG);

		expect(result.unitBasis.unit).toBe("each");
		expect(result.unitBasis.unit).not.toBe(ITEM_UNIT);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Reversal netting — usage + consumption-trend must agree with the forecast
// ─────────────────────────────────────────────────────────────────────────────

/** Flattens a mocked `$queryRaw` tagged-template call (strings + values, where a
 * value may itself be a nested Prisma.sql fragment) into one SQL string with `?`
 * placeholders — the text Prisma would actually send. */
function sqlSentTo(call: unknown[]): string {
	const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
	return Prisma.sql(strings, ...values).sql.replace(/\s+/g, " ");
}

const REVERSAL_CASE = "CASE WHEN sm.reason = 'reversal' THEN -sm.qty ELSE sm.qty END";
const CONSUMPTION_PREDICATE =
	"( sm.reason IN ('parts_used', 'direct_consumption') OR (sm.reason = 'reversal' AND sm.from_location_type = 'consumed') )";

describe("reversal netting — the SQL sent to Postgres", () => {
	// updatePartsUsedQty writes `reversal` movements (consumed → vehicle) when a
	// parts-used line is decreased/deleted. The reorder forecast already subtracts
	// them; before this the item page summed parts_used/direct_consumption only, so
	// the detail page said 5 while Reorder Health said 2.
	it("getItemUsage nets reversals with the shared predicate + signed CASE", async () => {
		mockDb.$queryRaw.mockResolvedValue([]);

		await getItemUsage(ITEM, ORG);

		const sql = sqlSentTo(mockDb.$queryRaw.mock.calls[0]);
		expect(sql).toContain(`SUM(${REVERSAL_CASE})::float AS "qtyConsumed"`);
		expect(sql).toContain(CONSUMPTION_PREDICATE);
		// The unsigned sum is gone entirely — no path still adds reversals as usage.
		expect(sql).not.toContain("SUM(sm.qty)");
	});

	// Reversing a line to zero DELETES the line item (SetNull on
	// stock_movement.visit_line_item_id). An INNER JOIN through the line item then
	// dropped the original AND its reversal, so the group no longer netted to 0.
	it("getItemUsage joins the job through sm.visit_id, not the (deletable) line item", async () => {
		mockDb.$queryRaw.mockResolvedValue([]);

		await getItemUsage(ITEM, ORG);

		const sql = sqlSentTo(mockDb.$queryRaw.mock.calls[0]);
		expect(sql).toContain("JOIN job_visit jv ON jv.id = sm.visit_id");
		expect(sql).not.toContain("JOIN job_visit_line_item");
		// Fully-reversed jobs are not usage.
		expect(sql).toContain(`HAVING SUM(${REVERSAL_CASE}) <> 0`);
	});

	it("getItemConsumptionTrend nets reversals in the bucketed sum and its unit basis", async () => {
		mockDb.$queryRaw.mockResolvedValue([]);

		await getItemConsumptionTrend(ITEM, ORG);

		const sql = sqlSentTo(mockDb.$queryRaw.mock.calls[0]);
		expect(sql).toContain(`SUM(${REVERSAL_CASE}) AS qty`);
		// Both the consumption CTE and the series_units CTE carry the predicate, so
		// the basis is derived from exactly the rows that were summed.
		expect(sql.split(CONSUMPTION_PREDICATE)).toHaveLength(3);
		expect(sql).not.toContain("SUM(sm.qty)");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /inventory/:id/value-history — running warehouse balance + paid-cost WAC
// ─────────────────────────────────────────────────────────────────────────────
describe("getItemValueHistory — mixed units", () => {
	const movement = (overrides: Record<string, unknown> = {}) => ({
		id: "mv-1",
		qty: 10,
		from_location_type: "supplier",
		to_location_type: "warehouse",
		created_at: new Date("2026-06-01T00:00:00.000Z"),
		...overrides,
	});

	const ledgerAgg = (units: string[] | null, extra: Record<string, unknown> = {}) => [
		{ openingQuantity: 0, paidQty: 10, paidSpend: 50, units, ...extra },
	];

	it("replays and prices the balance when the ledger is one unit", async () => {
		mockDb.stock_movement.findMany.mockResolvedValue([movement()]);
		mockDb.$queryRaw.mockResolvedValue(ledgerAgg(["each"]));

		const result = await getItemValueHistory(ITEM, ORG);

		expect(result.points![0].quantity).toBe(10);
		expect(result.costUsed).toBe(5); // 50 spend / 10 qty
		expect(result.costBasis).toBe("paid");
		expect(result.unitBasis!.mixed).toBe(false);
	});

	it("returns no points and no cost basis when the ledger spans a unit change", async () => {
		mockDb.stock_movement.findMany.mockResolvedValue([movement()]);
		mockDb.$queryRaw.mockResolvedValue(ledgerAgg(["box", "each"]));

		const result = await getItemValueHistory(ITEM, ORG);

		// A running balance is cumulative, so no subset of it is salvageable.
		expect(result.points).toEqual([]);
		expect(result.openingQuantity).toBeNull();
		// The weighted average divides spend by a cross-unit quantity, so it goes too.
		expect(result.costUsed).toBeNull();
		expect(result.costBasis).toBeNull();
		// The configured cost is an item field, not a ledger aggregate — still true.
		expect(result.currentCost).toBe(4);
		expect(result.unitBasis!.mixed).toBe(true);
		expect(result.unitBasis!.units).toEqual(["box", "each"]);
	});

	// The subtle one: the visible window holds a single unit, but its starting level
	// is recovered by summing every OLDER row, so the level is contaminated anyway.
	it("flags a single-unit window whose opening balance is summed across the seam", async () => {
		mockDb.stock_movement.findMany.mockResolvedValue([movement()]);
		mockDb.$queryRaw.mockResolvedValue(ledgerAgg(["box", "each"], { openingQuantity: 40 }));

		const result = await getItemValueHistory(ITEM, ORG, {
			created_after: "2026-05-01T00:00:00.000Z",
		});

		expect(result.unitBasis!.mixed).toBe(true);
		expect(result.points).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /inventory/:id/price-history — per-receipt cost + running WAC
// ─────────────────────────────────────────────────────────────────────────────
describe("getItemPriceHistory — mixed units", () => {
	const receipt = (unit: string, unitCost: number, day: number) => ({
		created_at: new Date(Date.UTC(2026, 5, day)),
		qty: 10,
		unit,
		unit_cost: unitCost,
		movement_batches: [],
	});

	beforeEach(() => {
		mockDb.log.findMany.mockResolvedValue([]);
		mockDb.$queryRaw.mockResolvedValue([]); // charged-price buckets
	});

	it("runs the weighted average when every receipt shares a unit", async () => {
		mockDb.stock_movement.findMany.mockResolvedValue([
			receipt("each", 5, 1),
			receipt("each", 7, 2),
		]);

		const result = await getItemPriceHistory(ITEM, ORG);

		expect(result.wac!.map((w) => w.value)).toEqual([5, 6]);
		expect(result.unitBasis!.mixed).toBe(false);
	});

	it("drops the average but keeps each receipt, stamped with its own unit", async () => {
		mockDb.stock_movement.findMany.mockResolvedValue([
			receipt("each", 5, 1),
			receipt("box", 90, 2),
		]);

		const result = await getItemPriceHistory(ITEM, ORG);

		// No line to read a false trend off: $5/each and $90/box are not one series.
		expect(result.wac).toEqual([]);
		// The receipts themselves are individual facts and stay — but only because
		// each now names its own denomination instead of borrowing the item's.
		expect(result.receipts!.map((r) => [r.unitCost, r.unit])).toEqual([
			[5, "each"],
			[90, "box"],
		]);
		expect(result.unitBasis!.units).toEqual(["box", "each"]);
		// Coverage is a COUNT of receipts, so a unit break does not make it untrue.
		expect(result.costCoverage!.wacBasisReceipts).toBe(2);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Reorder forecast — consumption rate, runway and severity
// ─────────────────────────────────────────────────────────────────────────────
// Module-scoped so the vendor suite below can build the same raw row.
const forecastRow = (overrides: Record<string, unknown> = {}) => ({
	itemId: ITEM,
	itemName: "Line set",
	sku: "LS-1",
	category: null,
	unit: ITEM_UNIT,
	warehouseQty: 100,
	vehicleQty: 0,
	qtyConsumed: 90,
	consumedUnits: ["each"],
	lowStockThreshold: null,
	createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
	firstConsumedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
	...overrides,
});

describe("buildReorderForecast — mixed units", () => {
	it("computes a rate and a runway from single-unit consumption", async () => {
		mockDb.$queryRaw.mockResolvedValue([forecastRow()]);

		const { rows } = await getInventoryReorderForecast(ORG, { lookbackDays: 90 });

		expect(rows[0].qtyConsumed).toBe(90);
		expect(rows[0].avgDailyUsage).toBeCloseTo(1, 5);
		expect(rows[0].daysOfStock).toBeCloseTo(100, 5);
		expect(rows[0].consumptionBasis.mixed).toBe(false);
	});

	it("withholds rate, runway and stockout date together on a unit break", async () => {
		mockDb.$queryRaw.mockResolvedValue([forecastRow({ consumedUnits: ["box", "each"] })]);

		const { rows } = await getInventoryReorderForecast(ORG, { lookbackDays: 90 });

		expect(rows[0].qtyConsumed).toBeNull();
		expect(rows[0].avgDailyUsage).toBeNull();
		expect(rows[0].daysOfStock).toBeNull();
		expect(rows[0].projectedStockoutDate).toBeNull();
		// On-hand comes from the cached quantity columns, which are always in the
		// item's current unit — not a ledger sum, so it is not withheld.
		expect(rows[0].currentQuantity).toBe(100);
		// A span of days is unit-free and survives.
		expect(rows[0].observedDays).toBeGreaterThan(0);
		// No rate to band on, and no threshold to fall back to: "unknown" is already
		// the verdict for "nothing to judge on", so no new severity is invented.
		expect(rows[0].severity).toBe("unknown");
		expect(rows[0].consumptionBasis.units).toEqual(["box", "each"]);
	});

	// A unit break must not launder a genuinely urgent item into a soft verdict: the
	// reorder point compares two cached columns and never touches the ledger.
	it("still reports critical below the reorder point despite a unit break", async () => {
		mockDb.$queryRaw.mockResolvedValue([
			forecastRow({ consumedUnits: ["box", "each"], warehouseQty: 2, lowStockThreshold: 10 }),
		]);

		const { rows } = await getInventoryReorderForecast(ORG, { lookbackDays: 90 });

		expect(rows[0].belowReorderPoint).toBe(true);
		expect(rows[0].severity).toBe("critical");
		expect(rows[0].avgDailyUsage).toBeNull();
	});
});

// The forecast could always say WHAT to buy and WHEN. These cover the half that
// was missing: who from, at what price, and how confident either answer is.
describe("reorder forecast — preferred vendor", () => {
	const vendorRow = (over: Record<string, unknown> = {}) => ({
		inventory_item_id: "item-1",
		supplier_id: "sup-1",
		vendor_sku: "FRG-88213",
		contract_price: null,
		last_price: 572.15,
		last_purchased_at: new Date("2026-08-02T00:00:00.000Z"),
		is_preferred: false,
		supplier: { name: "Ferguson" },
		...over,
	});

	beforeEach(() => {
		mockDb.$queryRaw.mockResolvedValue([
			forecastRow({ itemId: "item-1", warehouseQty: 2, lowStockThreshold: 10 }),
		]);
	});

	it("names a chosen vendor and prices the gap to the reorder point", async () => {
		mockDb.supplier_item.findMany.mockResolvedValue([
			vendorRow({ is_preferred: true, contract_price: 560 }),
		]);

		const { rows } = await getInventoryReorderForecast(ORG, { lookbackDays: 90 });

		expect(rows[0].preferredSupplierName).toBe("Ferguson");
		expect(rows[0].vendorSku).toBe("FRG-88213");
		expect(rows[0].vendorSource).toBe("preferred");
		// A negotiated rate beats what we happened to pay last time.
		expect(rows[0].preferredUnitPrice).toBe(560);
		expect(rows[0].priceSource).toBe("contract");
		// 10 threshold − 2 on hand = 8 to buy.
		expect(rows[0].shortfallQty).toBe(8);
		expect(rows[0].estimatedShortfallCost).toBe(4480);
	});

	it("falls back to the last vendor bought from, and says that's what it did", async () => {
		mockDb.supplier_item.findMany.mockResolvedValue([vendorRow()]);

		const { rows } = await getInventoryReorderForecast(ORG, { lookbackDays: 90 });

		// Useful, but flagged — presenting a fallback as a decision would be a lie.
		expect(rows[0].preferredSupplierName).toBe("Ferguson");
		expect(rows[0].vendorSource).toBe("recent");
		expect(rows[0].priceSource).toBe("observed");
		expect(rows[0].preferredUnitPrice).toBe(572.15);
	});

	it("leaves every vendor field null when nobody sells it to us on record", async () => {
		mockDb.supplier_item.findMany.mockResolvedValue([]);

		const { rows } = await getInventoryReorderForecast(ORG, { lookbackDays: 90 });

		expect(rows[0].preferredSupplierId).toBeNull();
		expect(rows[0].preferredUnitPrice).toBeNull();
		expect(rows[0].vendorSource).toBe("none");
		expect(rows[0].priceSource).toBe("none");
		// The quantity is still known — only the vendor half is missing.
		expect(rows[0].shortfallQty).toBe(8);
		expect(rows[0].estimatedShortfallCost).toBeNull();
	});

	it("ignores a deactivated vendor", async () => {
		mockDb.supplier_item.findMany.mockResolvedValue([]);

		await getInventoryReorderForecast(ORG, { lookbackDays: 90 });

		// A retired vendor must not be the answer to "who do I buy this from".
		expect(mockDb.supplier_item.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ supplier: { is_active: true } }),
			}),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Full inventory report — qtyUsed per item, grouped by (item, unit)
// ─────────────────────────────────────────────────────────────────────────────
describe("getInventoryReport — mixed units", () => {
	beforeEach(() => {
		mockDb.inventory_item.findMany.mockResolvedValue([
			{
				id: ITEM,
				name: "Line set",
				description: "",
				unit: ITEM_UNIT,
				quantity: 100,
				low_stock_threshold: null,
				cost: 4,
				unit_price: 9,
				is_active: true,
				location: "A1",
				alt_ids: [],
				tags: [],
				vehicle_stocks: [],
				updated_at: new Date(),
			},
		]);
	});

	it("sums usage for an item consumed in one unit", async () => {
		mockDb.stock_movement.groupBy.mockResolvedValue([
			{ inventory_item_id: ITEM, unit: "each", _sum: { qty: 30 } },
		]);

		const [row] = await getInventoryReport(ORG, { includeInactive: false });

		expect(row.qtyUsed).toBe(30);
		expect(row.qtyUsedBasis.mixed).toBe(false);
	});

	it("withholds usage when the item was consumed in two units", async () => {
		mockDb.stock_movement.groupBy.mockResolvedValue([
			{ inventory_item_id: ITEM, unit: "each", _sum: { qty: 30 } },
			{ inventory_item_id: ITEM, unit: "box", _sum: { qty: 4 } },
		]);

		const [row] = await getInventoryReport(ORG, { includeInactive: false });

		// Not 34, and not 0 either — 0 is the real answer for "never consumed", so it
		// cannot double as "cannot be totalled" in a report people export and act on.
		expect(row.qtyUsed).toBeNull();
		expect(row.qtyUsedBasis.units).toEqual(["box", "each"]);
	});

	it("reports zero usage as zero, not as a unit break", async () => {
		mockDb.stock_movement.groupBy.mockResolvedValue([]);

		const [row] = await getInventoryReport(ORG, { includeInactive: false });

		expect(row.qtyUsed).toBe(0);
		expect(row.qtyUsedBasis).toEqual({ units: [], unit: null, mixed: false });
	});

	it("groups the ledger by unit as well as item, so a break is visible at all", async () => {
		mockDb.stock_movement.groupBy.mockResolvedValue([]);

		await getInventoryReport(ORG, { includeInactive: false });

		// reason is in the key only so reversal rows can be subtracted; the unit
		// dimension is what makes a break visible.
		expect(mockDb.stock_movement.groupBy.mock.calls[0][0].by).toEqual([
			"inventory_item_id",
			"unit",
			"reason",
		]);
	});

	it("nets consumption reversals like the reorder forecast does", async () => {
		mockDb.stock_movement.groupBy.mockResolvedValue([
			{ inventory_item_id: ITEM, unit: "each", reason: "parts_used", _sum: { qty: 30 } },
			{ inventory_item_id: ITEM, unit: "each", reason: "reversal", _sum: { qty: 10 } },
		]);

		const [row] = await getInventoryReport(ORG, { includeInactive: false });

		// 30 used, 10 of that reversed → 20 consumed; one unit, so not a break.
		expect(row.qtyUsed).toBe(20);
		expect(row.qtyUsedBasis).toEqual({ units: ["each"], unit: "each", mixed: false });
	});

	it("only pulls reversals that undo consumption, not transfer reversals", async () => {
		mockDb.stock_movement.groupBy.mockResolvedValue([]);

		await getInventoryReport(ORG, { includeInactive: false });

		expect(mockDb.stock_movement.groupBy.mock.calls[0][0].where.OR).toEqual([
			{ reason: { in: ["parts_used", "direct_consumption"] } },
			{ reason: "reversal", from_location_type: "consumed" },
		]);
	});
});
