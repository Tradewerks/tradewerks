/**
 * The three completion branches, plus the fact that `disposition` and
 * `fulfillment_status` move independently — two enums on the same row are
 * the obvious candidate for being merged into one overloaded column.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { deductInventoryForVisit } from "../inventoryController.js";
import { plannedLineItemFields, dispositionFields } from "../../lib/inventory.js";

// Module gating is not under test here: every module reads as on.
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		inventory_item: { findFirst: vi.fn(), findMany: vi.fn() },
		$queryRaw: vi.fn(),
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const { db } = require("../../db.js");
		return db;
	}),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

const mockRecordMovements = vi.fn().mockResolvedValue({ lowStockItemIds: [] });
vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: (...args: unknown[]) => mockRecordMovements(...args),
	InsufficientStockError: class extends Error {},
}));

vi.mock("xlsx", () => ({
	default: {},
	read: vi.fn(),
	utils: {
		sheet_to_json: vi.fn(),
		json_to_sheet: vi.fn(),
		book_new: vi.fn(),
		book_append_sheet: vi.fn(),
		aoa_to_sheet: vi.fn(),
	},
	write: vi.fn(),
}));

const ORG = "org-1";
const VISIT = "visit-1";

type Line = {
	id: string;
	inventory_item_id: string;
	quantity: number | Prisma.Decimal;
	disposition?: "consume" | "receive" | "non_stock" | null;
	disposition_location?: "warehouse" | "vehicle" | null;
	disposition_vehicle_id?: string | null;
};

/** Transaction client with only what the completion path touches. */
function makeTx(lines: Line[], catalog: { id: string; cost: number | null }[] = []) {
	return {
		job_visit_line_item: {
			findMany: vi.fn().mockResolvedValue(lines),
			updateMany: vi.fn().mockResolvedValue({ count: lines.length }),
		},
		inventory_item: {
			findMany: vi.fn().mockResolvedValue(catalog),
		},
	};
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (tx: unknown) => deductInventoryForVisit(VISIT, tx as any, ORG);

const movementsFrom = () => mockRecordMovements.mock.calls[0]![3] as Record<string, unknown>[];

describe("deductInventoryForVisit — disposition branches", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordMovements.mockResolvedValue({ lowStockItemIds: [] });
	});

	it("deducts the warehouse for an explicit `consume` line", async () => {
		const tx = makeTx([
			{ id: "li-1", inventory_item_id: "item-1", quantity: 3, disposition: "consume" },
		]);

		await run(tx);

		expect(movementsFrom()).toEqual([
			expect.objectContaining({
				inventory_item_id: "item-1",
				qty: 3,
				from_location_type: "warehouse",
				to_location_type: "consumed",
				reason: "direct_consumption",
				visit_line_item_id: "li-1",
			}),
		]);
	});

	// The migration default and the pre-migration behaviour are the same thing;
	// a NULL row (written by an older deploy) must not change what completion
	// does to stock.
	it("treats a NULL disposition exactly as `consume`", async () => {
		const withNull = makeTx([
			{ id: "li-1", inventory_item_id: "item-1", quantity: 2, disposition: null },
		]);
		await run(withNull);
		const nullMovements = movementsFrom();

		mockRecordMovements.mockClear();
		const explicit = makeTx([
			{ id: "li-1", inventory_item_id: "item-1", quantity: 2, disposition: "consume" },
		]);
		await run(explicit);

		expect(nullMovements).toEqual(movementsFrom());
	});

	it("receives into the warehouse at the catalog cost", async () => {
		const tx = makeTx(
			[
				{
					id: "li-1",
					inventory_item_id: "item-1",
					quantity: 4,
					disposition: "receive",
					disposition_location: "warehouse",
				},
			],
			[{ id: "item-1", cost: 18.5 }],
		);

		await run(tx);

		expect(movementsFrom()).toEqual([
			expect.objectContaining({
				inventory_item_id: "item-1",
				qty: 4,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
				// Without a per-unit cost, weighted average cost averages the
				// arrival in at nothing.
				unit_cost: 18.5,
			}),
		]);
	});

	it("receives onto the named vehicle when the destination is a vehicle", async () => {
		const tx = makeTx(
			[
				{
					id: "li-1",
					inventory_item_id: "item-1",
					quantity: 1,
					disposition: "receive",
					disposition_location: "vehicle",
					disposition_vehicle_id: "veh-9",
				},
			],
			[{ id: "item-1", cost: 5 }],
		);

		await run(tx);

		expect(movementsFrom()[0]).toMatchObject({
			to_location_type: "vehicle",
			to_vehicle_id: "veh-9",
			reason: "receive",
		});
	});

	// The FK is ON DELETE SET NULL, so a scrapped van leaves the location saying
	// "vehicle" with no vehicle. The stock still arrived somewhere.
	it("falls back to the warehouse when the destination vehicle is gone", async () => {
		const tx = makeTx(
			[
				{
					id: "li-1",
					inventory_item_id: "item-1",
					quantity: 1,
					disposition: "receive",
					disposition_location: "vehicle",
					disposition_vehicle_id: null,
				},
			],
			[{ id: "item-1", cost: 5 }],
		);

		await run(tx);

		const movement = movementsFrom()[0]!;
		expect(movement.to_location_type).toBe("warehouse");
		expect(movement.to_vehicle_id).toBeUndefined();
	});

	it("omits unit_cost entirely when the item has no cost basis", async () => {
		const tx = makeTx(
			[{ id: "li-1", inventory_item_id: "item-1", quantity: 1, disposition: "receive" }],
			[{ id: "item-1", cost: null }],
		);

		await run(tx);

		// Absent, not zero: zero would assert the part was free.
		expect(movementsFrom()[0]).not.toHaveProperty("unit_cost");
	});

	it("moves no stock at all for a `non_stock` line, and still settles it", async () => {
		const tx = makeTx([
			{ id: "li-1", inventory_item_id: "item-1", quantity: 6, disposition: "non_stock" },
		]);

		await run(tx);

		// recordMovements is still called (with nothing) — the completion path
		// stays one shape rather than branching around the ledger.
		expect(movementsFrom()).toEqual([]);
		expect(tx.job_visit_line_item.updateMany).toHaveBeenCalledWith({
			where: { id: { in: ["li-1"] } },
			data: { fulfillment_status: "used" },
		});
	});

	it("settles a mixed visit in one ledger write, one movement per stock-moving line", async () => {
		const tx = makeTx(
			[
				{ id: "li-consume", inventory_item_id: "item-1", quantity: 2, disposition: "consume" },
				{ id: "li-receive", inventory_item_id: "item-2", quantity: 3, disposition: "receive" },
				{ id: "li-direct", inventory_item_id: "item-3", quantity: 1, disposition: "non_stock" },
			],
			[{ id: "item-2", cost: 10 }],
		);

		await run(tx);

		expect(mockRecordMovements).toHaveBeenCalledOnce();
		expect(movementsFrom().map((m) => [m.visit_line_item_id, m.reason])).toEqual([
			["li-consume", "direct_consumption"],
			["li-receive", "receive"],
		]);
		// Every line the completion looked at is settled, including the one that
		// moved nothing — otherwise it reads as outstanding work forever.
		expect(tx.job_visit_line_item.updateMany).toHaveBeenCalledWith({
			where: { id: { in: ["li-consume", "li-receive", "li-direct"] } },
			data: { fulfillment_status: "used" },
		});
	});

	it("only looks up costs for the items it is actually receiving", async () => {
		const tx = makeTx(
			[
				{ id: "li-1", inventory_item_id: "item-1", quantity: 1, disposition: "consume" },
				{ id: "li-2", inventory_item_id: "item-2", quantity: 1, disposition: "receive" },
			],
			[{ id: "item-2", cost: 4 }],
		);

		await run(tx);

		expect(tx.inventory_item.findMany).toHaveBeenCalledWith({
			where: { id: { in: ["item-2"] }, organization_id: ORG },
			select: { id: true, cost: true },
		});
	});

	it("skips the cost lookup completely when nothing is being received", async () => {
		const tx = makeTx([
			{ id: "li-1", inventory_item_id: "item-1", quantity: 1, disposition: "consume" },
		]);

		await run(tx);

		expect(tx.inventory_item.findMany).not.toHaveBeenCalled();
	});

	it("keeps the fulfillment filter — disposition does not widen what completion picks up", async () => {
		const tx = makeTx([]);

		await run(tx);

		expect(tx.job_visit_line_item.findMany).toHaveBeenCalledWith({
			where: {
				visit_id: VISIT,
				inventory_item_id: { not: null },
				OR: [{ fulfillment_status: null }, { fulfillment_status: { not: "used" } }],
			},
		});
	});
});

/**
 * Disposition is intent; fulfillment_status is lifecycle. Nothing derives one
 * from the other, which is what keeps a dispatcher re-pointing a part from
 * resurrecting a technician's "voided" as "planned".
 */
describe("disposition is orthogonal to fulfillment_status", () => {
	it("stamps the same lifecycle regardless of which disposition is attached", () => {
		const statuses = (["consume", "receive", "non_stock"] as const).map(
			(disposition) => plannedLineItemFields("item-1", 2, { disposition }).fulfillment_status,
		);

		expect(statuses).toEqual(["planned", "planned", "planned"]);
	});

	it("carries the disposition through without altering the lifecycle fields", () => {
		const fields = plannedLineItemFields("item-1", 2, {
			disposition: "receive",
			disposition_vehicle_id: "veh-1",
		});

		expect(fields).toEqual({
			inventory_item_id: "item-1",
			fulfillment_status: "planned",
			qty_planned: 2,
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: "veh-1",
		});
	});

	it("changes intent alone — dispositionFields names no lifecycle column", () => {
		const fields = dispositionFields({ disposition: "non_stock" });

		expect(fields).not.toHaveProperty("fulfillment_status");
		expect(fields).not.toHaveProperty("qty_planned");
		expect(fields.disposition).toBe("non_stock");
	});

	it("drops a destination that a non-receive disposition cannot mean", () => {
		// A stale vehicle left on a line switched to "consume" would give the
		// completion path two contradictory instructions.
		expect(dispositionFields({ disposition: "consume", disposition_vehicle_id: "veh-1" })).toEqual(
			{
				disposition: "consume",
				disposition_location: null,
				disposition_vehicle_id: null,
			},
		);
	});

	it("leaves a freetext line outside both concepts", () => {
		expect(plannedLineItemFields(null, 2, { disposition: "receive" })).toEqual({
			inventory_item_id: null,
			fulfillment_status: null,
			qty_planned: null,
			disposition: null,
			disposition_location: null,
			disposition_vehicle_id: null,
		});
	});
});
