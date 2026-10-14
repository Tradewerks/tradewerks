import { describe, it, expect, vi, beforeEach } from "vitest";
import { listProvisionalItems, approveProvisionalItem, rejectProvisionalItem, mergeProvisionalItem } from "../inventoryController.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		inventory_item: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			updateMany: vi.fn(),
			delete: vi.fn(),
		},
		vehicle_stock_item: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
		},
		vehicle_stock_usage: {
			updateMany: vi.fn(),
		},
		vehicle_restock_request: {
			updateMany: vi.fn(),
		},
		stock_movement: {
			updateMany: vi.fn(),
		},
		job_visit_line_item: {
			updateMany: vi.fn(),
		},
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn((orgId: string) => {
		const { db } = require("../../db.js");
		return db;
	}),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: {
		error: vi.fn(),
		warn: vi.fn(),
		info: vi.fn(),
	},
}));

vi.mock("../../services/lowStockAlerts.js", () => ({
	sendLowStockAlert: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [] }),
	InsufficientStockError: class InsufficientStockError extends Error {
		available: Record<string, number>;
		constructor(available: Record<string, number>) {
			super("Insufficient warehouse stock");
			this.name = "InsufficientStockError";
			this.available = available;
		}
	},
}));

vi.mock("xlsx", () => ({
	default: {},
	read: vi.fn(),
	utils: { sheet_to_json: vi.fn(), json_to_sheet: vi.fn(), book_new: vi.fn(), book_append_sheet: vi.fn(), aoa_to_sheet: vi.fn() },
	write: vi.fn(),
}));

import { db } from "../../db.js";
const mockDb = vi.mocked(db);

describe("provisionalItems", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// -------------------------------------------------------------------------
	// listProvisionalItems
	// -------------------------------------------------------------------------
	describe("listProvisionalItems", () => {
		it("returns provisional items with tech + vehicle stocks", async () => {
			const mockItems = [{
				id: "prov-1",
				name: "Fuse 30A",
				provisional: true,
				created_by_tech: { id: "tech-1", name: "Bob" },
				vehicle_stocks: [{ qty_on_hand: 3, vehicle: { id: "v-1", name: "Truck 1" } }],
			}];
			mockDb.inventory_item.findMany.mockResolvedValue(mockItems);
			const result = await listProvisionalItems("org-1");
			expect(result.items).toEqual(mockItems);
			expect(mockDb.inventory_item.findMany).toHaveBeenCalledWith(expect.objectContaining({
				where: { organization_id: "org-1", provisional: true },
			}));
		});

		it("returns empty array when no provisional items exist", async () => {
			mockDb.inventory_item.findMany.mockResolvedValue([]);
			const result = await listProvisionalItems("org-1");
			expect(result.items).toEqual([]);
			expect(result.err).toBeUndefined();
		});

		it("returns err string on database failure", async () => {
			mockDb.inventory_item.findMany.mockRejectedValue(new Error("DB error"));
			const result = await listProvisionalItems("org-1");
			expect(result.err).toBe("Failed to list provisional items");
			expect(result.items).toBeUndefined();
		});
	});

	// -------------------------------------------------------------------------
	// approveProvisionalItem
	// -------------------------------------------------------------------------
	describe("approveProvisionalItem", () => {
		beforeEach(() => {
			mockDb.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(mockDb));
		});

		it("flips provisional=false with timestamp", async () => {
			mockDb.inventory_item.updateMany.mockResolvedValue({ count: 1 });
			mockDb.inventory_item.findFirst.mockResolvedValue({ id: "prov-1", provisional: false });
			const result = await approveProvisionalItem("prov-1", "org-1", {}, { dispatcherId: "d-1" });
			expect(result.err).toBeUndefined();
			expect(mockDb.inventory_item.updateMany).toHaveBeenCalledWith(expect.objectContaining({
				where: { id: "prov-1", organization_id: "org-1", provisional: true },
				data: expect.objectContaining({ provisional: false, approved_by_id: "d-1" }),
			}));
		});

		it("returns error when item not found", async () => {
			mockDb.inventory_item.updateMany.mockResolvedValue({ count: 0 });
			const result = await approveProvisionalItem("missing", "org-1", {});
			expect(result.err).toBe("Provisional item not found");
		});

		it("returns err string on database failure", async () => {
			mockDb.inventory_item.updateMany.mockRejectedValue(new Error("DB error"));
			const result = await approveProvisionalItem("prov-1", "org-1", {});
			expect(result.err).toBe("Failed to approve provisional item");
		});

		it("sets approved_by_id to null when no dispatcherId in context", async () => {
			mockDb.inventory_item.updateMany.mockResolvedValue({ count: 1 });
			mockDb.inventory_item.findFirst.mockResolvedValue({ id: "prov-1", provisional: false });
			await approveProvisionalItem("prov-1", "org-1", {});
			expect(mockDb.inventory_item.updateMany).toHaveBeenCalledWith(expect.objectContaining({
				data: expect.objectContaining({ approved_by_id: null }),
			}));
		});

		it("returns the updated item on success", async () => {
			const updatedItem = { id: "prov-1", name: "Fuse 30A", provisional: false };
			mockDb.inventory_item.updateMany.mockResolvedValue({ count: 1 });
			mockDb.inventory_item.findFirst.mockResolvedValue(updatedItem);
			const result = await approveProvisionalItem("prov-1", "org-1", {}, { dispatcherId: "d-1" });
			expect(result.item).toEqual(updatedItem);
		});
	});

	// -------------------------------------------------------------------------
	// mergeProvisionalItem
	// -------------------------------------------------------------------------
	describe("mergeProvisionalItem", () => {
		// Build a tx mock that each test can configure independently
		function makeTx() {
			return {
				inventory_item: {
					findFirst: vi.fn(),
					delete: vi.fn(),
				},
				vehicle_stock_item: {
					findMany: vi.fn(),
					findFirst: vi.fn(),
					update: vi.fn(),
					delete: vi.fn(),
				},
				vehicle_stock_usage: {
					updateMany: vi.fn(),
				},
				vehicle_restock_request: {
					updateMany: vi.fn(),
				},
				stock_movement: {
					updateMany: vi.fn(),
				},
				// All five tables that can hold a link to an inventory item.
				job_visit_line_item: { updateMany: vi.fn() },
				quote_line_item: { updateMany: vi.fn() },
				job_line_item: { updateMany: vi.fn() },
				recurring_plan_line_item: { updateMany: vi.fn() },
				invoice_line_item: { updateMany: vi.fn() },
			};
		}

		const LINKED_TABLES = [
			"job_visit_line_item",
			"quote_line_item",
			"job_line_item",
			"recurring_plan_line_item",
			"invoice_line_item",
		] as const;

		const PROV_ID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
		const TARGET_ID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
		const ORG_ID = "org-1";
		const VALID_BODY = { target_inventory_item_id: TARGET_ID };

		it("happy path — no collision: re-points stock row to target", async () => {
			const tx = makeTx();
			// $transaction executes the callback synchronously with the tx mock
			mockDb.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx));

			const provItem = { id: PROV_ID, provisional: true };
			const targetItem = { id: TARGET_ID, provisional: false };
			const provStock = { id: "ps-1", vehicle_id: "v-1", qty_on_hand: 3, inventory_item_id: PROV_ID };

			// findFirst: first call → prov, second call → target
			tx.inventory_item.findFirst
				.mockResolvedValueOnce(provItem)
				.mockResolvedValueOnce(targetItem);
			// no stock rows on target vehicle → null (no collision)
			tx.vehicle_stock_item.findMany.mockResolvedValue([provStock]);
			tx.vehicle_stock_item.findFirst.mockResolvedValue(null);
			tx.vehicle_stock_item.update.mockResolvedValue({});
			tx.stock_movement.updateMany.mockResolvedValue({ count: 0 });
			for (const table of LINKED_TABLES) tx[table].updateMany.mockResolvedValue({ count: 0 });
			tx.inventory_item.delete.mockResolvedValue({});

			const result = await mergeProvisionalItem(PROV_ID, VALID_BODY, ORG_ID);

			expect(result.err).toBeUndefined();
			// stock row re-pointed to target (no collision path)
			expect(tx.vehicle_stock_item.update).toHaveBeenCalledWith(expect.objectContaining({
				where: { id: "ps-1" },
				data: { inventory_item_id: TARGET_ID },
			}));
			// global ledger re-pointed
			expect(tx.stock_movement.updateMany).toHaveBeenCalledWith(expect.objectContaining({
				where: { inventory_item_id: PROV_ID },
				data: { inventory_item_id: TARGET_ID },
			}));
			expect(tx.job_visit_line_item.updateMany).toHaveBeenCalledWith(expect.objectContaining({
				where: { inventory_item_id: PROV_ID },
				data: { inventory_item_id: TARGET_ID },
			}));
			// provisional item deleted
			expect(tx.inventory_item.delete).toHaveBeenCalledWith({ where: { id: PROV_ID } });
		});

		// A forgotten table does not throw: the FK is ON DELETE SET NULL, so those
		// lines quietly lose their link and reappear in the unmapped backlog.
		it("repoints ALL five line-item tables before deleting the provisional item", async () => {
			const tx = makeTx();
			mockDb.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx));

			tx.inventory_item.findFirst
				.mockResolvedValueOnce({ id: PROV_ID, provisional: true })
				.mockResolvedValueOnce({ id: TARGET_ID, provisional: false });
			tx.vehicle_stock_item.findMany.mockResolvedValue([]);
			tx.stock_movement.updateMany.mockResolvedValue({ count: 0 });

			const deleteOrder: string[] = [];
			for (const table of LINKED_TABLES) {
				tx[table].updateMany.mockImplementation(async () => {
					deleteOrder.push(table);
					return { count: 1 };
				});
			}
			tx.inventory_item.delete.mockImplementation(async () => {
				deleteOrder.push("delete");
				return {};
			});

			const result = await mergeProvisionalItem(PROV_ID, VALID_BODY, ORG_ID);
			expect(result.err).toBeUndefined();

			for (const table of LINKED_TABLES) {
				expect(tx[table].updateMany).toHaveBeenCalledWith(
					expect.objectContaining({
						where: { inventory_item_id: PROV_ID },
						data: { inventory_item_id: TARGET_ID },
					}),
				);
			}

			// The delete has to come last, or the SET NULL beats the repoint.
			expect(deleteOrder[deleteOrder.length - 1]).toBe("delete");
			expect(deleteOrder.filter((t) => t !== "delete")).toHaveLength(LINKED_TABLES.length);
		});

		it("happy path — collision: merges qty and re-points usage/restock rows", async () => {
			const tx = makeTx();
			mockDb.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx));

			const provItem = { id: PROV_ID, provisional: true };
			const targetItem = { id: TARGET_ID, provisional: false };
			const provStock = { id: "ps-1", vehicle_id: "v-1", qty_on_hand: 5, inventory_item_id: PROV_ID };
			const existingStock = { id: "ts-1", vehicle_id: "v-1", qty_on_hand: 10, inventory_item_id: TARGET_ID };

			tx.inventory_item.findFirst
				.mockResolvedValueOnce(provItem)
				.mockResolvedValueOnce(targetItem);
			tx.vehicle_stock_item.findMany.mockResolvedValue([provStock]);
			tx.vehicle_stock_item.findFirst.mockResolvedValue(existingStock); // collision
			tx.vehicle_stock_item.update.mockResolvedValue({});
			tx.vehicle_stock_item.delete.mockResolvedValue({});
			tx.vehicle_stock_usage.updateMany.mockResolvedValue({ count: 1 });
			tx.vehicle_restock_request.updateMany.mockResolvedValue({ count: 0 });
			tx.stock_movement.updateMany.mockResolvedValue({ count: 0 });
			for (const table of LINKED_TABLES) tx[table].updateMany.mockResolvedValue({ count: 0 });
			tx.inventory_item.delete.mockResolvedValue({});

			const result = await mergeProvisionalItem(PROV_ID, VALID_BODY, ORG_ID);

			expect(result.err).toBeUndefined();
			// existing stock row qty incremented
			expect(tx.vehicle_stock_item.update).toHaveBeenCalledWith(expect.objectContaining({
				where: { id: "ts-1" },
				data: { qty_on_hand: { increment: 5 } },
			}));
			// usage and restock requests re-pointed to existing stock row
			expect(tx.vehicle_stock_usage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
				where: { stock_item_id: "ps-1" },
				data: { stock_item_id: "ts-1" },
			}));
			expect(tx.vehicle_restock_request.updateMany).toHaveBeenCalledWith(expect.objectContaining({
				where: { stock_item_id: "ps-1" },
				data: { stock_item_id: "ts-1" },
			}));
			// provisional stock row deleted (collision path)
			expect(tx.vehicle_stock_item.delete).toHaveBeenCalledWith({ where: { id: "ps-1" } });
		});

		it("returns error when target is same as source", async () => {
			const result = await mergeProvisionalItem(PROV_ID, { target_inventory_item_id: PROV_ID }, ORG_ID);
			expect(result.err).toBe("Target must be a different item");
			expect(mockDb.$transaction).not.toHaveBeenCalled();
		});

		it("returns error when provisional item not found", async () => {
			const tx = makeTx();
			mockDb.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx));

			tx.inventory_item.findFirst.mockResolvedValueOnce(null); // prov not found

			const result = await mergeProvisionalItem(PROV_ID, VALID_BODY, ORG_ID);
			expect(result.err).toBe("Provisional item not found");
		});

		it("returns error when target item not found or not approved", async () => {
			const tx = makeTx();
			mockDb.$transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb(tx));

			const provItem = { id: PROV_ID, provisional: true };
			tx.inventory_item.findFirst
				.mockResolvedValueOnce(provItem) // prov found
				.mockResolvedValueOnce(null);    // target not found

			const result = await mergeProvisionalItem(PROV_ID, VALID_BODY, ORG_ID);
			expect(result.err).toBe("Target item not found");
		});
	});

	// -------------------------------------------------------------------------
	// rejectProvisionalItem
	// -------------------------------------------------------------------------
	describe("rejectProvisionalItem", () => {
		it("happy path: marks item inactive and not provisional", async () => {
			mockDb.inventory_item.updateMany.mockResolvedValue({ count: 1 });
			const result = await rejectProvisionalItem("prov-1", "org-1", { dispatcherId: "d-1" });
			expect(result.err).toBeUndefined();
			expect(mockDb.inventory_item.updateMany).toHaveBeenCalledWith(expect.objectContaining({
				where: { id: "prov-1", organization_id: "org-1", provisional: true },
				data: expect.objectContaining({ provisional: false, is_active: false }),
			}));
		});

		it("returns error when provisional item not found", async () => {
			mockDb.inventory_item.updateMany.mockResolvedValue({ count: 0 });
			const result = await rejectProvisionalItem("missing", "org-1", {});
			expect(result.err).toBe("Provisional item not found");
		});
	});
});
