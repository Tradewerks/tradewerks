import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({
	db: {
		vehicle_readiness: {},
		technician: {},
		job_visit: {},
		vehicle_stock_item: {},
	},
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn() }));
vi.mock("../../services/logger.js", () => ({ logActivity: vi.fn(), buildChanges: vi.fn() }));
vi.mock("../../services/appLogger.js", () => ({
	log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
// vehiclesController transitively imports lowStockAlerts -> emailService, which
// throws at import when EMAIL_DISABLED=false and no Postmark env is set. Mock it
// out like the sibling vehicle suites (vehiclesStock/Adjust/Restock) do.
vi.mock("../../services/lowStockAlerts.js", () => ({
	fireLowStockAlerts: vi.fn().mockResolvedValue(undefined),
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

import {
	getVehicleReadiness,
	getFleetReadiness,
	confirmReadiness,
	revokeReadiness,
	getTomorrowRequirements,
} from "../vehiclesController.js";
import { READINESS_LINE_ITEM_WHERE } from "../../lib/inventory.js";
import { getScopedDb } from "../../lib/context.js";
import { db } from "../../db.js";

const mockGetScopedDb = vi.mocked(getScopedDb);
const mockDb = vi.mocked(db, true);

const makeVehicle = (overrides = {}) => ({
	id: "vehicle-1",
	organization_id: "org-1",
	name: "Truck 1",
	...overrides,
});

const makeTech = (vehicleId = "vehicle-1") => ({ id: "tech-1", current_vehicle_id: vehicleId });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeVisit = (lineItems: any[] = []) => ({
	id: "visit-1",
	scheduled_start_at: new Date("2026-06-10T09:00:00Z"),
	status: "Scheduled",
	line_items: lineItems,
	visit_techs: [{ tech_id: "tech-1" }],
});

const makeLineItem = (inventoryItemId: string, qty: number) => ({
	id: "li-1",
	visit_id: "visit-1",
	inventory_item_id: inventoryItemId,
	inventory_item: { id: inventoryItemId, name: "Capacitor 5μF" },
	quantity: qty,
});

function makeSdb(vehicleOverride?: object | null) {
	return {
		vehicle: {
			findFirst: vi.fn().mockResolvedValue(vehicleOverride !== undefined ? vehicleOverride : makeVehicle()),
			findMany: vi.fn().mockResolvedValue([makeVehicle()]),
		},
	};
}

// Batched compute reads everything off the raw db client
function setupBatchMocks({
	records = [] as unknown[],
	techs = [makeTech()] as unknown[],
	visits = [] as unknown[],
	stock = [] as unknown[],
} = {}) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.vehicle_readiness = {
		findMany: vi.fn().mockResolvedValue(records),
		findFirst: vi.fn().mockResolvedValue(null),
		create: vi.fn(),
		delete: vi.fn(),
	} as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.technician = { findMany: vi.fn().mockResolvedValue(techs) } as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.job_visit = { findMany: vi.fn().mockResolvedValue(visits) } as any;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.vehicle_stock_item = { findMany: vi.fn().mockResolvedValue(stock) } as any;
}

describe("getVehicleReadiness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns error when vehicle does not exist", async () => {
		const sdb = makeSdb(null);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);
		setupBatchMocks();

		const result = await getVehicleReadiness("bad-id", "org-1", "2026-06-10");

		expect(result.err).toBe("Vehicle not found");
	});

	it("returns not_applicable when no tech assigned and no readiness record", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(makeSdb() as any);
		setupBatchMocks({ techs: [] });

		const result = await getVehicleReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.err).toBe("");
		expect(result.item?.state).toBe("not_applicable");
	});

	it("returns unknown when visits exist but have no inventory-linked line items", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(makeSdb() as any);
		setupBatchMocks({ visits: [makeVisit([])] });

		const result = await getVehicleReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.item?.state).toBe("unknown");
	});

	it("returns auto_ready when all planned items are sufficiently stocked", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(makeSdb() as any);
		setupBatchMocks({
			visits: [makeVisit([makeLineItem("inv-1", 2)])],
			stock: [{ vehicle_id: "vehicle-1", inventory_item_id: "inv-1", qty_on_hand: 5 }],
		});

		const result = await getVehicleReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.item?.state).toBe("auto_ready");
		expect(result.item?.gaps[0].gap).toBe(0);
	});

	it("returns needs_action when stock is below planned qty", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(makeSdb() as any);
		setupBatchMocks({
			visits: [makeVisit([makeLineItem("inv-1", 5)])],
			stock: [{ vehicle_id: "vehicle-1", inventory_item_id: "inv-1", qty_on_hand: 2 }],
		});

		const result = await getVehicleReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.item?.state).toBe("needs_action");
		expect(result.item?.gaps[0].gap).toBe(3);
		expect(result.item?.gaps[0].qty_needed).toBe(5);
		expect(result.item?.gaps[0].qty_on_hand).toBe(2);
	});

	it("returns needs_action with gap=qty_needed for items not stocked on vehicle", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(makeSdb() as any);
		setupBatchMocks({
			visits: [makeVisit([makeLineItem("inv-1", 3)])],
			stock: [], // item not stocked on vehicle
		});

		const result = await getVehicleReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.item?.state).toBe("needs_action");
		expect(result.item?.gaps[0].qty_on_hand).toBe(0);
		expect(result.item?.gaps[0].gap).toBe(3);
	});

	it("returns confirmed state when readiness record exists", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(makeSdb() as any);
		setupBatchMocks({
			records: [
				{
					id: "rr-1",
					vehicle_id: "vehicle-1",
					confirmed_by: { name: "Jane Smith" },
					confirmed_at: new Date("2026-06-09T18:00:00Z"),
					notes: "Staged from warehouse",
				},
			],
			visits: [makeVisit([makeLineItem("inv-1", 2)])],
			stock: [{ vehicle_id: "vehicle-1", inventory_item_id: "inv-1", qty_on_hand: 5 }],
		});

		const result = await getVehicleReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.item?.state).toBe("confirmed");
		expect(result.item?.confirmed?.id).toBe("rr-1");
		expect(result.item?.confirmed?.confirmed_by).toBe("Jane Smith");
		expect(result.item?.confirmed?.notes).toBe("Staged from warehouse");
	});
});

describe("getFleetReadiness", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns per-vehicle results from ONE batched set of queries", async () => {
		const sdb = {
			vehicle: {
				findMany: vi.fn().mockResolvedValue([{ id: "vehicle-1" }, { id: "vehicle-2" }]),
			},
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);
		setupBatchMocks({
			techs: [makeTech("vehicle-1")], // vehicle-2 has no tech → not_applicable
			visits: [makeVisit([makeLineItem("inv-1", 2)])],
			stock: [{ vehicle_id: "vehicle-1", inventory_item_id: "inv-1", qty_on_hand: 5 }],
		});

		const result = await getFleetReadiness("org-1", "2026-06-10");

		expect(result.err).toBe("");
		expect(result.items).toHaveLength(2);
		const byId = new Map(result.items!.map((i) => [i.vehicle_id, i]));
		expect(byId.get("vehicle-1")?.state).toBe("auto_ready");
		expect(byId.get("vehicle-2")?.state).toBe("not_applicable");

		// Batched: exactly one query per table regardless of vehicle count
		expect(mockDb.vehicle_readiness.findMany).toHaveBeenCalledOnce();
		expect(mockDb.technician.findMany).toHaveBeenCalledOnce();
		expect(mockDb.job_visit.findMany).toHaveBeenCalledOnce();
		expect(mockDb.vehicle_stock_item.findMany).toHaveBeenCalledOnce();
	});
});

describe("confirmReadiness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const sdb = makeSdb({ id: "vehicle-1", organization_id: "org-1", name: "Truck 1" });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);
		setupBatchMocks({ techs: [] });
	});

	it("creates a readiness record and returns confirmed state", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.findFirst as any).mockResolvedValue(null); // not already confirmed
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.findMany as any).mockResolvedValue([
			{
				id: "rr-new",
				vehicle_id: "vehicle-1",
				confirmed_by: { name: "Jane Smith" },
				confirmed_at: new Date("2026-06-09T20:00:00Z"),
				notes: "Staged from warehouse",
			},
		]);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.create as any).mockResolvedValue({ id: "rr-new" });

		const result = await confirmReadiness("vehicle-1", "org-1", "dispatcher-1", {
			date: "2026-06-10",
			notes: "Staged from warehouse",
		});

		expect(result.err).toBe("");
		expect(result.item?.state).toBe("confirmed");
		expect(mockDb.vehicle_readiness.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					vehicle_id: "vehicle-1",
					organization_id: "org-1",
					confirmed_by_id: "dispatcher-1",
					notes: "Staged from warehouse",
				}),
			})
		);
	});

	it("returns error if already confirmed", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.findFirst as any).mockResolvedValue({
			id: "existing",
			confirmed_by: { name: "A B" },
			confirmed_at: new Date(),
			notes: null,
		});

		const result = await confirmReadiness("vehicle-1", "org-1", "dispatcher-1", {
			date: "2026-06-10",
		});

		expect(result.err).toBe("Vehicle is already confirmed ready for this date");
		expect(mockDb.vehicle_readiness.create).not.toHaveBeenCalled();
	});

	it("returns validation error for bad date format", async () => {
		const result = await confirmReadiness("vehicle-1", "org-1", "dispatcher-1", {
			date: "not-a-date",
		});

		expect(result.err).toContain("YYYY-MM-DD");
	});
});

describe("revokeReadiness", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const sdb = makeSdb({ id: "vehicle-1", organization_id: "org-1", name: "Truck 1" });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);
		setupBatchMocks({ techs: [] });
	});

	it("deletes the readiness record and returns updated state", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.findFirst as any).mockResolvedValue({ id: "rr-1" });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.findMany as any).mockResolvedValue([]); // after delete
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.delete as any).mockResolvedValue({});

		const result = await revokeReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.err).toBe("");
		expect(mockDb.vehicle_readiness.delete).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "rr-1" } })
		);
	});

	it("returns error when no readiness record exists", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(mockDb.vehicle_readiness.findFirst as any).mockResolvedValue(null);

		const result = await revokeReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(result.err).toBe("No readiness confirmation found for this date");
	});
});

// Two reads answer "needed tomorrow"; both must use the same predicate or
// they can disagree with each other.
describe("readiness line-item predicate", () => {
	beforeEach(() => vi.clearAllMocks());

	it("counts only linked, live, stock-consuming lines", () => {
		// Spelled out, not read off the constant.
		expect(READINESS_LINE_ITEM_WHERE).toEqual({
			inventory_item_id: { not: null },
			fulfillment_status: { not: "voided" },
			OR: [{ disposition: null }, { disposition: "consume" }],
		});
	});

	it("applies the predicate in the batched readiness read", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(makeSdb() as any);
		setupBatchMocks({ visits: [makeVisit([makeLineItem("inv-1", 2)])] });

		await getVehicleReadiness("vehicle-1", "org-1", "2026-06-10");

		expect(mockDb.job_visit.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				include: expect.objectContaining({
					line_items: expect.objectContaining({ where: READINESS_LINE_ITEM_WHERE }),
				}),
			}),
		);
	});

	it("applies the predicate in tomorrow's requirements, on both the visit filter and the lines", async () => {
		const jobVisitFindMany = vi.fn().mockResolvedValue([]);
		const sdb = {
			vehicle: { findFirst: vi.fn().mockResolvedValue(makeVehicle()) },
			organization: { findFirst: vi.fn().mockResolvedValue({ timezone: "UTC" }) },
			technician: { findMany: vi.fn().mockResolvedValue([makeTech()]) },
			job_visit: { findMany: jobVisitFindMany },
			vehicle_stock_item: { findMany: vi.fn().mockResolvedValue([]) },
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);

		const result = await getTomorrowRequirements("vehicle-1", "org-1");

		expect(result.err).toBeUndefined();
		const args = jobVisitFindMany.mock.calls[0][0];
		expect(args.where.line_items).toEqual({ some: READINESS_LINE_ITEM_WHERE });
		expect(args.include.line_items.where).toEqual(READINESS_LINE_ITEM_WHERE);
	});
});
