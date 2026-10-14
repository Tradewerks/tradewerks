import { describe, it, expect, vi, beforeEach } from "vitest";
import { getItemPriceHistory } from "../inventoryController.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		inventory_item: { findFirst: vi.fn() },
		log: { findMany: vi.fn() },
		stock_movement: { findMany: vi.fn() },
		supplier_item: { findMany: vi.fn() },
		$queryRaw: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../reportsController.js", () => ({ getItemReorderForecast: vi.fn() }));
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
	inventory_item: { findFirst: ReturnType<typeof vi.fn> };
	log: { findMany: ReturnType<typeof vi.fn> };
	stock_movement: { findMany: ReturnType<typeof vi.fn> };
	supplier_item: { findMany: ReturnType<typeof vi.fn> };
	$queryRaw: ReturnType<typeof vi.fn>;
};

const ORG = "org-1";
const ITEM = "item-1";
const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");

function setupItem(overrides: Record<string, unknown> = {}) {
	mockDb.inventory_item.findFirst.mockResolvedValue({
		id: ITEM,
		cost: 44,
		unit_price: 99,
		created_at: CREATED_AT,
		...overrides,
	});
}

// Tests that don't care about charged price / receipts get empty ones.
function setupNoSales() {
	mockDb.$queryRaw.mockResolvedValue([]);
	mockDb.stock_movement.findMany.mockResolvedValue([]);
	mockDb.supplier_item.findMany.mockResolvedValue([]);
}

function logEntry(at: string, changes: Record<string, unknown>) {
	return { timestamp: new Date(at), changes };
}

// The charged-price query is a tagged template, so the literal fragments arrive
// as the first argument. Joining them (interpolations dropped) is enough to
// assert on the SQL's SHAPE — which clock it buckets by, what it filters out.
function chargedSql() {
	return (mockDb.$queryRaw.mock.calls[0][0] as string[]).join("");
}

// The client-attribution query is the SECOND raw call — it duplicates the
// aggregate's bucket expression and filters, and a divergence would credit a
// client to the wrong period.
function extremesSql() {
	return (mockDb.$queryRaw.mock.calls[1][0] as string[]).join("");
}

interface ReceiptOrigin {
	batchNumber?: string;
	/** Movement-level vendor — how every receipt records origin from this release on. */
	supplier?: { id: string; name: string };
	/** Lot-level entity, for a receipt into a lot bought before the movement column existed. */
	batchSupplierRef?: { id: string; name: string };
	/** Lot-level LEGACY free text — a name with no id. */
	batchSupplier?: string;
}

function receipt(
	at: string,
	qty: number,
	unit_cost: number | null,
	origin: string | ReceiptOrigin = {},
) {
	const o: ReceiptOrigin = typeof origin === "string" ? { batchNumber: origin } : origin;
	const hasBatch = o.batchNumber != null || o.batchSupplierRef != null || o.batchSupplier != null;
	return {
		created_at: new Date(at),
		qty,
		unit_cost,
		supplier: o.supplier ?? null,
		movement_batches: hasBatch
			? [
					{
						batch: {
							batch_number: o.batchNumber ?? null,
							supplier: o.batchSupplier ?? null,
							supplier_ref: o.batchSupplierRef ?? null,
						},
					},
				]
			: [],
	};
}

/** One charged bucket, with the spread fields the aggregate now selects. */
function chargedRow(
	periodStart: string,
	over: Partial<{
		qty: number;
		revenue: number;
		sales: number;
		low: number | null;
		high: number | null;
		median: number | null;
	}> = {},
) {
	return {
		periodStart: new Date(periodStart),
		qty: 0,
		revenue: 0,
		sales: 0,
		low: null,
		high: null,
		median: null,
		...over,
	};
}

/** Sequences the three raw queries: charged aggregate, client extremes, raw per-sale list. */
function setupCharged(rows: unknown[], extremes: unknown[] = [], sales: unknown[] = []) {
	mockDb.$queryRaw.mockReset();
	mockDb.$queryRaw
		.mockResolvedValueOnce(rows)
		.mockResolvedValueOnce(extremes)
		.mockResolvedValueOnce(sales);
}

/** The raw per-sale query is the THIRD raw call, after the aggregate and the extremes. */
function allSalesSql() {
	return (mockDb.$queryRaw.mock.calls[2][0] as string[]).join("");
}

describe("getItemPriceHistory", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setupItem();
		setupNoSales();
		mockDb.log.findMany.mockResolvedValue([]);
	});

	it("404s for an unknown item", async () => {
		mockDb.inventory_item.findFirst.mockResolvedValue(null);
		const result = await getItemPriceHistory(ITEM, ORG);
		expect(result.err).toContain("not found");
	});

	it("rejects an invalid bucket", async () => {
		const result = await getItemPriceHistory(ITEM, ORG, { bucket: "decade" });
		expect(result.err).toBeTruthy();
		expect(result.cost).toBeUndefined();
	});

	describe("step series", () => {
		it("anchors the series at created_at using the first change's old value", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-03-01T00:00:00.000Z", { cost: { old: 39, new: 44 } }),
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			const points = result.cost!.points;

			// created_at @ 39 (the pre-change value) → change @ 44 → live tail @ 44
			expect(points).toHaveLength(3);
			expect(points[0]).toEqual({ at: CREATED_AT.toISOString(), value: 39 });
			expect(points[1]).toEqual({ at: "2026-03-01T00:00:00.000Z", value: 44 });
			expect(points[2].value).toBe(44);
		});

		it("pins the tail point to the LIVE column value, not the last logged one", async () => {
			// Cost changed outside the audited path (or the log lost a row): the item
			// says 44 while the log's last known value says 41.
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-03-01T00:00:00.000Z", { cost: { old: 39, new: 41 } }),
			]);

			const points = (await getItemPriceHistory(ITEM, ORG)).cost!.points;
			expect(points[points.length - 1].value).toBe(44);
		});

		it("omits the created_at anchor when the field was previously unset", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-03-01T00:00:00.000Z", { cost: { old: null, new: 44 } }),
			]);

			const points = (await getItemPriceHistory(ITEM, ORG)).cost!.points;
			// No anchor — there was no earlier value being held.
			expect(points[0]).toEqual({ at: "2026-03-01T00:00:00.000Z", value: 44 });
			expect(points).toHaveLength(2);
		});

		it("coerces string-serialized Decimals", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-03-01T00:00:00.000Z", { cost: { old: "39.50", new: "44.25" } }),
			]);

			const points = (await getItemPriceHistory(ITEM, ORG)).cost!.points;
			expect(points[0].value).toBe(39.5);
			expect(points[1].value).toBe(44.25);
		});

		it("drops unusable change entries instead of plotting NaN", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-02-01T00:00:00.000Z", { cost: { old: 39, new: "not-a-number" } }),
				logEntry("2026-03-01T00:00:00.000Z", { cost: { old: 39, new: 44 } }),
			]);

			const points = (await getItemPriceHistory(ITEM, ORG)).cost!.points;
			expect(points.map((p) => p.value)).toEqual([39, 44, 44]);
		});

		it("treats a cleared value as a real null, not a drop", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-03-01T00:00:00.000Z", { cost: { old: 39, new: null } }),
			]);
			setupItem({ cost: null });

			const points = (await getItemPriceHistory(ITEM, ORG)).cost!.points;
			expect(points[1]).toEqual({ at: "2026-03-01T00:00:00.000Z", value: null });
		});

		it("returns a flat line for an item that was never edited", async () => {
			const points = (await getItemPriceHistory(ITEM, ORG)).cost!.points;
			expect(points).toHaveLength(2);
			expect(points[0]).toEqual({ at: CREATED_AT.toISOString(), value: 44 });
			expect(points[1].value).toBe(44);
		});

		it("returns nothing when there is no history AND no current value", async () => {
			setupItem({ cost: null, unit_price: null });
			const result = await getItemPriceHistory(ITEM, ORG);
			expect(result.cost!.points).toEqual([]);
			expect(result.price!.points).toEqual([]);
		});

		it("builds cost and unit_price independently from the same log rows", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-02-01T00:00:00.000Z", { cost: { old: 39, new: 44 } }),
				logEntry("2026-04-01T00:00:00.000Z", { unit_price: { old: 89, new: 99 } }),
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			expect(result.cost!.points.map((p) => p.value)).toEqual([39, 44, 44]);
			expect(result.price!.points.map((p) => p.value)).toEqual([89, 99, 99]);
		});

		it("keeps a re-stamped carry-in point at the window start", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-02-01T00:00:00.000Z", { cost: { old: 39, new: 41 } }),
				logEntry("2026-06-01T00:00:00.000Z", { cost: { old: 41, new: 44 } }),
			]);

			const from = "2026-05-01T00:00:00.000Z";
			const points = (await getItemPriceHistory(ITEM, ORG, { created_after: from })).cost!.points;

			// The pre-window value survives, restamped at the window start, so the
			// first visible segment isn't missing.
			expect(points[0]).toEqual({ at: new Date(from).toISOString(), value: 41 });
			expect(points[1]).toEqual({ at: "2026-06-01T00:00:00.000Z", value: 44 });
		});

		it("reports coverageStart from the earliest log row", async () => {
			mockDb.log.findMany.mockResolvedValue([
				logEntry("2026-02-01T00:00:00.000Z", { cost: { old: 39, new: 44 } }),
			]);
			const result = await getItemPriceHistory(ITEM, ORG);
			expect(result.coverageStart).toBe("2026-02-01T00:00:00.000Z");
		});

		it("reports a null coverageStart when the item has no audit history", async () => {
			const result = await getItemPriceHistory(ITEM, ORG);
			expect(result.coverageStart).toBeNull();
		});
	});

	describe("charged price", () => {
		it("averages revenue over quantity per bucket", async () => {
			mockDb.$queryRaw.mockResolvedValue([
				{ periodStart: new Date("2026-06-01T00:00:00.000Z"), qty: 4, revenue: 280 },
				{ periodStart: new Date("2026-07-01T00:00:00.000Z"), qty: 0, revenue: 0 },
			]);

			const result = await getItemPriceHistory(ITEM, ORG, { bucket: "month" });
			expect(result.charged!.bucket).toBe("month");
			expect(result.charged!.points[0].avgUnitPrice).toBe(70);
			// A zero-filled bucket is a real 0 sold, and has no average price.
			expect(result.charged!.points[1].qty).toBe(0);
			expect(result.charged!.points[1].avgUnitPrice).toBeNull();
		});

		it("defaults to weekly buckets", async () => {
			const result = await getItemPriceHistory(ITEM, ORG);
			expect(result.charged!.bucket).toBe("week");
		});

		it("accepts a range at the schema ceiling and clamps it per bucket", async () => {
			const result = await getItemPriceHistory(ITEM, ORG, { bucket: "month", range: 104 });
			expect(result.err).toBe("");
		});

		it("buckets by when the work happened, not when the row was inserted", async () => {
			await getItemPriceHistory(ITEM, ORG, { bucket: "month" });
			// A line item corrected weeks later still belongs to the visit's period.
			expect(chargedSql()).toContain(
				"date_trunc(, COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at))",
			);
		});

		it("excludes cancelled work from realized price", async () => {
			await getItemPriceHistory(ITEM, ORG);
			expect(chargedSql()).toContain("jv.status <> 'Cancelled'::visit_status");
			expect(chargedSql()).toContain("j.status <> 'Cancelled'::job_status");
		});

		it("spans the item's whole life when no range is given", async () => {
			// "All" on the tab sends neither created_after nor range. The charged
			// cutoff has to reach back to created_at, not to the 12-bucket default,
			// or the chart draws configured prices past where charged ones stop.
			const result = await getItemPriceHistory(ITEM, ORG, { bucket: "month" });
			expect(result.chargedWindowStart).toBe(CREATED_AT.toISOString());
			expect(result.chargedTruncated).toBe(false);
		});

		it("clamps to the bucket cap and says so when the item predates it", async () => {
			setupItem({ created_at: new Date("2015-01-01T00:00:00.000Z") });
			const result = await getItemPriceHistory(ITEM, ORG, { bucket: "month" });
			// 36-month cap: the cutoff moves in, and the truncation is REPORTED —
			// a leading zero-filled bucket looks identical to a cut-off one.
			expect(new Date(result.chargedWindowStart!).getTime()).toBeGreaterThan(
				new Date("2015-01-01T00:00:00.000Z").getTime(),
			);
			expect(result.chargedTruncated).toBe(true);
		});

		it("matches the requested window exactly when created_after is given", async () => {
			const from = "2026-05-01T00:00:00.000Z";
			const result = await getItemPriceHistory(ITEM, ORG, { created_after: from });
			expect(result.chargedWindowStart).toBe(new Date(from).toISOString());
			expect(result.chargedTruncated).toBe(false);
		});
	});

	describe("paid cost", () => {
		it("computes a running weighted average over priced receipts", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				{
					created_at: new Date("2026-02-01T00:00:00.000Z"),
					qty: 10,
					unit_cost: 40,
					movement_batches: [],
				},
				{
					created_at: new Date("2026-03-01T00:00:00.000Z"),
					qty: 10,
					unit_cost: 50,
					movement_batches: [{ batch: { batch_number: "LOT-A" } }],
				},
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			expect(result.wac!.map((w) => w.value)).toEqual([40, 45]);
			expect(result.receipts![1].batchNumber).toBe("LOT-A");
			expect(result.costCoverage).toEqual({
				receipts: 2,
				withCost: 2,
				wacBasisReceipts: 2,
				withSupplier: 0,
			});
		});

		it("excludes unpriced receipts from the average but still counts them", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				{ created_at: new Date("2026-02-01T00:00:00.000Z"), qty: 10, unit_cost: null, movement_batches: [] },
				{ created_at: new Date("2026-03-01T00:00:00.000Z"), qty: 10, unit_cost: 50, movement_batches: [] },
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			// 50, not 25 — a missing cost is unknown, not zero.
			expect(result.wac!.map((w) => w.value)).toEqual([50]);
			expect(result.costCoverage).toEqual({
				receipts: 2,
				withCost: 1,
				wacBasisReceipts: 1,
				withSupplier: 0,
			});
		});

		it("ignores receipts with a non-positive quantity", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				{ created_at: new Date("2026-02-01T00:00:00.000Z"), qty: 0, unit_cost: 40, movement_batches: [] },
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			expect(result.wac).toEqual([]);
			expect(result.receipts).toEqual([]);
			expect(result.costCoverage).toEqual({
				receipts: 1,
				withCost: 0,
				wacBasisReceipts: 0,
				withSupplier: 0,
			});
		});

		it("reads both warehouse receives and field supplier purchases", async () => {
			await getItemPriceHistory(ITEM, ORG);
			expect(mockDb.stock_movement.findMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						reason: { in: ["receive", "supplier_purchase"] },
					}),
				}),
			);
		});

		it("averages over ALL receipts regardless of the requested window", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 10, 40),
				receipt("2026-03-01T00:00:00.000Z", 10, 50),
				receipt("2026-06-01T00:00:00.000Z", 20, 80),
			]);

			const all = await getItemPriceHistory(ITEM, ORG);
			const windowed = await getItemPriceHistory(ITEM, ORG, {
				created_after: "2026-05-01T00:00:00.000Z",
			});

			// (10*40 + 10*50 + 20*80) / 40 = 62.5 — the June average is the same
			// number whichever chip is selected. A window-local average would say 80.
			expect(all.wac![all.wac!.length - 1].value).toBe(62.5);
			expect(windowed.wac![windowed.wac!.length - 1].value).toBe(62.5);
		});

		it("carries the average into the window but never re-stamps a receipt", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 10, 40),
				receipt("2026-06-01T00:00:00.000Z", 10, 60),
			]);

			const from = "2026-05-01T00:00:00.000Z";
			const result = await getItemPriceHistory(ITEM, ORG, { created_after: from });

			// The average enters the window holding 40 (re-stamped at the start) so
			// the line has a value from the left edge.
			expect(result.wac![0]).toEqual({ at: new Date(from).toISOString(), value: 40 });
			expect(result.wac![1].value).toBe(50);
			// The February purchase itself is NOT dragged forward — re-stamping a
			// receipt marker would draw a purchase that never happened that day.
			expect(result.receipts!.map((r) => r.at)).toEqual(["2026-06-01T00:00:00.000Z"]);
		});

		it("counts window receipts for coverage and all priced receipts as the basis", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 10, 40),
				receipt("2026-06-01T00:00:00.000Z", 10, 60),
				receipt("2026-06-15T00:00:00.000Z", 5, null),
			]);

			const result = await getItemPriceHistory(ITEM, ORG, {
				created_after: "2026-05-01T00:00:00.000Z",
			});

			expect(result.costCoverage).toEqual({
				receipts: 2,
				withCost: 1,
				wacBasisReceipts: 2,
				withSupplier: 0,
			});
		});
	});

	describe("charged price spread", () => {
		const JUNE = "2026-06-01T00:00:00.000Z";

		it("emits a band and names the client behind each end", async () => {
			setupCharged(
				[chargedRow(JUNE, { qty: 4, revenue: 2440, sales: 2, low: 560, high: 660, median: 610 })],
				[{ periodStart: new Date(JUNE), lowClient: "Acme HVAC", highClient: "Bell Realty" }],
			);

			const point = (await getItemPriceHistory(ITEM, ORG, { bucket: "month" })).charged!
				.points[0];

			expect(point.low).toBe(560);
			expect(point.high).toBe(660);
			expect(point.median).toBe(610);
			expect(point.sales).toBe(2);
			// The average is the number nobody paid — the whole point of the band.
			expect(point.avgUnitPrice).toBe(610);
			expect(point.lowClient).toBe("Acme HVAC");
			expect(point.highClient).toBe("Bell Realty");
		});

		it("emits no band for a single sale", async () => {
			setupCharged([
				chargedRow(JUNE, { qty: 1, revenue: 560, sales: 1, low: 560, high: 560, median: 560 }),
			]);

			const point = (await getItemPriceHistory(ITEM, ORG, { bucket: "month" })).charged!
				.points[0];

			// A zero-height ribbon reads as "we measured a spread" when there was none.
			expect(point.low).toBeNull();
			expect(point.high).toBeNull();
			expect(point.lowClient).toBeNull();
			expect(point.highClient).toBeNull();
			// The sale count and median still describe the bucket truthfully.
			expect(point.sales).toBe(1);
			expect(point.median).toBe(560);
		});

		it("emits no band when every sale in the bucket was at one price", async () => {
			setupCharged([
				chargedRow(JUNE, { qty: 3, revenue: 1680, sales: 3, low: 560, high: 560, median: 560 }),
			]);

			const point = (await getItemPriceHistory(ITEM, ORG, { bucket: "month" })).charged!
				.points[0];
			expect(point.low).toBeNull();
			expect(point.high).toBeNull();
			expect(point.avgUnitPrice).toBe(560);
		});

		it("drops a client attribution that lands on an unbanded bucket", async () => {
			setupCharged(
				[chargedRow(JUNE, { qty: 1, revenue: 560, sales: 1, low: 560, high: 560 })],
				[{ periodStart: new Date(JUNE), lowClient: "Acme HVAC", highClient: "Acme HVAC" }],
			);

			const point = (await getItemPriceHistory(ITEM, ORG, { bucket: "month" })).charged!
				.points[0];
			// Naming a "highest-paying client" for a bucket with one sale is noise.
			expect(point.lowClient).toBeNull();
		});

		it("attributes clients on the same clock the aggregate buckets by", async () => {
			await getItemPriceHistory(ITEM, ORG, { bucket: "month" });
			const sql = extremesSql();
			expect(sql).toContain(
				"date_trunc(, COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at))",
			);
			// Same exclusions too — a cancelled visit must not name the high payer.
			expect(sql).toContain("jv.status <> 'Cancelled'::visit_status");
			expect(sql).toContain("j.status <> 'Cancelled'::job_status");
		});
	});

	describe("charged.sales — raw per-sale list", () => {
		const JUNE = "2026-06-01T00:00:00.000Z";

		it("returns every sale unaggregated, not just the bucket's two extremes", async () => {
			setupCharged(
				[chargedRow(JUNE, { qty: 3, revenue: 1805, sales: 3, low: 545, high: 660, median: 600 })],
				[{ periodStart: new Date(JUNE), lowClient: "Williams", highClient: "Smith" }],
				[
					{ at: new Date("2026-06-05T06:00:00.000Z"), unitPrice: 660, clientName: "Smith" },
					{ at: new Date("2026-06-05T12:00:00.000Z"), unitPrice: 545, clientName: "Williams" },
					// The middle sale a bucket's low/high extremes alone would never name.
					{ at: new Date("2026-06-10T09:00:00.000Z"), unitPrice: 600, clientName: "Anderson" },
				],
			);

			const result = await getItemPriceHistory(ITEM, ORG, { bucket: "month" });

			expect(result.charged!.sales).toEqual([
				{ at: "2026-06-05T06:00:00.000Z", unitPrice: 660, clientName: "Smith" },
				{ at: "2026-06-05T12:00:00.000Z", unitPrice: 545, clientName: "Williams" },
				{ at: "2026-06-10T09:00:00.000Z", unitPrice: 600, clientName: "Anderson" },
			]);
		});

		it("drops a malformed row instead of letting it crash the endpoint", async () => {
			setupCharged(
				[chargedRow(JUNE)],
				[],
				[
					{ at: null, unitPrice: 660, clientName: "Smith" },
					{ at: new Date(JUNE), unitPrice: null, clientName: "Bad Row" },
					{ at: new Date(JUNE), unitPrice: 545, clientName: null },
				],
			);

			const result = await getItemPriceHistory(ITEM, ORG, { bucket: "month" });

			expect(result.charged!.sales).toEqual([
				{ at: new Date(JUNE).toISOString(), unitPrice: 545, clientName: null },
			]);
		});

		it("defaults to an empty list rather than crashing when nothing is queued", async () => {
			// Mirrors the other charged-price tests' bare mockResolvedValue([]) case,
			// where only one value is ever returned for every raw call.
			mockDb.$queryRaw.mockResolvedValue([]);
			const result = await getItemPriceHistory(ITEM, ORG, { bucket: "month" });
			expect(result.charged!.sales).toEqual([]);
		});

		it("shares the aggregate's exact filters, clock, and window boundary", async () => {
			await getItemPriceHistory(ITEM, ORG, { bucket: "month" });
			const sql = allSalesSql();
			expect(sql).toContain(
				"COALESCE(jv.actual_end_at, jv.scheduled_start_at, jli.created_at)",
			);
			expect(sql).toContain("jv.status <> 'Cancelled'::visit_status");
			expect(sql).toContain("j.status <> 'Cancelled'::job_status");
			// Same boundary the bucket aggregate's `buckets` CTE starts from — a
			// sale in one list but not the other would make the tooltip disagree
			// with the chart it's describing.
			expect(sql).toContain("date_trunc(, ::timestamptz)");
		});
	});

	describe("supplier origin", () => {
		it("groups receipts by vendor and counts attribution coverage", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 10, 40, {
					supplier: { id: "sup-1", name: "Ferguson" },
				}),
				receipt("2026-03-01T00:00:00.000Z", 10, 50, {
					supplier: { id: "sup-1", name: "Ferguson" },
				}),
				receipt("2026-04-01T00:00:00.000Z", 5, 60, {
					supplier: { id: "sup-2", name: "Grainger" },
				}),
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			const ferguson = result.bySupplier!.find((s) => s.supplierId === "sup-1")!;

			expect(ferguson.receipts).toBe(2);
			expect(ferguson.qty).toBe(20);
			expect(ferguson.spend).toBe(900);
			expect(ferguson.avgUnitCost).toBe(45);
			expect(ferguson.minUnitCost).toBe(40);
			expect(ferguson.maxUnitCost).toBe(50);
			expect(ferguson.firstAt).toBe("2026-02-01T00:00:00.000Z");
			expect(ferguson.lastAt).toBe("2026-03-01T00:00:00.000Z");
			expect(result.costCoverage!.withSupplier).toBe(3);
		});

		it("buckets unattributed receipts as Unrecorded, sorted last", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 100, 40),
				receipt("2026-03-01T00:00:00.000Z", 1, 50, {
					supplier: { id: "sup-1", name: "Ferguson" },
				}),
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			const last = result.bySupplier![result.bySupplier!.length - 1];

			// Last despite outspending every named vendor — a gap in the data is
			// not a supplier and must not head the list.
			expect(last.unattributed).toBe(true);
			expect(last.supplierName).toBe("Unrecorded");
			expect(last.supplierId).toBeNull();
			expect(result.costCoverage!.withSupplier).toBe(1);
		});

		it("falls back through the lot's entity, then its legacy free text", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 5, 40, {
					batchSupplierRef: { id: "sup-1", name: "Ferguson" },
				}),
				receipt("2026-03-01T00:00:00.000Z", 5, 50, { batchSupplier: "Grainger" }),
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			const byName = Object.fromEntries(
				result.bySupplier!.map((s) => [s.supplierName, s]),
			);

			expect(byName["Ferguson"].supplierId).toBe("sup-1");
			// A pre-migration vendor has a name and no id — it still groups, and
			// still counts as attributed, or every old purchase would read as a gap.
			expect(byName["Grainger"].supplierId).toBeNull();
			expect(byName["Grainger"].unattributed).toBe(false);
			expect(result.costCoverage!.withSupplier).toBe(2);
		});

		it("counts a receipt with a vendor but no cost toward coverage", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 5, null, {
					supplier: { id: "sup-1", name: "Ferguson" },
				}),
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			// Coverage is about attribution, not pricing — its denominator is every
			// windowed receipt, so an unpriced one still counts as named.
			expect(result.costCoverage).toEqual({
				receipts: 1,
				withCost: 0,
				wacBasisReceipts: 0,
				withSupplier: 1,
			});
			// It carries no cost, so it can't join a spend rollup.
			expect(result.bySupplier).toEqual([]);
		});

		it("prefers the vendor's contract price over its last observed price", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 10, 40, {
					supplier: { id: "sup-1", name: "Ferguson" },
				}),
			]);
			mockDb.supplier_item.findMany.mockResolvedValue([
				{ supplier_id: "sup-1", contract_price: 38, last_price: 42, is_preferred: true },
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			const ferguson = result.bySupplier!.find((s) => s.supplierId === "sup-1")!;

			expect(ferguson.lastPaid).toBe(38);
			expect(ferguson.priceSource).toBe("contract");
			expect(ferguson.isPreferred).toBe(true);
		});

		it("falls back to the observed last price when no contract is on file", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 10, 40, {
					supplier: { id: "sup-1", name: "Ferguson" },
				}),
			]);
			mockDb.supplier_item.findMany.mockResolvedValue([
				{ supplier_id: "sup-1", contract_price: null, last_price: 41, is_preferred: false },
			]);

			const result = await getItemPriceHistory(ITEM, ORG);
			const ferguson = result.bySupplier!.find((s) => s.supplierId === "sup-1")!;

			expect(ferguson.lastPaid).toBe(41);
			expect(ferguson.priceSource).toBe("observed");
			expect(ferguson.isPreferred).toBe(false);
		});

		it("reports no price-list data for a vendor with no supplier_item row, and none for the unattributed row", async () => {
			mockDb.stock_movement.findMany.mockResolvedValue([
				receipt("2026-02-01T00:00:00.000Z", 10, 40, {
					supplier: { id: "sup-1", name: "Ferguson" },
				}),
				receipt("2026-03-01T00:00:00.000Z", 5, 60),
			]);
			mockDb.supplier_item.findMany.mockResolvedValue([]);

			const result = await getItemPriceHistory(ITEM, ORG);
			const ferguson = result.bySupplier!.find((s) => s.supplierId === "sup-1")!;
			const unattributed = result.bySupplier!.find((s) => s.unattributed)!;

			expect(ferguson.lastPaid).toBeNull();
			expect(ferguson.priceSource).toBe("none");
			expect(unattributed.lastPaid).toBeNull();
			expect(unattributed.priceSource).toBe("none");
			expect(unattributed.isPreferred).toBe(false);
		});
	});
});
