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
		recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [], gapItemIds: [], movementIds: [] }),
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

import { updatePartsUsedQty } from "../vehiclesController.js";
import { getScopedDb, type UserContext } from "../../lib/context.js";
import { recordMovements } from "../../services/stockMovements.js";
import { logActivity } from "../../services/logger.js";

const mockGetScopedDb = vi.mocked(getScopedDb);
const mockRecordMovements = vi.mocked(recordMovements);
const mockLogActivity = vi.mocked(logActivity);

// ── UUIDs ─────────────────────────────────────────────────────────────────────

const VISIT_ID = "bbbbbbbb-bbbb-4bbb-abbb-bbbbbbbbbbbb";
const INV_ITEM_ID = "cccccccc-cccc-4ccc-accc-cccccccccccc";
const TECH_ID = "dddddddd-dddd-4ddd-addd-dddddddddddd";
const VEHICLE_ID = "eeeeeeee-eeee-4eee-aeee-eeeeeeeeeeee";
const LINE_ITEM_ID = "ffffffff-ffff-4fff-afff-ffffffffffff";
const BATCH_ID = "11111111-1111-4111-8111-111111111111";
const SERIAL_UUID_1 = "22222222-2222-4222-8222-222222222222";
const SERIAL_UUID_2 = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "org-1";
const MOVEMENT_ID_1 = "55555555-5555-4555-8555-555555555555";
const MOVEMENT_ID_2 = "66666666-6666-4666-8666-666666666666";
const DISPATCHER_ID = "77777777-7777-4777-8777-777777777777";
const OTHER_TECH_ID = "88888888-8888-4888-8888-888888888888";

const TECH_CTX: UserContext = { techId: TECH_ID };
const DISPATCHER_CTX: UserContext = { dispatcherId: DISPATCHER_ID };

// ── Factory helpers ───────────────────────────────────────────────────────────

function makeLineItem(overrides: Record<string, unknown> = {}) {
	return {
		id: LINE_ITEM_ID,
		visit_id: VISIT_ID,
		name: "Widget",
		quantity: 3,
		unit_price: 10,
		total: 30,
		source: "field_addition",
		item_type: "material",
		sort_order: 0,
		inventory_item_id: INV_ITEM_ID,
		fulfillment_status: "used",
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

function makeVisit(overrides: Record<string, unknown> = {}) {
	return {
		id: VISIT_ID,
		status: "InProgress",
		_count: { invoice_visits: 0 },
		visit_techs: [{ tech_id: TECH_ID }],
		...overrides,
	};
}

/**
 * Build a scoped-db mock whose $transaction executes the callback inline.
 *
 * The visit is resolved via the scoped client BEFORE the transaction (tenancy
 * gate); the line item is read INSIDE the transaction after a FOR UPDATE lock,
 * so it lives on `tx`, not on `sdb`.
 */
function makeSdb(opts: {
	visit?: unknown;
	lineItem?: unknown;
	originVehicleId?: string | null;
	serialRows?: { id: string }[];
	movementRows?: unknown[];
	technician?: unknown;
} = {}) {
	const lineItem = "lineItem" in opts ? opts.lineItem : makeLineItem();
	const visit = "visit" in opts ? opts.visit : makeVisit();
	const tx = {
		$queryRaw: vi.fn().mockResolvedValue([]),
		job_visit_line_item: {
			findFirst: vi.fn().mockResolvedValue(lineItem),
			update: vi.fn().mockResolvedValue(makeLineItem()),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		serial_unit: {
			findMany: vi.fn().mockResolvedValue(opts.serialRows ?? []),
		},
		stock_movement: {
			findFirst: vi.fn().mockResolvedValue(
				opts.originVehicleId === undefined
					? { from_vehicle_id: VEHICLE_ID }
					: opts.originVehicleId === null
						? null
						: { from_vehicle_id: opts.originVehicleId },
			),
			findMany: vi.fn().mockResolvedValue(opts.movementRows ?? []),
		},
	};

	const sdb = {
		job_visit: { findFirst: vi.fn().mockResolvedValue(visit) },
		technician: {
			findFirst: vi.fn().mockResolvedValue("technician" in opts ? opts.technician : { id: TECH_ID }),
		},
		$transaction: vi.fn().mockImplementation(async (fn: (tx: typeof tx) => unknown) => fn(tx)),
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

describe("updatePartsUsedQty", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordMovements.mockResolvedValue({ lowStockItemIds: [], gapItemIds: [], movementIds: [] });
	});

	// ── Untracked items ────────────────────────────────────────────────────────

	it("increases an untracked line by deducting the delta from the same vehicle", async () => {
		makeSdb();

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 5 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					qty: 2,
					from_location_type: "vehicle",
					from_vehicle_id: VEHICLE_ID,
					to_location_type: "consumed",
					reason: "parts_used",
				}),
			]),
		);
	});

	it("decreases an untracked line by writing a reversal movement back to the vehicle", async () => {
		const sdb = makeSdb();

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					qty: 2,
					from_location_type: "consumed",
					to_location_type: "vehicle",
					to_vehicle_id: VEHICLE_ID,
					reason: "reversal",
				}),
			]),
		);
		expect(sdb._tx.job_visit_line_item.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ quantity: 1, total: 10 }) }),
		);
	});

	it("deletes the line item when quantity drops to zero", async () => {
		const sdb = makeSdb();

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 0 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		expect(sdb._tx.job_visit_line_item.delete).toHaveBeenCalledWith({ where: { id: LINE_ITEM_ID } });
		expect(sdb._tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("is a no-op when quantity is unchanged", async () => {
		makeSdb();

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 3 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	// ── Serialized items ───────────────────────────────────────────────────────

	it("rejects increasing a serialized line with no ledger or line writes", async () => {
		const sdb = makeSdb({
			lineItem: makeLineItem({
				inventory_item: { ...makeLineItem().inventory_item, is_serialized: true },
			}),
		});

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 5 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/can't be increased/);
		// The line is read under lock inside the transaction, so the transaction
		// opens — but it aborts (throws) before any write.
		expect(mockRecordMovements).not.toHaveBeenCalled();
		expect(sdb._tx.job_visit_line_item.update).not.toHaveBeenCalled();
		expect(sdb._tx.job_visit_line_item.delete).not.toHaveBeenCalled();
	});

	it("releases the exact consumed serials when decreasing a serialized line", async () => {
		const sdb = makeSdb({
			lineItem: makeLineItem({
				inventory_item: { ...makeLineItem().inventory_item, is_serialized: true },
			}),
			serialRows: [{ id: SERIAL_UUID_1 }, { id: SERIAL_UUID_2 }],
		});

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		expect(sdb._tx.serial_unit.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { consumed_line_item_id: LINE_ITEM_ID },
				take: 2,
			}),
		);
		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "reversal",
					serial: { unit_ids: [SERIAL_UUID_1, SERIAL_UUID_2] },
				}),
			]),
		);
	});

	it("errors instead of silently under-releasing when fewer consumed serials exist than the requested decrease", async () => {
		makeSdb({
			lineItem: makeLineItem({
				inventory_item: { ...makeLineItem().inventory_item, is_serialized: true },
			}),
			serialRows: [{ id: SERIAL_UUID_1 }],
		});

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/Only 1 consumed unit/);
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	// ── Batch-tracked items ────────────────────────────────────────────────────

	it("nets prior movements to compute the batch allocation released on decrease", async () => {
		makeSdb({
			lineItem: makeLineItem({
				inventory_item: { ...makeLineItem().inventory_item, is_batch_tracked: true },
			}),
			movementRows: [
				{
					id: MOVEMENT_ID_1,
					reason: "parts_used",
					movement_batches: [{ batch_id: BATCH_ID, qty: 3 }],
				},
			],
		});

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "reversal",
					batch_allocations: [{ batch_id: BATCH_ID, qty: 2 }],
				}),
			]),
		);
	});

	it("nets out a previously applied reversal before computing what remains to release", async () => {
		makeSdb({
			lineItem: makeLineItem({
				inventory_item: { ...makeLineItem().inventory_item, is_batch_tracked: true },
				quantity: 2,
			}),
			movementRows: [
				{ id: MOVEMENT_ID_1, reason: "parts_used", movement_batches: [{ batch_id: BATCH_ID, qty: 3 }] },
				{ id: MOVEMENT_ID_2, reason: "reversal", movement_batches: [{ batch_id: BATCH_ID, qty: 1 }] },
			],
		});

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ batch_allocations: [{ batch_id: BATCH_ID, qty: 1 }] }),
			]),
		);
	});

	it("allows increasing a batch-tracked line (FIFO auto-allocates, no picker needed)", async () => {
		makeSdb({
			lineItem: makeLineItem({
				inventory_item: { ...makeLineItem().inventory_item, is_batch_tracked: true },
			}),
		});

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 5 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("");
		const movements = movementsFromLastCall();
		expect(movements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "parts_used", batch_allocations: undefined }),
			]),
		);
	});

	// ── Guardrails ─────────────────────────────────────────────────────────────

	it("errors when the originating vehicle can't be determined", async () => {
		makeSdb({ originVehicleId: null });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/originating vehicle/);
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("rejects a line item that was never linked to vehicle stock", async () => {
		makeSdb({ lineItem: makeLineItem({ inventory_item_id: null, inventory_item: null, fulfillment_status: null }) });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/regular line item/);
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("returns not found for a missing line item", async () => {
		makeSdb({ lineItem: null });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("Line item not found");
	});

	// The commit's named case: a stock-linked line that is still planned (not
	// "used") has no vehicle ledger behind it, so there is nothing to reverse.
	it("rejects a line with inventory_item_id set whose fulfillment_status is not 'used'", async () => {
		const sdb = makeSdb({ lineItem: makeLineItem({ fulfillment_status: "planned" }) });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/regular line item/);
		expect(mockRecordMovements).not.toHaveBeenCalled();
		expect(sdb._tx.job_visit_line_item.update).not.toHaveBeenCalled();
	});

	it("rejects a fractional decrease on a serialized line before any serial lookup", async () => {
		const sdb = makeSdb({
			lineItem: makeLineItem({
				inventory_item: { ...makeLineItem().inventory_item, is_serialized: true },
			}),
			serialRows: [{ id: SERIAL_UUID_1 }, { id: SERIAL_UUID_2 }],
		});

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1.5 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/whole units/);
		expect(sdb._tx.serial_unit.findMany).not.toHaveBeenCalled();
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("rejects a quantity the numeric(10,2) ledger cannot store", async () => {
		const sdb = makeSdb();

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1.234 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/Validation failed/);
		expect(result.err).toMatch(/decimal places/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("passes allowNegative on the increase path, matching addPartsUsed", async () => {
		makeSdb();

		await updatePartsUsedQty(VISIT_ID, LINE_ITEM_ID, { technician_id: TECH_ID, quantity: 5 }, ORG_ID, TECH_CTX);

		const call = mockRecordMovements.mock.calls.at(-1)!;
		expect(call[3][0]).toEqual(expect.objectContaining({ reason: "parts_used", qty: 2 }));
		expect(call[4]).toEqual({ allowNegative: true });
	});

	// ── Tenancy + visit gate ───────────────────────────────────────────────────

	it("returns 'Visit not found' for a foreign/missing visit before ever reading the line item", async () => {
		const sdb = makeSdb({ visit: null });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 3 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe("Visit not found");
		expect(sdb.job_visit.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: VISIT_ID } }),
		);
		// No transaction, no line read — a foreign line item (org-2's data) can
		// never be returned, not even on the delta === 0 no-op path.
		expect(sdb.$transaction).not.toHaveBeenCalled();
		expect(sdb._tx.job_visit_line_item.findFirst).not.toHaveBeenCalled();
		expect(result).not.toHaveProperty("item");
	});

	it.each(["Completed", "Cancelled"])("rejects edits on a %s visit", async (status) => {
		const sdb = makeSdb({ visit: makeVisit({ status }) });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toBe(`Parts can't be changed on a ${status} visit`);
		expect(sdb.$transaction).not.toHaveBeenCalled();
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("rejects edits on an invoiced visit", async () => {
		const sdb = makeSdb({ visit: makeVisit({ _count: { invoice_visits: 1 } }) });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result.err).toMatch(/invoiced/);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("locks the line item (SELECT … FOR UPDATE) inside the transaction before reading it", async () => {
		const sdb = makeSdb();
		const order: string[] = [];
		sdb._tx.$queryRaw.mockImplementation(async () => {
			order.push("lock");
			return [];
		});
		sdb._tx.job_visit_line_item.findFirst.mockImplementation(async () => {
			order.push("read");
			return makeLineItem();
		});

		await updatePartsUsedQty(VISIT_ID, LINE_ITEM_ID, { technician_id: TECH_ID, quantity: 1 }, ORG_ID, TECH_CTX);

		expect(order).toEqual(["lock", "read"]);
		const [strings, ...values] = sdb._tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
		expect(strings.join("?")).toMatch(/SELECT id FROM job_visit_line_item WHERE id = \? FOR UPDATE/);
		expect(values).toEqual([LINE_ITEM_ID]);
		expect(sdb._tx.job_visit_line_item.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: LINE_ITEM_ID, visit_id: VISIT_ID } }),
		);
	});

	// ── Actor identity ─────────────────────────────────────────────────────────

	it("records the authenticated technician as the ledger + log actor and the credited tech", async () => {
		makeSdb();

		const result = await updatePartsUsedQty(VISIT_ID, LINE_ITEM_ID, { quantity: 1 }, ORG_ID, TECH_CTX);

		expect(result.err).toBe("");
		const [, , actor] = mockRecordMovements.mock.calls.at(-1)!;
		expect(actor).toEqual({ actor_type: "technician", actor_id: TECH_ID });
		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				actor_type: "technician",
				actor_id: TECH_ID,
				changes: expect.objectContaining({
					technician_id: { old: null, new: TECH_ID },
				}),
			}),
		);
	});

	it("a technician naming another technician is FORBIDDEN, before any write", async () => {
		const sdb = makeSdb({ technician: { id: OTHER_TECH_ID } });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: OTHER_TECH_ID, quantity: 1 },
			ORG_ID,
			TECH_CTX,
		);

		expect(result).toMatchObject({ code: "FORBIDDEN" });
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("a technician not assigned to the visit is FORBIDDEN, before any write", async () => {
		const sdb = makeSdb({ visit: makeVisit({ visit_techs: [{ tech_id: OTHER_TECH_ID }] }) });

		const result = await updatePartsUsedQty(VISIT_ID, LINE_ITEM_ID, { quantity: 1 }, ORG_ID, TECH_CTX);

		expect(result).toMatchObject({ code: "FORBIDDEN", err: "You are not assigned to this visit" });
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("records a dispatcher caller as a dispatcher actor", async () => {
		makeSdb();

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: TECH_ID, quantity: 1 },
			ORG_ID,
			DISPATCHER_CTX,
		);

		expect(result.err).toBe("");
		const [, , actor] = mockRecordMovements.mock.calls.at(-1)!;
		expect(actor).toEqual({ actor_type: "dispatcher", actor_id: DISPATCHER_ID });
		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({ actor_type: "dispatcher", actor_id: DISPATCHER_ID }),
		);
	});

	it("accepts a body with no technician_id (attribution is optional)", async () => {
		const sdb = makeSdb();

		const result = await updatePartsUsedQty(VISIT_ID, LINE_ITEM_ID, { quantity: 1 }, ORG_ID, DISPATCHER_CTX);

		expect(result.err).toBe("");
		expect(sdb.technician.findFirst).not.toHaveBeenCalled();
		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({ changes: { quantity: { old: 3, new: 1 } } }),
		);
	});

	it("rejects a body technician_id that does not belong to the org", async () => {
		const sdb = makeSdb({ technician: null });

		const result = await updatePartsUsedQty(
			VISIT_ID,
			LINE_ITEM_ID,
			{ technician_id: OTHER_TECH_ID, quantity: 1 },
			ORG_ID,
			DISPATCHER_CTX,
		);

		expect(result.err).toBe("Technician not found");
		expect(sdb.technician.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: OTHER_TECH_ID } }),
		);
		expect(sdb.$transaction).not.toHaveBeenCalled();
	});

	it("does not write an audit entry for a no-op edit", async () => {
		makeSdb();

		await updatePartsUsedQty(VISIT_ID, LINE_ITEM_ID, { technician_id: TECH_ID, quantity: 3 }, ORG_ID, TECH_CTX);

		expect(mockLogActivity).not.toHaveBeenCalled();
	});
});
