/**
 * PO receive may give an unassigned item a home, but must never move an item
 * that already has one. The guard is `location: null` in the updateMany WHERE,
 * so these tests assert on the predicate rather than on the absence of a write.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { logActivity } from "../../services/logger.js";
import { receivePurchase } from "../purchasesController.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		purchase: { findFirst: vi.fn() },
		vehicle: { findMany: vi.fn() },
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb, generatePurchaseNumber: vi.fn() };
});

vi.mock("../../lib/context.js", async () => {
	const { db } = await import("../../db.js");
	return { getScopedDb: () => db, getUserContext: vi.fn() };
});

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
}));

const mockRecordMovements = vi.fn().mockResolvedValue({ lowStockItemIds: [], movementIds: [] });
vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: (...args: unknown[]) => mockRecordMovements(...args),
}));

vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeVisitTotals: vi.fn().mockResolvedValue(undefined),
}));

const ORG = "org-1";
const PO = "po-1";
// receivePurchaseSchema requires uuid line ids; LINE_1 plays the role of "line-1".
const LINE_1 = "00000000-0000-4000-8000-000000000001";
const LINE_2 = "00000000-0000-4000-8000-000000000002";
const TRUCK = "00000000-0000-4000-8000-0000000000aa";

type LineFixture = {
	id: string;
	description: string;
	quantity: Prisma.Decimal;
	quantity_recieved: Prisma.Decimal;
	unit_price: Prisma.Decimal;
	inventory_item_id: string | null;
	disposition: string;
	disposition_vehicle_id: string | null;
	visit_line_item_id: string | null;
	allocation_id: string | null;
	received_at: Date | null;
};

function line(overrides: Partial<LineFixture> = {}): LineFixture {
	return {
		id: LINE_1,
		description: "Capacitor 45/5",
		quantity: new Prisma.Decimal(10),
		quantity_recieved: new Prisma.Decimal(0),
		unit_price: new Prisma.Decimal(12),
		inventory_item_id: "item-1",
		disposition: "receive",
		disposition_vehicle_id: null,
		visit_line_item_id: null,
		allocation_id: null,
		received_at: null,
		...overrides,
	};
}

type Tx = {
	$queryRaw: ReturnType<typeof vi.fn>;
	purchase_line: {
		findMany: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
	purchase: {
		update: ReturnType<typeof vi.fn>;
		findUniqueOrThrow: ReturnType<typeof vi.fn>;
	};
	purchase_event: { create: ReturnType<typeof vi.fn> };
	inventory_item: {
		update: ReturnType<typeof vi.fn>;
		updateMany: ReturnType<typeof vi.fn>;
		upsert: ReturnType<typeof vi.fn>;
	};
	job_visit_line_item: { update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

let tx: Tx;

function setup(lines: LineFixture[]) {
	const purchase = {
		id: PO,
		purchase_number: "PO-1042",
		status: "ordered",
		supplier_id: null,
		qb_sync_status: "not_synced",
		lines,
		allocations: [],
	};
	vi.mocked(db.purchase.findFirst).mockResolvedValue(purchase as never);
	vi.mocked(db.vehicle.findMany).mockResolvedValue([{ id: TRUCK }] as never);

	tx = {
		$queryRaw: vi.fn().mockResolvedValue([]),
		purchase_line: {
			findMany: vi.fn().mockImplementation((args: { where: { id?: { in: string[] } } }) => {
				const ids = args.where.id?.in;
				return Promise.resolve(ids ? lines.filter((l) => ids.includes(l.id)) : lines);
			}),
			update: vi.fn().mockResolvedValue({}),
		},
		purchase: {
			update: vi.fn().mockResolvedValue({}),
			findUniqueOrThrow: vi.fn().mockResolvedValue({ id: PO, status: "partially_received" }),
		},
		purchase_event: { create: vi.fn().mockResolvedValue({}) },
		inventory_item: {
			update: vi.fn().mockResolvedValue({}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			upsert: vi.fn().mockResolvedValue({}),
		},
		job_visit_line_item: { update: vi.fn(), create: vi.fn() },
	};
	vi.mocked(db.$transaction).mockImplementation((async (fn: (t: Tx) => unknown) =>
		fn(tx)) as never);
}

type WriteArgs = { where?: Record<string, unknown>; data?: Record<string, unknown> };

/** Every inventory_item write in the receive path that carries a `location` key. */
function locationWrites(): WriteArgs[] {
	const calls = [
		...tx.inventory_item.update.mock.calls,
		...tx.inventory_item.updateMany.mock.calls,
		...tx.inventory_item.upsert.mock.calls,
	].map((c) => c[0] as WriteArgs & { create?: object; update?: object });
	return calls.filter(
		(a) =>
			(a.data && "location" in a.data) ||
			(a.create && "location" in a.create) ||
			(a.update && "location" in a.update),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("receivePurchase — location assignment", () => {
	it("assigns a location to an item that has none", async () => {
		setup([line()]);

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(result.err).toBeUndefined();
		expect(tx.inventory_item.updateMany).toHaveBeenCalledWith({
			where: { id: "item-1", organization_id: "org-1", location: null },
			data: { location: "Receiving Dock" },
		});
	});

	it("does not overwrite a location the item already has", async () => {
		// The item already lives on "A42 - 325", so the guarded WHERE matches zero
		// rows. Asserting on the predicate is the point: a read-then-write version
		// would pass a naive test and still lose the race.
		setup([line()]);
		tx.inventory_item.updateMany.mockResolvedValue({ count: 0 });

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(result.err).toBeUndefined();
		expect(result.purchase).toBeDefined();

		const writes = locationWrites();
		expect(writes).toHaveLength(1);
		expect(writes[0].where).toHaveProperty("location", null);
		expect(writes[0].where).toEqual({ id: "item-1", organization_id: "org-1", location: null });
		expect(tx.inventory_item.update).not.toHaveBeenCalled();
		expect(tx.inventory_item.upsert).not.toHaveBeenCalled();
	});

	it("does not touch inventory_item when no location is sent", async () => {
		setup([line()]);

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5 }],
		});

		expect(result.err).toBeUndefined();
		expect(tx.inventory_item.updateMany).not.toHaveBeenCalled();
		expect(locationWrites()).toHaveLength(0);
	});

	it("ignores a whitespace-only location", async () => {
		setup([line()]);

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "   " }],
		});

		expect(result.err).toBeUndefined();
		expect(tx.inventory_item.updateMany).not.toHaveBeenCalled();
		expect(locationWrites()).toHaveLength(0);
	});

	it("skips a line with no inventory item even when a location is sent", async () => {
		setup([line({ id: LINE_2, inventory_item_id: null, disposition: "receive" })]);

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_2, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(result.err).toBeUndefined();
		expect(tx.inventory_item.updateMany).not.toHaveBeenCalled();
		expect(locationWrites()).toHaveLength(0);
	});

	it("trims the requested location before writing it", async () => {
		setup([line()]);

		await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "  Receiving Dock  " }],
		});

		expect(tx.inventory_item.updateMany).toHaveBeenCalledWith({
			where: { id: "item-1", organization_id: "org-1", location: null },
			data: { location: "Receiving Dock" },
		});
	});

	it("ignores a location on a line bound for a vehicle", async () => {
		// The stock goes onto the truck, never onto a shelf, so a location typed
		// against it describes nothing about where the item lives.
		setup([line({ disposition_vehicle_id: TRUCK })]);

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(result.err).toBeUndefined();
		expect(locationWrites()).toHaveLength(0);
	});

	it("ignores a location when the receive overrides the destination to a vehicle", async () => {
		setup([line()]);

		const result = await receivePurchase(ORG, PO, {
			lines: [
				{
					id: LINE_1,
					quantity_received: 5,
					disposition_vehicle_id: TRUCK,
					location: "Receiving Dock",
				},
			],
		});

		expect(result.err).toBeUndefined();
		expect(locationWrites()).toHaveLength(0);
	});

	it("honours a location when the receive overrides a vehicle line back to the warehouse", async () => {
		setup([line({ disposition_vehicle_id: TRUCK })]);

		const result = await receivePurchase(ORG, PO, {
			lines: [
				{ id: LINE_1, quantity_received: 5, disposition_vehicle_id: null, location: "Receiving Dock" },
			],
		});

		expect(result.err).toBeUndefined();
		expect(locationWrites()).toHaveLength(1);
	});

	it("ignores a location on a job-costed (non_stock) line", async () => {
		setup([line({ disposition: "non_stock" })]);

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(result.err).toBeUndefined();
		expect(locationWrites()).toHaveLength(0);
	});

	it("logs the assignment on the item when the guard lets it through", async () => {
		setup([line()]);

		await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "inventory_item.updated",
				entity_id: "item-1",
				changes: { location: { old: null, new: "Receiving Dock" } },
			}),
		);
	});

	it("does not log an assignment the guard declined", async () => {
		setup([line()]);
		tx.inventory_item.updateMany.mockResolvedValue({ count: 0 });

		await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(logActivity).not.toHaveBeenCalledWith(
			expect.objectContaining({ entity_type: "inventory_item" }),
		);
	});

	it("writes no location when the over-receipt guard rejects the receive", async () => {
		setup([line({ quantity_recieved: new Prisma.Decimal(8) })]);

		const result = await receivePurchase(ORG, PO, {
			lines: [{ id: LINE_1, quantity_received: 5, location: "Receiving Dock" }],
		});

		expect(result.err).toMatch(/more than the 10 ordered/);
		expect(tx.inventory_item.updateMany).not.toHaveBeenCalled();
	});
});
