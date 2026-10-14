import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import {
	recordMovements,
	lockInventoryRows,
	InsufficientStockError,
	TrackingValidationError,
	type ActorInfo,
	type MovementInput,
} from "../../services/stockMovements.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTOR: ActorInfo = { actor_type: "dispatcher", actor_id: "disp-1" };
const ORG = "org-1";

function makeTx(overrides: Record<string, unknown> = {}) {
	return {
		$queryRaw: vi.fn().mockResolvedValue([]),
		// Written on intake that names a vendor AND records a cost — the
		// self-maintaining vendor price list (batched insert-on-conflict).
		$executeRaw: vi.fn().mockResolvedValue(0),
		inventory_item: {
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn().mockResolvedValue(undefined),
		},
		vehicle_stock_item: {
			upsert: vi.fn().mockResolvedValue(undefined),
			findMany: vi.fn().mockResolvedValue([]),
		},
		stock_movement: {
			createMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
		// Org-scope check on caller-supplied supplier_id for intake movements.
		// Tests that use "sup-1"/"sup-2" rely on both resolving as in-org.
		supplier: {
			findMany: vi.fn().mockResolvedValue([{ id: "sup-1" }, { id: "sup-2" }]),
		},
		...overrides,
	};
}

// `unit` is required: recordMovements stamps it onto every ledger row, so a row
// without one is not a shape the production code can be handed. quantity and
// low_stock_threshold accept Decimal as well as number because that is what Prisma
// returns from their numeric(10,2) columns.
function makeItemRow(
	id: string,
	quantity: number | Prisma.Decimal,
	low_stock_threshold: number | Prisma.Decimal | null = null,
	unit = "each",
) {
	return { id, quantity, low_stock_threshold, unit };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = ReturnType<typeof makeTx> & Record<string, any>;

// ── lockInventoryRows ─────────────────────────────────────────────────────────

describe("lockInventoryRows", () => {
	it("issues SELECT FOR UPDATE raw query with sorted ids", async () => {
		const tx = makeTx();
		await lockInventoryRows(tx as unknown as Tx, ["z-item", "a-item"]);
		expect(tx.$queryRaw).toHaveBeenCalledOnce();
	});

	it("is a no-op when itemIds is empty", async () => {
		const tx = makeTx();
		await lockInventoryRows(tx as unknown as Tx, []);
		expect(tx.$queryRaw).not.toHaveBeenCalled();
	});
});

// ── recordMovements ───────────────────────────────────────────────────────────

describe("recordMovements", () => {
	let tx: Tx;

	beforeEach(() => {
		tx = makeTx();
		tx.inventory_item.findMany.mockResolvedValue([]);
	});

	// The ledger is the source of truth for stock, but until `unit` was stamped here
	// every row was only implicitly denominated in the item's CURRENT unit — so
	// editing an item from `each` to `box` silently reinterpreted all of its history.
	// recordMovements is the single writer of stock_movement, so it is the only place
	// the stamp can be applied, and it reads the unit from the item inside the same
	// transaction rather than trusting a caller-supplied value.
	it("stamps the item's unit onto every movement row", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5, null, "ft")]);
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 12.5,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		expect(data[0].unit).toBe("ft");
	});

	it("stamps each movement with its own item's unit when a batch spans items", async () => {
		tx.inventory_item.findMany.mockResolvedValue([
			makeItemRow("item-1", 5, null, "ft"),
			makeItemRow("item-2", 5, null, "kg"),
		]);
		const movements: MovementInput[] = [
			{
				inventory_item_id: "item-1",
				qty: 1,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
			},
			{
				inventory_item_id: "item-2",
				qty: 2,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
			},
		];

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, movements);

		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		expect(data.map((d) => [d.inventory_item_id, d.unit])).toEqual([
			["item-1", "ft"],
			["item-2", "kg"],
		]);
	});

	// The low-stock trigger compares on-hand against the threshold. Both arrive as
	// Decimal now, and `<` / `<=` on Decimals coerces through valueOf() to a STRING:
	// "9" <= "10" is false, so a low item would report as fine. Values chosen so the
	// lexicographic answer differs from the numeric one.
	it("flags an item as low when Decimal quantity is under its Decimal threshold", async () => {
		tx.inventory_item.findMany.mockResolvedValue([
			makeItemRow("item-1", new Prisma.Decimal("9.00"), new Prisma.Decimal("10.00")),
		]);
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 1,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};

		const result = await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		expect(result.lowStockItemIds).toEqual(["item-1"]);
	});

	it("does not flag an item whose Decimal quantity is over its Decimal threshold", async () => {
		tx.inventory_item.findMany.mockResolvedValue([
			makeItemRow("item-1", new Prisma.Decimal("100.00"), new Prisma.Decimal("20.00")),
		]);
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 1,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};

		const result = await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		expect(result.lowStockItemIds).toEqual([]);
	});

	it("returns empty lowStockItemIds when movements array is empty", async () => {
		const result = await recordMovements(tx as unknown as Tx, ORG, ACTOR, []);
		expect(result).toEqual({ lowStockItemIds: [], gapItemIds: [], movementIds: [] });
		expect(tx.stock_movement.createMany).not.toHaveBeenCalled();
	});

	it("rejects movement with qty <= 0", async () => {
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 0,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"qty must be > 0",
		);
	});

	// quantity is numeric(10,2) now, so a measured item genuinely holds 2.5 kg —
	// the guard only needs to fit the column, not require a whole number.
	it("allows fractional qty on warehouse-touching movements", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10, null, "kg")]);
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2.5,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).resolves.toBeDefined();
	});

	it("rejects a qty with more precision than the qty column can store", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10, null, "kg")]);
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2.555,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"is not storable",
		);
	});

	it("allows fractional qty for vehicle-only movements", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10, null, "kg")]);
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 1.5,
			from_location_type: "vehicle",
			from_vehicle_id: "v-1",
			to_location_type: "consumed",
			reason: "parts_used",
		};
		await expect(
			recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]),
		).resolves.toBeDefined();
	});

	it("increments inventory_item.quantity on receive (external → warehouse)", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 5,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		expect(tx.inventory_item.update).toHaveBeenCalledWith({
			where: { id: "item-1" },
			data: { quantity: { increment: new Prisma.Decimal(5) } },
		});
	});

	it("decrements inventory_item.quantity on loss (warehouse → adjustment)", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 3,
			from_location_type: "warehouse",
			to_location_type: "adjustment",
			reason: "loss",
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		expect(tx.inventory_item.update).toHaveBeenCalledWith({
			where: { id: "item-1" },
			data: { quantity: { increment: new Prisma.Decimal(-3) } },
		});
	});

	it("throws InsufficientStockError when warehouse deduction exceeds available", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 2)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 5,
			from_location_type: "warehouse",
			to_location_type: "adjustment",
			reason: "loss",
		};

		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			InsufficientStockError,
		);
	});

	it("InsufficientStockError.available contains the per-item quantity", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 2)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 5,
			from_location_type: "warehouse",
			to_location_type: "adjustment",
			reason: "loss",
		};

		try {
			await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(InsufficientStockError);
			expect((e as InsufficientStockError).available["item-1"]).toBe(2);
		}
	});

	it("allows warehouse overdraw when allowNegative is true", async () => {
		// allowNegative skips the overdraw guard, but the item is still read — the
		// tracking flags and the unit to stamp both come from that same query.
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 1)]);
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 999,
			from_location_type: "warehouse",
			to_location_type: "adjustment",
			reason: "loss",
		};
		await expect(
			recordMovements(tx as unknown as Tx, ORG, ACTOR, [m], { allowNegative: true }),
		).resolves.toBeDefined();
	});

	it("upserts vehicle_stock_item on restock (warehouse → vehicle)", async () => {
		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 4,
			from_location_type: "warehouse",
			to_vehicle_id: "truck-1",
			to_location_type: "vehicle",
			reason: "restock",
		};
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10)]);

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		expect(tx.vehicle_stock_item.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					vehicle_id_inventory_item_id: {
						vehicle_id: "truck-1",
						inventory_item_id: "item-1",
					},
				},
			}),
		);
	});

	it("inserts a stock_movement row for every movement", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10)]);

		const movements: MovementInput[] = [
			{
				inventory_item_id: "item-1",
				qty: 2,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
			},
			{
				inventory_item_id: "item-1",
				qty: 1,
				from_location_type: "warehouse",
				to_location_type: "adjustment",
				reason: "loss",
			},
		];

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, movements);

		expect(tx.stock_movement.createMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.arrayContaining([expect.anything(), expect.anything()]) }),
		);
		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: unknown[] };
		expect(data).toHaveLength(2);
	});

	it("returns lowStockItemIds for items at or below threshold after update", async () => {
		// receive movement = positive delta = no overdraw check; only one findMany call (post-update)
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 4, 5)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		const result = await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);
		expect(result.lowStockItemIds).toContain("item-1");
	});

	it("aggregates deltas from multiple movements on the same item", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 20)]);

		// +10 then -3 = net +7
		const movements: MovementInput[] = [
			{
				inventory_item_id: "item-1",
				qty: 10,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
			},
			{
				inventory_item_id: "item-1",
				qty: 3,
				from_location_type: "warehouse",
				to_location_type: "adjustment",
				reason: "loss",
			},
		];

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, movements);

		// Net delta = +10 - 3 = +7; single update call
		expect(tx.inventory_item.update).toHaveBeenCalledOnce();
		expect(tx.inventory_item.update).toHaveBeenCalledWith({
			where: { id: "item-1" },
			data: { quantity: { increment: new Prisma.Decimal(7) } },
		});
	});

	// Deltas are accumulated in Decimal, not float: 0.1 + 0.2 as doubles is
	// 0.30000000000000004, which both wrote a third decimal into the increment and
	// made the overdraw guard see -5.5e-17 < 0 on an item with exactly 0.3 on hand.
	it("does not raise a false InsufficientStock from float noise when 2-dp deductions exactly equal on-hand", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", new Prisma.Decimal("0.3"))]);

		const movements: MovementInput[] = [
			{ inventory_item_id: "item-1", qty: 0.1, from_location_type: "warehouse", to_location_type: "consumed", reason: "direct_consumption" },
			{ inventory_item_id: "item-1", qty: 0.2, from_location_type: "warehouse", to_location_type: "consumed", reason: "direct_consumption" },
		];

		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, movements)).resolves.toBeDefined();
		expect(tx.inventory_item.update).toHaveBeenCalledWith({
			where: { id: "item-1" },
			data: { quantity: { increment: new Prisma.Decimal("-0.3") } },
		});
		const increment = tx.inventory_item.update.mock.calls[0][0].data.quantity.increment as Prisma.Decimal;
		expect(increment.toString()).toBe("-0.3");
	});

	it("still raises InsufficientStock when 2-dp deductions exceed on-hand by one cent", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", new Prisma.Decimal("0.3"))]);

		const movements: MovementInput[] = [
			{ inventory_item_id: "item-1", qty: 0.1, from_location_type: "warehouse", to_location_type: "consumed", reason: "direct_consumption" },
			{ inventory_item_id: "item-1", qty: 0.21, from_location_type: "warehouse", to_location_type: "consumed", reason: "direct_consumption" },
		];

		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, movements)).rejects.toThrow(InsufficientStockError);
	});

	it("accumulates vehicle deltas in Decimal too (no third decimal reaches the upsert)", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10)]);

		const movements: MovementInput[] = [
			{ inventory_item_id: "item-1", qty: 0.1, from_location_type: "vehicle", from_vehicle_id: "truck-1", to_location_type: "consumed", reason: "parts_used" },
			{ inventory_item_id: "item-1", qty: 0.2, from_location_type: "vehicle", from_vehicle_id: "truck-1", to_location_type: "consumed", reason: "parts_used" },
		];

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, movements, { allowNegative: true });

		const upsert = tx.vehicle_stock_item.upsert.mock.calls[0][0];
		expect((upsert.update.qty_on_hand.increment as Prisma.Decimal).toString()).toBe("-0.3");
		expect((upsert.create.qty_on_hand as Prisma.Decimal).toString()).toBe("-0.3");
	});

	it("locks inventory rows before reading quantities", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 10)]);

		const calls: string[] = [];
		tx.$queryRaw.mockImplementation(async () => { calls.push("lock"); });
		tx.inventory_item.findMany.mockImplementation(async () => { calls.push("read"); return [makeItemRow("item-1", 10)]; });

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "warehouse",
			to_location_type: "adjustment",
			reason: "loss",
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		const lockIdx = calls.indexOf("lock");
		const readIdx = calls.indexOf("read");
		expect(lockIdx).toBeLessThan(readIdx);
	});

	it("sets actor_type and actor_id on movement rows", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		await recordMovements(tx as unknown as Tx, ORG, { actor_type: "technician", actor_id: "tech-99" }, [m]);

		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		expect(data[0].actor_type).toBe("technician");
		expect(data[0].actor_id).toBe("tech-99");
	});

	it("persists unit_cost on an intake movement", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			unit_cost: 40.25,
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		expect(Number(data[0].unit_cost)).toBe(40.25);
	});

	it("writes a null unit_cost when the caller records none", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		// null, not 0 — an unrecorded purchase cost is unknown, and the
		// weighted-average cost series excludes it rather than averaging in zero.
		expect(data[0].unit_cost).toBeNull();
	});

	it("persists supplier_id on both intake reasons", async () => {
		tx.inventory_item.findMany.mockResolvedValue([
			makeItemRow("item-1", 5),
			makeItemRow("item-2", 5),
		]);

		const movements: MovementInput[] = [
			{
				inventory_item_id: "item-1",
				qty: 2,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
				supplier_id: "sup-1",
			},
			{
				inventory_item_id: "item-2",
				qty: 3,
				from_location_type: "external",
				to_location_type: "vehicle",
				to_vehicle_id: "veh-1",
				reason: "supplier_purchase",
				supplier_id: "sup-2",
			},
		];
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, movements);

		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		expect(data[0].supplier_id).toBe("sup-1");
		expect(data[1].supplier_id).toBe("sup-2");
	});

	it("drops supplier_id on a non-intake reason", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "warehouse",
			to_location_type: "vehicle",
			to_vehicle_id: "veh-1",
			reason: "restock",
			supplier_id: "sup-1",
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		// Enforced here, not left to callers: an internal transfer that inherited a
		// vendor would inflate that vendor's purchase history with stock it never sold.
		expect(data[0].supplier_id).toBeNull();
	});

	it("records the price paid against that vendor's price list", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			supplier_id: "sup-1",
			unit_cost: 572.15,
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		// A price list maintained by hand goes stale immediately; this one learns
		// from the purchase that just happened, via a single batched upsert.
		expect(tx.$executeRaw).toHaveBeenCalledOnce();
		const [, ids, orgIds, supplierIds, itemIds, prices] = tx.$executeRaw.mock.calls[0] as [
			unknown,
			string[],
			string[],
			string[],
			string[],
			number[],
		];
		expect(ids).toHaveLength(1);
		expect(orgIds[0]).toBe(ORG);
		expect(supplierIds[0]).toBe("sup-1");
		expect(itemIds[0]).toBe("item-1");
		expect(Number(prices[0])).toBe(572.15);
	});

	it("learns nothing from a purchase with no vendor, or a vendor with no price", async () => {
		tx.inventory_item.findMany.mockResolvedValue([
			makeItemRow("item-1", 5),
			makeItemRow("item-2", 5),
		]);

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [
			{
				inventory_item_id: "item-1",
				qty: 2,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
				unit_cost: 572.15,
			},
			{
				inventory_item_id: "item-2",
				qty: 2,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
				supplier_id: "sup-1",
			},
		]);

		expect(tx.$executeRaw).not.toHaveBeenCalled();
	});

	it("rejects a supplier_id that does not resolve to an org-scoped supplier", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);
		tx.supplier.findMany.mockResolvedValue([]); // caller's supplier_id isn't in this org

		const m: MovementInput = {
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			supplier_id: "sup-foreign",
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"not found in org scope",
		);
	});

	it("upserts the price list once per (supplier, item) pair, not once per movement", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);

		// Two movements on the same vendor+item in one batch (e.g. a receipt split
		// across serial lines) should collapse into a single upsert, keeping the
		// last observation's price.
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [
			{
				inventory_item_id: "item-1",
				qty: 1,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
				supplier_id: "sup-1",
				unit_cost: 10,
			},
			{
				inventory_item_id: "item-1",
				qty: 1,
				from_location_type: "external",
				to_location_type: "warehouse",
				reason: "receive",
				supplier_id: "sup-1",
				unit_cost: 12,
			},
		]);

		expect(tx.$executeRaw).toHaveBeenCalledOnce();
		const [, ids, , , , prices] = tx.$executeRaw.mock.calls[0] as [
			unknown,
			string[],
			string[],
			string[],
			string[],
			number[],
		];
		expect(ids).toHaveLength(1);
		expect(Number(prices[0])).toBe(12);
	});

	it("learns nothing from an internal move, even when both are present", async () => {
		tx.inventory_item.findMany.mockResolvedValue([makeItemRow("item-1", 5)]);

		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [
			{
				inventory_item_id: "item-1",
				qty: 2,
				from_location_type: "warehouse",
				to_location_type: "vehicle",
				to_vehicle_id: "veh-1",
				reason: "restock",
				supplier_id: "sup-1",
				unit_cost: 572.15,
			},
		]);

		// Moving stock to a van is not a purchase, and must not restate a price.
		expect(tx.$executeRaw).not.toHaveBeenCalled();
	});
});

// ── recordMovements: serial + batch tracking (Phase 5) ─────────────────────────

function makeTrackedTx(over: Record<string, unknown> = {}) {
	return {
		...makeTx(),
		inventory_item: {
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn().mockResolvedValue(undefined),
		},
		vehicle_stock_item: {
			upsert: vi.fn().mockResolvedValue(undefined),
			findMany: vi.fn().mockResolvedValue([]),
		},
		stock_movement: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
		stock_movement_serial: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
		stock_movement_batch: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
		serial_unit: {
			create: vi.fn().mockResolvedValue({ id: "u-x", batch_id: null }),
			createMany: vi.fn().mockResolvedValue({ count: 0 }),
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn().mockResolvedValue(undefined),
			updateMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
		stock_batch: {
			findFirst: vi.fn().mockResolvedValue({ qty_in_warehouse: 0 }),
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn().mockResolvedValue(undefined),
			create: vi.fn().mockResolvedValue({ id: "b-x", code: "LOT-X" }),
		},
		vehicle_stock_batch: {
			findFirst: vi.fn().mockResolvedValue(null),
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn().mockResolvedValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
			create: vi.fn().mockResolvedValue(undefined),
		},
		job_visit: { findUnique: vi.fn().mockResolvedValue({ job: { client_id: "cli-1" } }) },
		$queryRaw: vi.fn().mockResolvedValue([]),
		...over,
	};
}

function serializedRow(id: string, quantity = 100) {
	return { id, quantity, low_stock_threshold: null, is_serialized: true, is_batch_tracked: false, unit: "each" };
}
function batchRow(id: string, quantity = 100) {
	return { id, quantity, low_stock_threshold: null, is_serialized: false, is_batch_tracked: true, unit: "each" };
}

describe("recordMovements — serial tracking", () => {
	it("creates serial units + join rows on a serialized receive", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([serializedRow("s1")]);

		const m: MovementInput = {
			inventory_item_id: "s1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			serial: { create: [{ serial_number: "SN-A" }, { serial_number: "SN-B" }] },
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		// Batched into a single createMany with pre-generated ids (no per-row create).
		expect(tx.serial_unit.create).not.toHaveBeenCalled();
		expect(tx.serial_unit.createMany).toHaveBeenCalledTimes(1);
		const { data } = tx.serial_unit.createMany.mock.calls[0][0] as {
			data: { id: string; serial_number: string }[];
		};
		expect(data).toHaveLength(2);
		expect(data.map((d) => d.serial_number)).toEqual(["SN-A", "SN-B"]);
		expect(new Set(data.map((d) => d.id)).size).toBe(2); // ids pre-generated + unique

		const joins = tx.stock_movement_serial.createMany.mock.calls[0][0] as { data: unknown[] };
		expect(joins.data).toHaveLength(2);
	});

	it("rejects serial count that does not equal qty", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([serializedRow("s1")]);
		const m: MovementInput = {
			inventory_item_id: "s1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			serial: { create: [{ serial_number: "SN-A" }] },
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"must equal qty",
		);
	});

	it("throws when a serialized item moves with no serial inputs", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([serializedRow("s1")]);
		const m: MovementInput = {
			inventory_item_id: "s1",
			qty: 1,
			from_location_type: "vehicle",
			from_vehicle_id: "v1",
			to_location_type: "consumed",
			reason: "parts_used",
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"requires serial units",
		);
	});

	it("allowUntracked lets a serialized movement through with a TRACKING_GAP note", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([serializedRow("s1")]);
		const m: MovementInput = {
			inventory_item_id: "s1",
			qty: 1,
			from_location_type: "vehicle",
			from_vehicle_id: "v1",
			to_location_type: "consumed",
			reason: "parts_used",
		};
		const result = await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m], {
			allowUntracked: true,
		});
		expect(result.gapItemIds).toContain("s1");
		const { data } = tx.stock_movement.createMany.mock.calls[0][0] as { data: Record<string, unknown>[] };
		expect(String(data[0].note)).toContain("[TRACKING_GAP]");
		expect(tx.serial_unit.create).not.toHaveBeenCalled();
		expect(tx.serial_unit.createMany).not.toHaveBeenCalled();
	});

	it("transitions an existing on_vehicle unit to consumed with client snapshot", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([serializedRow("s1")]);
		tx.serial_unit.findMany.mockResolvedValue([
			{ id: "u1", status: "on_vehicle", current_vehicle_id: "v1", batch_id: null },
		]);
		const m: MovementInput = {
			inventory_item_id: "s1",
			qty: 1,
			from_location_type: "vehicle",
			from_vehicle_id: "v1",
			to_location_type: "consumed",
			reason: "parts_used",
			visit_id: "visit-1",
			serial: { unit_ids: ["u1"] },
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		// Transitions are collapsed into a single updateMany (no per-row update).
		expect(tx.serial_unit.update).not.toHaveBeenCalled();
		expect(tx.serial_unit.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ["u1"] } },
				data: expect.objectContaining({ status: "consumed", client_id: "cli-1" }),
			}),
		);
	});

	it("rejects consuming a unit whose current status does not match the source", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([serializedRow("s1")]);
		tx.serial_unit.findMany.mockResolvedValue([
			{ id: "u1", status: "in_warehouse", current_vehicle_id: null, batch_id: null },
		]);
		const m: MovementInput = {
			inventory_item_id: "s1",
			qty: 1,
			from_location_type: "vehicle",
			from_vehicle_id: "v1",
			to_location_type: "consumed",
			reason: "parts_used",
			serial: { unit_ids: ["u1"] },
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"expected on_vehicle",
		);
	});

	it("rejects serial inputs on a non-serialized item", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([
			{
				id: "p1",
				quantity: 100,
				low_stock_threshold: null,
				is_serialized: false,
				is_batch_tracked: false,
				unit: "each",
			},
		]);
		const m: MovementInput = {
			inventory_item_id: "p1",
			qty: 1,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			serial: { create: [{ serial_number: "SN-A" }] },
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"non-serialized item",
		);
	});
});

describe("recordMovements — batch tracking", () => {
	it("increments batch warehouse + received qty on a batch receive", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([batchRow("b1")]);
		tx.stock_batch.findFirst.mockResolvedValue({
			code: "LOT-1",
			inventory_item_id: "b1",
			recalled_at: null,
			qty_in_warehouse: 0,
		});

		const m: MovementInput = {
			inventory_item_id: "b1",
			qty: 5,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
			batch_allocations: [{ batch_id: "batch-1", qty: 5 }],
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		expect(tx.stock_batch.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "batch-1" },
				data: expect.objectContaining({
					qty_in_warehouse: { increment: expect.anything() },
					qty_received: { increment: expect.anything() },
				}),
			}),
		);
		const joins = tx.stock_movement_batch.createMany.mock.calls[0][0] as { data: unknown[] };
		expect(joins.data).toHaveLength(1);
	});

	it("FIFO auto-allocates a warehouse deduction with no explicit picks", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([batchRow("b1")]);
		// collectLockTargets candidate scan + FIFO scan both use findMany
		tx.stock_batch.findMany.mockResolvedValue([{ id: "batch-1", qty_in_warehouse: 10 }]);
		tx.stock_batch.findFirst.mockResolvedValue({
			code: "LOT-1",
			inventory_item_id: "b1",
			recalled_at: null,
			qty_in_warehouse: 10,
		});

		const m: MovementInput = {
			inventory_item_id: "b1",
			qty: 3,
			from_location_type: "warehouse",
			to_location_type: "adjustment",
			reason: "loss",
		};
		await recordMovements(tx as unknown as Tx, ORG, ACTOR, [m]);

		expect(tx.stock_batch.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "batch-1" } }),
		);
		const joins = tx.stock_movement_batch.createMany.mock.calls[0][0] as { data: { qty: unknown }[] };
		expect(joins.data).toHaveLength(1);
		expect(Number(joins.data[0].qty)).toBe(3);
	});

	it("rejects a batch receive that names no batch", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([batchRow("b1")]);
		const m: MovementInput = {
			inventory_item_id: "b1",
			qty: 5,
			from_location_type: "external",
			to_location_type: "warehouse",
			reason: "receive",
		};
		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toThrow(
			"must name a batch",
		);
	});

	// ── Explicit-pick validation gaps (audit 2026-07-14, phase 0) ────────────────
	//
	// autoAllocateFifo (the no-explicit-picks path) already scopes candidate batches
	// to `inventory_item_id` and `recalled_at: null`. applyBatchAllocations — the
	// path every explicit batch_allocations pick goes through — validates neither.
	// These tests pin the intended behavior; they fail today because the seam is
	// unguarded (findFirst({ where: { id: a.batch_id } }) only, at
	// inventoryTracking.ts:438).

	it("rejects an explicit batch pick naming a recalled lot", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([batchRow("b1")]);
		tx.stock_batch.findFirst.mockResolvedValue({
			qty_in_warehouse: 10,
			recalled_at: new Date("2026-07-02"),
			inventory_item_id: "b1",
		});

		const m: MovementInput = {
			inventory_item_id: "b1",
			qty: 3,
			from_location_type: "warehouse",
			to_location_type: "vehicle",
			to_vehicle_id: "v1",
			reason: "restock",
			batch_allocations: [{ batch_id: "batch-recalled", qty: 3 }],
		};

		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toBeInstanceOf(
			TrackingValidationError,
		);
	});

	it("rejects an explicit batch pick naming a lot that belongs to a different inventory item", async () => {
		const tx = makeTrackedTx();
		tx.inventory_item.findMany.mockResolvedValue([batchRow("b1")]);
		tx.stock_batch.findFirst.mockResolvedValue({
			qty_in_warehouse: 10,
			recalled_at: null,
			inventory_item_id: "some-other-item",
		});

		const m: MovementInput = {
			inventory_item_id: "b1",
			qty: 3,
			from_location_type: "warehouse",
			to_location_type: "vehicle",
			to_vehicle_id: "v1",
			reason: "restock",
			batch_allocations: [{ batch_id: "batch-cross-item", qty: 3 }],
		};

		await expect(recordMovements(tx as unknown as Tx, ORG, ACTOR, [m])).rejects.toBeInstanceOf(
			TrackingValidationError,
		);
	});
});
