import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be before any import that resolves to them) ───────────────────

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

vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeVisitTotals: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { addPartsUsed } from "../vehiclesController.js";
import { getScopedDb } from "../../lib/context.js";
import { recordMovements } from "../../services/stockMovements.js";

const mockGetScopedDb = vi.mocked(getScopedDb);
const mockRecordMovements = vi.mocked(recordMovements);

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const VISIT_ID = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
const STOCK_ITEM_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const INV_ITEM_ID = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const TECH_ID = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const VEHICLE_ID = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const LINE_ITEM_ID = "ffffffff-ffff-4fff-afff-ffffffffffff";
const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const SERIAL_UUID_1 = "22222222-2222-4222-8222-222222222222";
const SERIAL_UUID_2 = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "org-1";

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeStockItem(overrides: Record<string, unknown> = {}) {
	return {
		id: STOCK_ITEM_ID,
		vehicle_id: VEHICLE_ID,
		inventory_item_id: INV_ITEM_ID,
		inventory_item: {
			id: INV_ITEM_ID,
			name: "Widget",
			unit_price: 10,
			is_serialized: false,
			is_batch_tracked: false,
		},
		...overrides,
	};
}

function makeLineItem(overrides: Record<string, unknown> = {}) {
	return {
		id: LINE_ITEM_ID,
		visit_id: VISIT_ID,
		name: "Widget",
		quantity: 1,
		unit_price: 10,
		total: 10,
		source: "field_addition",
		item_type: "material",
		sort_order: 0,
		inventory_item_id: INV_ITEM_ID,
		fulfillment_status: "used",
		...overrides,
	};
}

/**
 * Build a scoped-db mock whose $transaction executes the callback inline.
 * All inner tx methods are vi.fn() stubs that can be asserted on.
 */
function makeSdb(stockItem: unknown = makeStockItem()) {
	const tx = {
		job_visit_line_item: {
			create: vi.fn().mockResolvedValue(makeLineItem()),
		},
		vehicle_stock_usage: {
			create: vi.fn().mockResolvedValue({ id: "usage-1" }),
		},
	};

	const sdb = {
		vehicle_stock_item: { findFirst: vi.fn().mockResolvedValue(stockItem) },
		job_visit: { findFirst: vi.fn().mockResolvedValue({ id: VISIT_ID }) },
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("addPartsUsed", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordMovements.mockResolvedValue({ lowStockItemIds: [] });
	});

	// ── Plain (untracked) item — no regression ───────────────────────────────

	it("consumes a plain untracked item without requiring serial/batch fields", async () => {
		makeSdb();

		const result = await addPartsUsed(
			VISIT_ID,
			{ stock_item_id: STOCK_ITEM_ID, qty_used: 1, technician_id: TECH_ID },
			ORG_ID,
		);

		expect(result.err).toBe("");
		expect(mockRecordMovements).toHaveBeenCalledTimes(1);

		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					from_location_type: "vehicle",
					to_location_type: "consumed",
					reason: "parts_used",
					serial: undefined,
					batch_allocations: undefined,
				}),
			]),
		);
	});

	it("stamps the line with the item's taxable flag", async () => {
		const sdb = makeSdb(
			makeStockItem({ inventory_item: { ...makeStockItem().inventory_item, taxable: false } }),
		);

		await addPartsUsed(
			VISIT_ID,
			{ stock_item_id: STOCK_ITEM_ID, qty_used: 1, technician_id: TECH_ID },
			ORG_ID,
		);

		expect(sdb._tx.job_visit_line_item.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ taxable: false }) }),
		);
	});

	it("accepts a fractional qty_used (12.5 ft) — vehicle stock is numeric(10,2)", async () => {
		makeSdb();

		const result = await addPartsUsed(
			VISIT_ID,
			{ stock_item_id: STOCK_ITEM_ID, qty_used: 12.5, technician_id: TECH_ID },
			ORG_ID,
		);

		expect(result.err).toBe("");
		expect(movementsFromLastCall()).toEqual([expect.objectContaining({ qty: 12.5 })]);
	});

	it("rejects a qty_used the numeric(10,2) ledger cannot store, before opening a transaction", async () => {
		const sdb = makeSdb();

		const result = await addPartsUsed(
			VISIT_ID,
			{ stock_item_id: STOCK_ITEM_ID, qty_used: 1.234, technician_id: TECH_ID },
			ORG_ID,
		);

		expect(result.err).toMatch(/Validation failed/);
		expect(result.err).toMatch(/decimal places/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	// ── Serialized item ────────────────────────────────────────────────────────

	it("passes serial_unit_ids through to the movement for a serialized item", async () => {
		makeSdb(makeStockItem({ inventory_item: { ...makeStockItem().inventory_item, is_serialized: true } }));

		const result = await addPartsUsed(
			VISIT_ID,
			{
				stock_item_id: STOCK_ITEM_ID,
				qty_used: 1,
				technician_id: TECH_ID,
				serial_unit_ids: [SERIAL_UUID_1],
			},
			ORG_ID,
		);

		expect(result.err).toBe("");
		expect(mockRecordMovements).toHaveBeenCalledTimes(1);

		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					serial: { unit_ids: [SERIAL_UUID_1] },
				}),
			]),
		);
	});

	it("rejects a serialized item when serial_unit_ids is missing, without opening a transaction", async () => {
		const sdb = makeSdb(
			makeStockItem({ inventory_item: { ...makeStockItem().inventory_item, is_serialized: true } }),
		);

		const result = await addPartsUsed(
			VISIT_ID,
			{ stock_item_id: STOCK_ITEM_ID, qty_used: 1, technician_id: TECH_ID },
			ORG_ID,
		);

		expect(result.err).toMatch(/serial_unit_ids/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("rejects a serialized item when serial_unit_ids count does not match qty_used", async () => {
		const sdb = makeSdb(
			makeStockItem({ inventory_item: { ...makeStockItem().inventory_item, is_serialized: true } }),
		);

		const result = await addPartsUsed(
			VISIT_ID,
			{
				stock_item_id: STOCK_ITEM_ID,
				qty_used: 1,
				technician_id: TECH_ID,
				serial_unit_ids: [SERIAL_UUID_1, SERIAL_UUID_2],
			},
			ORG_ID,
		);

		expect(result.err).toMatch(/serial_unit_ids must have exactly 1 entries/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	// ── Batch-tracked item ─────────────────────────────────────────────────────

	it("passes an explicit batch_id through as batch_allocations for a batch-tracked item", async () => {
		makeSdb(makeStockItem({ inventory_item: { ...makeStockItem().inventory_item, is_batch_tracked: true } }));

		const result = await addPartsUsed(
			VISIT_ID,
			{
				stock_item_id: STOCK_ITEM_ID,
				qty_used: 2,
				technician_id: TECH_ID,
				batch_id: BATCH_ID,
			},
			ORG_ID,
		);

		expect(result.err).toBe("");
		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					batch_allocations: [{ batch_id: BATCH_ID, qty: 2 }],
				}),
			]),
		);
	});

	it("succeeds for a batch-tracked item when batch_id is omitted (FIFO auto-allocate)", async () => {
		makeSdb(makeStockItem({ inventory_item: { ...makeStockItem().inventory_item, is_batch_tracked: true } }));

		const result = await addPartsUsed(
			VISIT_ID,
			{ stock_item_id: STOCK_ITEM_ID, qty_used: 2, technician_id: TECH_ID },
			ORG_ID,
		);

		expect(result.err).toBe("");
		expect(mockRecordMovements).toHaveBeenCalledTimes(1);
	});
});
