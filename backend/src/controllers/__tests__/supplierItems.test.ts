import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	listSupplierItems,
	upsertSupplierItem,
	updateSupplierItem,
	setPreferredSupplierItem,
	deleteSupplierItem,
} from "../supplierItemsController.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		supplier_item: {
			findMany: vi.fn(),
			findFirst: vi.fn(),
			findUnique: vi.fn(),
			upsert: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
			delete: vi.fn(),
		},
		supplier: { findFirst: vi.fn() },
		inventory_item: { findFirst: vi.fn() },
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => db) }));
vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

const mockDb = vi.mocked(db) as unknown as {
	supplier_item: Record<string, ReturnType<typeof vi.fn>>;
	supplier: { findFirst: ReturnType<typeof vi.fn> };
	inventory_item: { findFirst: ReturnType<typeof vi.fn> };
	$transaction: ReturnType<typeof vi.fn>;
};

const ORG = "org-1";
const OTHER_ORG = "org-2";

function supplierItem(over: Record<string, unknown> = {}) {
	return {
		id: "si-1",
		supplier_id: "sup-1",
		inventory_item_id: "item-1",
		vendor_sku: "FRG-88213",
		contract_price: 560,
		last_price: 572.15,
		last_purchased_at: new Date("2026-08-02T00:00:00.000Z"),
		is_preferred: false,
		lead_time_days: 3,
		min_order_qty: 4,
		notes: null,
		created_at: new Date("2026-01-01T00:00:00.000Z"),
		updated_at: new Date("2026-08-02T00:00:00.000Z"),
		supplier: { id: "sup-1", name: "Ferguson", is_active: true },
		inventory_item: { id: "item-1", name: "Compressor", sku: "CMP-1", unit: "each" },
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockDb));
	mockDb.supplier.findFirst.mockResolvedValue({ id: "sup-1", name: "Ferguson" });
	mockDb.inventory_item.findFirst.mockResolvedValue({ id: "item-1", name: "Compressor" });
	mockDb.supplier_item.updateMany.mockResolvedValue({ count: 0 });
});

describe("listSupplierItems", () => {
	it("scopes to the org and orders preferred first, then most recently bought", async () => {
		mockDb.supplier_item.findMany.mockResolvedValue([supplierItem()]);

		await listSupplierItems(ORG, {
			inventory_item_id: "22222222-2222-4222-8222-222222222222",
		});

		expect(mockDb.supplier_item.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					organization_id: ORG,
					inventory_item_id: "22222222-2222-4222-8222-222222222222",
				}),
				orderBy: [
					{ is_preferred: "desc" },
					{ last_purchased_at: { sort: "desc", nulls: "last" } },
				],
			}),
		);
	});

	it("rejects a non-uuid filter instead of silently listing everything", async () => {
		const result = await listSupplierItems(ORG, { inventory_item_id: "not-a-uuid" });
		expect(result.err).toBeTruthy();
		expect(mockDb.supplier_item.findMany).not.toHaveBeenCalled();
	});
});

describe("upsertSupplierItem", () => {
	const input = {
		supplier_id: "11111111-1111-4111-8111-111111111111",
		inventory_item_id: "22222222-2222-4222-8222-222222222222",
		vendor_sku: "FRG-88213",
		contract_price: 560,
	};

	it("upserts on the (vendor, item) pair rather than creating a second row", async () => {
		mockDb.supplier_item.upsert.mockResolvedValue(supplierItem());

		const result = await upsertSupplierItem(input, ORG);

		expect(result.err).toBe("");
		expect(mockDb.supplier_item.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					supplier_id_inventory_item_id: {
						supplier_id: input.supplier_id,
						inventory_item_id: input.inventory_item_id,
					},
				},
			}),
		);
	});

	it("clears any other preferred vendor for that item, inside the transaction", async () => {
		// The pair already exists (an update-to-preferred, not a first-time create):
		// findUnique resolves it BEFORE the upsert, so the other-preferred clear can
		// exclude this row's id without racing the partial unique index.
		mockDb.supplier_item.findUnique.mockResolvedValue({ id: "si-1" });
		mockDb.supplier_item.upsert.mockResolvedValue(supplierItem({ is_preferred: true }));

		await upsertSupplierItem({ ...input, is_preferred: true }, ORG);

		// Two preferred vendors would leave the forecast choosing arbitrarily.
		expect(mockDb.supplier_item.updateMany).toHaveBeenCalledWith({
			where: {
				organization_id: ORG,
				inventory_item_id: input.inventory_item_id,
				is_preferred: true,
				id: { not: "si-1" },
			},
			data: { is_preferred: false },
		});
	});

	it("leaves other rows alone when preference wasn't claimed", async () => {
		mockDb.supplier_item.upsert.mockResolvedValue(supplierItem());
		await upsertSupplierItem(input, ORG);
		expect(mockDb.supplier_item.updateMany).not.toHaveBeenCalled();
	});

	it("never writes last_price, even if the caller sends one", async () => {
		mockDb.supplier_item.upsert.mockResolvedValue(supplierItem());

		await upsertSupplierItem({ ...input, last_price: 1 } as never, ORG);

		const call = mockDb.supplier_item.upsert.mock.calls[0][0];
		// An observation from the ledger, not an opinion — the schema strips it.
		expect(call.create.last_price).toBeUndefined();
		expect(call.update.last_price).toBeUndefined();
	});

	it("404s for a supplier in another org", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(null);
		const result = await upsertSupplierItem(input, OTHER_ORG);
		expect(result.err).toContain("Supplier not found");
		expect(mockDb.supplier_item.upsert).not.toHaveBeenCalled();
	});

	it("404s for an item in another org", async () => {
		mockDb.inventory_item.findFirst.mockResolvedValue(null);
		const result = await upsertSupplierItem(input, OTHER_ORG);
		expect(result.err).toContain("Inventory item not found");
		expect(mockDb.supplier_item.upsert).not.toHaveBeenCalled();
	});
});

describe("setPreferredSupplierItem", () => {
	it("clears the previous preferred, then marks this one", async () => {
		mockDb.supplier_item.findFirst.mockResolvedValue({
			id: "si-2",
			inventory_item_id: "item-1",
		});
		mockDb.supplier_item.update.mockResolvedValue(
			supplierItem({ id: "si-2", is_preferred: true }),
		);

		const result = await setPreferredSupplierItem("si-2", ORG);

		expect(result.err).toBe("");
		expect(mockDb.supplier_item.updateMany).toHaveBeenCalledWith({
			where: {
				organization_id: ORG,
				inventory_item_id: "item-1",
				is_preferred: true,
				id: { not: "si-2" },
			},
			data: { is_preferred: false },
		});
		expect(mockDb.supplier_item.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: { is_preferred: true } }),
		);
	});

	it("404s outside the org", async () => {
		mockDb.supplier_item.findFirst.mockResolvedValue(null);
		const result = await setPreferredSupplierItem("si-2", OTHER_ORG);
		expect(result.err).toContain("not found");
		expect(mockDb.supplier_item.update).not.toHaveBeenCalled();
	});
});

describe("updateSupplierItem", () => {
	it("404s outside the org before touching the row", async () => {
		mockDb.supplier_item.findFirst.mockResolvedValue(null);
		const result = await updateSupplierItem("si-1", { contract_price: 500 }, OTHER_ORG);
		expect(result.err).toContain("not found");
		expect(mockDb.supplier_item.update).not.toHaveBeenCalled();
	});

	it("rejects a negative price", async () => {
		mockDb.supplier_item.findFirst.mockResolvedValue({
			id: "si-1",
			inventory_item_id: "item-1",
		});
		const result = await updateSupplierItem("si-1", { contract_price: -5 }, ORG);
		expect(result.err).toBeTruthy();
		expect(mockDb.supplier_item.update).not.toHaveBeenCalled();
	});
});

describe("deleteSupplierItem", () => {
	it("hard-deletes the quote — the purchases behind it live in the ledger", async () => {
		mockDb.supplier_item.findFirst.mockResolvedValue({ id: "si-1" });
		mockDb.supplier_item.delete.mockResolvedValue(supplierItem());

		const result = await deleteSupplierItem("si-1", ORG);

		expect(result.err).toBe("");
		expect(mockDb.supplier_item.delete).toHaveBeenCalledWith({ where: { id: "si-1" } });
	});

	it("404s outside the org", async () => {
		mockDb.supplier_item.findFirst.mockResolvedValue(null);
		const result = await deleteSupplierItem("si-1", OTHER_ORG);
		expect(result.err).toContain("not found");
		expect(mockDb.supplier_item.delete).not.toHaveBeenCalled();
	});
});
