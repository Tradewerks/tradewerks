import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = { $extends };
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn(),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../services/stockMovements.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../services/stockMovements.js")>();
	return {
		...actual,
		recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
		lockInventoryRows: vi.fn().mockResolvedValue(undefined),
	};
});

vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

import { adjustStock } from "../vehiclesController.js";
import { getScopedDb } from "../../lib/context.js";
import { recordMovements, InsufficientStockError } from "../../services/stockMovements.js";

const mockGetScopedDb = vi.mocked(getScopedDb);
const mockRecordMovements = vi.mocked(recordMovements);

function makeAdjustmentRecord(overrides: Record<string, unknown> = {}) {
	return {
		id: "adj-1",
		vehicle_id: "vehicle-1",
		organization_id: "org-1",
		type: "warehouse_exchange",
		note: null,
		created_by_id: "dispatcher-1",
		created_by_tech_id: null,
		created_at: new Date(),
		lines: [],
		created_by: { id: "dispatcher-1", name: "Alice" },
		created_by_tech: null,
		...overrides,
	};
}

function makeSdb(stockItems: unknown[] = [], flagRows: unknown[] = []) {
	const tx = {
		vehicle_stock_item: {
			findMany: vi.fn().mockResolvedValue(stockItems),
			upsert: vi.fn().mockResolvedValue({
				id: "new-stock-1",
				vehicle_id: "vehicle-1",
				inventory_item_id: "inv-2",
				qty_on_hand: 0,
			}),
		},
		inventory_item: {
			findFirst: vi.fn().mockResolvedValue({ id: "inv-2" }),
			findMany: vi.fn().mockResolvedValue(flagRows),
			create: vi.fn().mockResolvedValue({ id: "prov-1" }),
		},
		stock_batch: {
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockResolvedValue({ id: "batch-1", code: "LOT-XXXX" }),
		},
		vehicle_stock_adjustment: {
			create: vi.fn().mockResolvedValue(makeAdjustmentRecord()),
			findUniqueOrThrow: vi.fn().mockResolvedValue(makeAdjustmentRecord()),
		},
	};
	const sdb = {
		vehicle: { findFirst: vi.fn().mockResolvedValue({ id: "vehicle-1" }) },
		$transaction: vi.fn().mockImplementation(
			async (fn: (tx: typeof tx) => unknown) => fn(tx),
		),
		_tx: tx,
	};
	mockGetScopedDb.mockReturnValue(sdb as unknown as ReturnType<typeof getScopedDb>);
	return sdb;
}

function movementsFromLastCall() {
	const call = mockRecordMovements.mock.calls.at(-1);
	return call ? call[3] : undefined;
}

const CONTEXT = { dispatcherId: "dispatcher-1" };
const STOCK_ITEM_UUID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TARGET_VEHICLE_UUID = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const NEW_INVENTORY_UUID = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const STOCK_ITEM = {
	id: STOCK_ITEM_UUID,
	vehicle_id: "vehicle-1",
	inventory_item_id: "inv-1",
	qty_on_hand: 5,
};

describe("adjustStock", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordMovements.mockResolvedValue({ lowStockItemIds: [] });
	});

	it("returns error when vehicle not found", async () => {
		const sdb = makeSdb();
		sdb.vehicle.findFirst.mockResolvedValue(null);
		const result = await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] }, "org-1", CONTEXT);
		expect(result.err).toBe("Vehicle not found");
	});

	it("returns error when actor context missing", async () => {
		makeSdb();
		const result = await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] }, "org-1", {});
		expect(result.err).toBe("Actor context required");
	});

	it("accepts a technician actor and stamps created_by_tech_id", async () => {
		const sdb = makeSdb([STOCK_ITEM]);
		const result = await adjustStock("vehicle-1", { type: "audit", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 3 }] }, "org-1", { techId: "tech-1" });
		expect(result.err).toBeUndefined();
		const createData = sdb._tx.vehicle_stock_adjustment.create.mock.calls[0][0].data;
		expect(createData.created_by_id).toBeNull();
		expect(createData.created_by_tech_id).toBe("tech-1");

		const actor = mockRecordMovements.mock.calls[0][2];
		expect(actor).toEqual({ actor_type: "technician", actor_id: "tech-1" });
	});

	it("returns validation error for invalid type", async () => {
		makeSdb();
		const result = await adjustStock("vehicle-1", { type: "invalid", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] }, "org-1", CONTEXT);
		expect(result.err).toMatch(/Validation failed/);
	});

	// inventory_item.quantity is numeric(10,2) like every other qty column, so a
	// fractional warehouse exchange is a storable movement; the old whole-number
	// gate dated from when the warehouse column was Int. The ledger's real bound
	// (2 decimal places) still applies.
	it("allows fractional qty_after on warehouse_exchange (warehouse qty is numeric(10,2))", async () => {
		makeSdb([STOCK_ITEM]);
		const result = await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2.5 }] }, "org-1", CONTEXT);
		expect(result.err).toBeUndefined();
	});

	it("rejects a qty_after with more than 2 decimal places with a clear validation error", async () => {
		makeSdb([STOCK_ITEM]);
		const result = await adjustStock("vehicle-1", { type: "audit", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2.555 }] }, "org-1", CONTEXT);
		expect(result.err).toMatch(/Validation failed/);
		expect(result.err).toMatch(/decimal places/);
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("allows fractional qty_after on non-warehouse types", async () => {
		makeSdb([STOCK_ITEM]);
		const result = await adjustStock("vehicle-1", { type: "audit", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2.5 }] }, "org-1", CONTEXT);
		expect(result.err).toBeUndefined();
	});

	it("returns error when stock item not found on vehicle", async () => {
		makeSdb([]); // empty — no stock items found
		const result = await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] }, "org-1", CONTEXT);
		expect(result.err).toMatch(/not found/);
	});

	it("warehouse_exchange loading: warehouse→vehicle restock movement", async () => {
		// qty_on_hand=5, qty_after=10 → delta=+5
		makeSdb([STOCK_ITEM]);
		const result = await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] }, "org-1", CONTEXT);
		expect(result.err).toBeUndefined();
		expect(result.adjustment).toBeDefined();
		expect(movementsFromLastCall()).toEqual([
			{
				inventory_item_id: "inv-1",
				qty: 5,
				from_location_type: "warehouse",
				from_vehicle_id: undefined,
				to_location_type: "vehicle",
				to_vehicle_id: "vehicle-1",
				reason: "restock",
				adjustment_id: "adj-1",
			},
		]);
	});

	it("warehouse_exchange returning: vehicle→warehouse return movement", async () => {
		// qty_on_hand=5, qty_after=2 → delta=-3
		makeSdb([STOCK_ITEM]);
		await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2 }] }, "org-1", CONTEXT);
		expect(movementsFromLastCall()).toEqual([
			{
				inventory_item_id: "inv-1",
				qty: 3,
				from_location_type: "vehicle",
				from_vehicle_id: "vehicle-1",
				to_location_type: "warehouse",
				to_vehicle_id: undefined,
				reason: "return_to_warehouse",
				adjustment_id: "adj-1",
			},
		]);
	});

	it("surfaces insufficient warehouse stock with availability", async () => {
		makeSdb([STOCK_ITEM]);
		mockRecordMovements.mockRejectedValue(new InsufficientStockError({ "inv-1": 2 }));
		const result = await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] }, "org-1", CONTEXT);
		expect(result.err).toBe("insufficient_warehouse_stock");
		expect(result.available).toEqual({ "inv-1": 2 });
	});

	it("field_loss: vehicle→adjustment loss movement, no warehouse", async () => {
		makeSdb([STOCK_ITEM]);
		await adjustStock("vehicle-1", { type: "field_loss", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2 }] }, "org-1", CONTEXT);
		expect(movementsFromLastCall()).toEqual([
			{
				inventory_item_id: "inv-1",
				qty: 3,
				from_location_type: "vehicle",
				from_vehicle_id: "vehicle-1",
				to_location_type: "adjustment",
				to_vehicle_id: undefined,
				reason: "loss",
				adjustment_id: "adj-1",
			},
		]);
	});

	it("audit: adjustment↔vehicle audit_correction movements", async () => {
		makeSdb([STOCK_ITEM]);
		await adjustStock("vehicle-1", { type: "audit", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 8 }] }, "org-1", CONTEXT);
		expect(movementsFromLastCall()).toEqual([
			{
				inventory_item_id: "inv-1",
				qty: 3,
				from_location_type: "adjustment",
				from_vehicle_id: undefined,
				to_location_type: "vehicle",
				to_vehicle_id: "vehicle-1",
				reason: "audit_correction",
				adjustment_id: "adj-1",
			},
		]);
	});

	it("transfer without target: vehicle↔adjustment transfer movement", async () => {
		makeSdb([STOCK_ITEM]);
		await adjustStock("vehicle-1", { type: "transfer", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 8 }] }, "org-1", CONTEXT);
		expect(movementsFromLastCall()).toEqual([
			{
				inventory_item_id: "inv-1",
				qty: 3,
				from_location_type: "adjustment",
				from_vehicle_id: undefined,
				to_location_type: "vehicle",
				to_vehicle_id: "vehicle-1",
				reason: "transfer",
				adjustment_id: "adj-1",
			},
		]);
	});

	it("transfer with target: vehicle→vehicle movement (transfer in)", async () => {
		const sdb = makeSdb([STOCK_ITEM]);
		sdb.vehicle.findFirst
			.mockResolvedValueOnce({ id: "vehicle-1" })           // this vehicle
			.mockResolvedValueOnce({ id: TARGET_VEHICLE_UUID }); // target vehicle
		// qty_after=8 → delta=+3 → stock came FROM target INTO this vehicle
		await adjustStock("vehicle-1", { type: "transfer", target_vehicle_id: TARGET_VEHICLE_UUID, lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 8 }] }, "org-1", CONTEXT);
		expect(movementsFromLastCall()).toEqual([
			{
				inventory_item_id: "inv-1",
				qty: 3,
				from_location_type: "vehicle",
				from_vehicle_id: TARGET_VEHICLE_UUID,
				to_location_type: "vehicle",
				to_vehicle_id: "vehicle-1",
				reason: "transfer",
				adjustment_id: "adj-1",
			},
		]);
	});

	it("rejects target_vehicle_id on non-transfer types", async () => {
		makeSdb([STOCK_ITEM]);
		const result = await adjustStock("vehicle-1", { type: "audit", target_vehicle_id: TARGET_VEHICLE_UUID, lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 8 }] }, "org-1", CONTEXT);
		expect(result.err).toBe("target_vehicle_id is only valid for transfer adjustments");
	});

	it("rejects transfer targeting the same vehicle", async () => {
		makeSdb([STOCK_ITEM]);
		const result = await adjustStock(TARGET_VEHICLE_UUID, { type: "transfer", target_vehicle_id: TARGET_VEHICLE_UUID, lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 8 }] }, "org-1", CONTEXT);
		expect(result.err).toBe("Transfer target must be a different vehicle");
	});

	it("records qty_before, qty_after, inventory_impact on each line", async () => {
		// qty_on_hand=5, qty_after=10, warehouse_exchange loading → delta=5, inventory_impact=-5
		const sdb = makeSdb([STOCK_ITEM]);
		await adjustStock("vehicle-1", { type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] }, "org-1", CONTEXT);
		const createData = sdb._tx.vehicle_stock_adjustment.create.mock.calls[0][0].data;
		expect(createData.lines.create[0]).toMatchObject({ stock_item_id: STOCK_ITEM_UUID, qty_before: 5, qty_after: 10, inventory_impact: -5 });
	});

	it("emits no movements when delta is 0 (audit with no change)", async () => {
		makeSdb([{ ...STOCK_ITEM, qty_on_hand: 5 }]);
		await adjustStock("vehicle-1", { type: "audit", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 5 }] }, "org-1", CONTEXT);
		expect(movementsFromLastCall()).toEqual([]);
	});

	// Buying externally is a field purchase now: a grant, a limit, a receipt and
	// a review. Refused here so the wizard cannot be used to go around them.
	it("refuses supplier_purchase, which is no longer an adjustment", async () => {
		makeSdb([]);
		const result = await adjustStock(
			"vehicle-1",
			{ type: "supplier_purchase", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 1 }] },
			"org-1",
			{ techId: "tech-1" },
		);
		expect(result.err).toMatch(/Validation failed/);
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("multi-line: creates adjustment record with two lines + two movements", async () => {
		const UUID_2 = "bbbbbbbb-bbbb-4bbb-aaaa-bbbbbbbbbbbb";
		const ITEM_2 = { id: UUID_2, vehicle_id: "vehicle-1", inventory_item_id: "inv-2", qty_on_hand: 3 };
		const sdb = makeSdb([STOCK_ITEM, ITEM_2]);
		await adjustStock("vehicle-1", {
			type: "warehouse_exchange",
			lines: [
				{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 },
				{ stock_item_id: UUID_2, qty_after: 7 },
			],
		}, "org-1", CONTEXT);
		const createData = sdb._tx.vehicle_stock_adjustment.create.mock.calls[0][0].data;
		expect(createData.lines.create).toHaveLength(2);
		expect(createData.lines.create[0]).toMatchObject({ qty_before: 5, qty_after: 10, inventory_impact: -5 });
		expect(createData.lines.create[1]).toMatchObject({ qty_before: 3, qty_after: 7, inventory_impact: -4 });
		expect(movementsFromLastCall()).toHaveLength(2);
	});

	it("add-from-warehouse: upserts a stock item then moves warehouse → vehicle", async () => {
		const sdb = makeSdb([]); // no existing stock items on the vehicle
		const result = await adjustStock(
			"vehicle-1",
			{ type: "warehouse_exchange", lines: [{ inventory_item_id: NEW_INVENTORY_UUID, qty_after: 3 }] },
			"org-1",
			CONTEXT,
		);
		expect(result.err).toBeUndefined();
		expect(sdb._tx.vehicle_stock_item.upsert).toHaveBeenCalled();
		const movements = movementsFromLastCall();
		expect(movements).toEqual([
			expect.objectContaining({
				qty: 3, from_location_type: "warehouse", to_location_type: "vehicle",
				to_vehicle_id: "vehicle-1", reason: "restock",
			}),
		]);
	});

	it("rejects add-from-warehouse for a provisional or missing catalog item", async () => {
		const sdb = makeSdb([]);
		sdb._tx.inventory_item.findFirst = vi.fn().mockResolvedValue(null);
		const result = await adjustStock(
			"vehicle-1",
			{ type: "warehouse_exchange", lines: [{ inventory_item_id: NEW_INVENTORY_UUID, qty_after: 3 }] },
			"org-1",
			CONTEXT,
		);
		expect(result.err).toMatch(/not found/i);
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("rejects inventory_item_id lines for non-warehouse_exchange types", async () => {
		makeSdb([]);
		const result = await adjustStock(
			"vehicle-1",
			{ type: "audit", lines: [{ inventory_item_id: NEW_INVENTORY_UUID, qty_after: 3 }] },
			"org-1",
			CONTEXT,
		);
		expect(result.err).toMatch(/Validation failed/);
	});

	// ---------------------------------------------------------------------------
	// Serial / batch tracking wiring (B-T3)
	// ---------------------------------------------------------------------------
	describe("serial/batch tracking", () => {
		it("field_loss with serial_unit_ids builds a loss movement carrying serial.unit_ids", async () => {
			makeSdb([STOCK_ITEM], [{ id: "inv-1", is_serialized: true, is_batch_tracked: false }]);
			const suIds = [
				"11111111-1111-4111-8111-111111111111",
				"22222222-2222-4222-8222-222222222222",
				"33333333-3333-4333-8333-333333333333",
			];
			// qty_on_hand=5, qty_after=2 → delta=-3, expects exactly 3 unit ids
			const result = await adjustStock(
				"vehicle-1",
				{ type: "field_loss", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2, serial_unit_ids: suIds }] },
				"org-1",
				CONTEXT,
			);

			expect(result.err).toBeUndefined();
			expect(movementsFromLastCall()).toEqual([
				expect.objectContaining({
					qty: 3,
					from_location_type: "vehicle",
					to_location_type: "adjustment",
					reason: "loss",
					serial: { unit_ids: suIds },
				}),
			]);
		});

		it("transfer with serial_unit_ids moves the right units between vehicles", async () => {
			const sdb = makeSdb([STOCK_ITEM], [{ id: "inv-1", is_serialized: true, is_batch_tracked: false }]);
			sdb.vehicle.findFirst
				.mockResolvedValueOnce({ id: "vehicle-1" })
				.mockResolvedValueOnce({ id: TARGET_VEHICLE_UUID });
			const suIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
			// qty_after=3 → delta=-2 (moving out to target vehicle)
			const result = await adjustStock(
				"vehicle-1",
				{
					type: "transfer",
					target_vehicle_id: TARGET_VEHICLE_UUID,
					lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 3, serial_unit_ids: suIds }],
				},
				"org-1",
				CONTEXT,
			);

			expect(result.err).toBeUndefined();
			expect(movementsFromLastCall()).toEqual([
				expect.objectContaining({
					qty: 2,
					from_location_type: "vehicle",
					from_vehicle_id: "vehicle-1",
					to_location_type: "vehicle",
					to_vehicle_id: TARGET_VEHICLE_UUID,
					reason: "transfer",
					serial: { unit_ids: suIds },
				}),
			]);
		});

		it("rejects a serialized line with no serial_unit_ids", async () => {
			makeSdb([STOCK_ITEM], [{ id: "inv-1", is_serialized: true, is_batch_tracked: false }]);
			const result = await adjustStock(
				"vehicle-1",
				{ type: "field_loss", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2 }] },
				"org-1",
				CONTEXT,
			);
			expect(result.err).toMatch(/serial_unit_ids/);
			expect(mockRecordMovements).not.toHaveBeenCalled();
		});

		it("rejects a serialized line when serial_unit_ids count mismatches abs(delta)", async () => {
			makeSdb([STOCK_ITEM], [{ id: "inv-1", is_serialized: true, is_batch_tracked: false }]);
			const result = await adjustStock(
				"vehicle-1",
				{
					type: "field_loss",
					lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2, serial_unit_ids: ["11111111-1111-4111-8111-111111111111"] }],
				},
				"org-1",
				CONTEXT,
			);
			expect(result.err).toMatch(/serial_unit_ids/);
			expect(mockRecordMovements).not.toHaveBeenCalled();
		});

		it("batch-tracked line with no batch_picks omits batch_allocations (FIFO auto-allocates)", async () => {
			makeSdb([STOCK_ITEM], [{ id: "inv-1", is_serialized: false, is_batch_tracked: true }]);
			const result = await adjustStock(
				"vehicle-1",
				{ type: "field_loss", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2 }] },
				"org-1",
				CONTEXT,
			);
			expect(result.err).toBeUndefined();
			const movement = movementsFromLastCall()![0] as Record<string, unknown>;
			expect(movement.batch_allocations).toBeUndefined();
		});

		it("batch-tracked line with explicit batch_picks passes them through as batch_allocations", async () => {
			makeSdb([STOCK_ITEM], [{ id: "inv-1", is_serialized: false, is_batch_tracked: true }]);
			const batchId = "44444444-4444-4444-8444-444444444444";
			const result = await adjustStock(
				"vehicle-1",
				{
					type: "field_loss",
					lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 2, batch_picks: [{ batch_id: batchId, qty: 3 }] }],
				},
				"org-1",
				CONTEXT,
			);
			expect(result.err).toBeUndefined();
			expect(movementsFromLastCall()).toEqual([
				expect.objectContaining({ qty: 3, batch_allocations: [{ batch_id: batchId, qty: 3 }] }),
			]);
		});

		it("non-tracked lines are unaffected — no serial/batch keys attached (regression)", async () => {
			makeSdb([STOCK_ITEM], []); // no flag rows → defaults to non-tracked
			await adjustStock(
				"vehicle-1",
				{ type: "warehouse_exchange", lines: [{ stock_item_id: STOCK_ITEM_UUID, qty_after: 10 }] },
				"org-1",
				CONTEXT,
			);
			const movement = movementsFromLastCall()![0] as Record<string, unknown>;
			expect(movement.serial).toBeUndefined();
			expect(movement.batch_allocations).toBeUndefined();
		});
	});
});
