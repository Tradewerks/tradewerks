/**
 * Plan lines never move stock themselves; they are copied into generated
 * visits. Stage A shipped the columns and the copy, nothing that could SET them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateRecurringPlanLineItems } from "../recurringPlansController.js";
import { templateDispositionFields } from "../../lib/inventory.js";
import { getScopedDb } from "../../lib/context.js";

vi.mock("../../db.js", () => ({
	db: {},
	generateJobNumber: vi.fn().mockResolvedValue("J-0001"),
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn() }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));
vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockGetScopedDb = vi.mocked(getScopedDb);

const ORG = "org-1";
// The schema validates every id as a UUID.
const ITEM = "11111111-1111-4111-8111-111111111111";
const VEHICLE = "22222222-2222-4222-8222-222222222222";
const OTHER_VEHICLE = "33333333-3333-4333-8333-333333333333";
const LINE = "44444444-4444-4444-8444-444444444444";
const PLAN = { id: "plan-1", organization_id: ORG };

type Row = { id: string };

/** Reads the plan, then writes inside one transaction we run directly. */
function makeSdb({
	existing = [] as Row[],
	orgItemIds = [ITEM],
	orgVehicleIds = [VEHICLE],
} = {}) {
	const lineItem = {
		create: vi.fn().mockResolvedValue({}),
		update: vi.fn().mockResolvedValue({}),
		delete: vi.fn().mockResolvedValue({}),
	};
	const tx = {
		inventory_item: {
			findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
				Promise.resolve(
					where.id.in.filter((id) => orgItemIds.includes(id)).map((id) => ({ id })),
				),
			),
		},
		vehicle: {
			findMany: vi.fn(({ where }: { where: { id: { in: string[] } } }) =>
				Promise.resolve(
					where.id.in.filter((id) => orgVehicleIds.includes(id)).map((id) => ({ id })),
				),
			),
		},
		recurring_plan_line_item: lineItem,
		recurring_plan: { findUnique: vi.fn().mockResolvedValue({ ...PLAN, line_items: [] }) },
	};
	const sdb = {
		recurring_plan: {
			findFirst: vi.fn().mockResolvedValue({ ...PLAN, line_items: existing }),
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		$transaction: vi.fn((cb: any) => cb(tx)),
	};
	return { sdb, tx, lineItem };
}

const line = (over: Record<string, unknown> = {}) => ({
	name: "Capacitor 5μF",
	quantity: 2,
	unit_price: 30,
	...over,
});

describe("templateDispositionFields", () => {
	it("keeps intent only where there is a part for it to be about", () => {
		expect(templateDispositionFields(null, { disposition: "receive" })).toEqual({
			disposition: null,
			disposition_location: null,
			disposition_vehicle_id: null,
		});
	});

	it("stores a `receive` destination on a linked line", () => {
		expect(
			templateDispositionFields(ITEM, {
				disposition: "receive",
				disposition_vehicle_id: VEHICLE,
			}),
		).toEqual({
			disposition: "receive",
			disposition_location: "vehicle",
			disposition_vehicle_id: VEHICLE,
		});
	});

	it("drops a destination a `non_stock` line cannot mean", () => {
		expect(
			templateDispositionFields(ITEM, {
				disposition: "non_stock",
				disposition_vehicle_id: VEHICLE,
			}),
		).toEqual({
			disposition: "non_stock",
			disposition_location: null,
			disposition_vehicle_id: null,
		});
	});
});

describe("updateRecurringPlanLineItems — disposition", () => {
	beforeEach(() => vi.clearAllMocks());

	it("writes intent onto a newly added template line", async () => {
		const { sdb, lineItem } = makeSdb();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);

		const result = await updateRecurringPlanLineItems(
			"job-1",
			{
				line_items: [
					line({
						inventory_item_id: ITEM,
						disposition: "receive",
						disposition_vehicle_id: VEHICLE,
					}),
				],
			},
			ORG,
		);

		expect(result.err).toBe("");
		expect(lineItem.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					inventory_item_id: ITEM,
					disposition: "receive",
					disposition_location: "vehicle",
					disposition_vehicle_id: VEHICLE,
				}),
			}),
		);
	});

	it("rewrites intent alongside the link on an existing line", async () => {
		const { sdb, lineItem } = makeSdb({ existing: [{ id: LINE }] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);

		await updateRecurringPlanLineItems(
			"job-1",
			{
				line_items: [
					line({ id: LINE, inventory_item_id: ITEM, disposition: "non_stock" }),
				],
			},
			ORG,
		);

		expect(lineItem.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: LINE },
				data: expect.objectContaining({
					inventory_item_id: ITEM,
					disposition: "non_stock",
					disposition_vehicle_id: null,
				}),
			}),
		);
	});

	it("leaves intent alone when the payload says nothing about the link", async () => {
		const { sdb, lineItem } = makeSdb({ existing: [{ id: LINE }] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);

		await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: [line({ id: LINE, quantity: 5 })] },
			ORG,
		);

		// Absent link means "leave it alone"; wiping intent would retarget every
		// future generated visit.
		const data = lineItem.update.mock.calls[0]![0].data;
		expect(data).not.toHaveProperty("disposition");
		expect(data).not.toHaveProperty("inventory_item_id");
	});

	it("clears intent when the link is removed", async () => {
		const { sdb, lineItem } = makeSdb({ existing: [{ id: LINE }] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);

		await updateRecurringPlanLineItems(
			"job-1",
			{ line_items: [line({ id: LINE, inventory_item_id: null, disposition: "receive" })] },
			ORG,
		);

		expect(lineItem.update.mock.calls[0]![0].data).toMatchObject({
			inventory_item_id: null,
			disposition: null,
			disposition_location: null,
			disposition_vehicle_id: null,
		});
	});

	it("refuses a destination vehicle from another org, and says why", async () => {
		const { sdb, lineItem } = makeSdb({ orgVehicleIds: [] });
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockGetScopedDb.mockReturnValue(sdb as any);

		const result = await updateRecurringPlanLineItems(
			"job-1",
			{
				line_items: [
					line({
						inventory_item_id: ITEM,
						disposition: "receive",
						disposition_vehicle_id: OTHER_VEHICLE,
					}),
				],
			},
			ORG,
		);

		expect(result.err).toBe(`Validation failed: unknown vehicle ${OTHER_VEHICLE}`);
		expect(lineItem.create).not.toHaveBeenCalled();
	});
});
