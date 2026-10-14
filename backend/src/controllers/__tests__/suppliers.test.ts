import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	listSuppliers,
	createSupplier,
	updateSupplier,
	mergeSuppliers,
	getSupplierDetail,
	getSupplierMovements,
	getSupplierBatches,
} from "../suppliersController.js";
import {
	normalizeSupplierName,
	collapseWhitespace,
	resolveSupplier,
	SupplierValidationError,
	SUPPLIER_NAME_MAX,
} from "../../services/suppliers.js";
import { db } from "../../db.js";

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		supplier: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
		},
		stock_movement: { updateMany: vi.fn(), findMany: vi.fn() },
		stock_batch: { updateMany: vi.fn(), findMany: vi.fn() },
		supplier_item: {
			findMany: vi.fn(),
			updateMany: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
		},
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => db),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({ name: { old: "a", new: "b" } }),
}));

const mockDb = vi.mocked(db) as unknown as {
	supplier: {
		findFirst: ReturnType<typeof vi.fn>;
		findMany: ReturnType<typeof vi.fn>;
		create: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
	};
	stock_movement: { updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
	stock_batch: { updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
	supplier_item: {
		findMany: ReturnType<typeof vi.fn>;
		updateMany: ReturnType<typeof vi.fn>;
		update: ReturnType<typeof vi.fn>;
		delete: ReturnType<typeof vi.fn>;
	};
	$transaction: ReturnType<typeof vi.fn>;
};

const ORG = "org-1";
const OTHER_ORG = "org-2";

function supplier(over: Record<string, unknown> = {}) {
	return {
		id: "sup-1",
		name: "Ferguson",
		account_number: null,
		contact_name: null,
		phone: null,
		email: null,
		notes: null,
		is_active: true,
		created_at: new Date("2026-01-01T00:00:00.000Z"),
		updated_at: new Date("2026-01-01T00:00:00.000Z"),
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	// Runs the callback against the same mock client — the merge is one
	// transaction, and the assertions care about what it issued inside it.
	mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(mockDb));
	// No price-list rows on either side by default; merge tests that care about
	// the conflict-repoint path override this explicitly.
	mockDb.supplier_item.findMany.mockResolvedValue([]);
	mockDb.supplier_item.updateMany.mockResolvedValue({ count: 0 });
});

describe("supplier name normalization", () => {
	it("collapses whitespace and lowercases for the dedupe key", () => {
		expect(collapseWhitespace("  Ferguson   Supply ")).toBe("Ferguson Supply");
		expect(normalizeSupplierName("  Ferguson   Supply ")).toBe("ferguson supply");
		expect(normalizeSupplierName("FERGUSON supply")).toBe("ferguson supply");
	});

	it("never folds distinct names together", () => {
		// "Ferguson" and "Ferguson Plumbing" are two vendors with two account
		// numbers. Fuzzy matching here would merge years of history by accident.
		expect(normalizeSupplierName("Ferguson")).not.toBe(
			normalizeSupplierName("Ferguson Plumbing"),
		);
	});
});

describe("resolveSupplier", () => {
	it("adopts an existing vendor by id, scoped to the org", async () => {
		mockDb.supplier.findFirst.mockResolvedValue({ id: "sup-1", name: "Ferguson" });

		const result = await resolveSupplier(mockDb as never, ORG, { supplier_id: "sup-1" });

		expect(result).toEqual({ id: "sup-1", name: "Ferguson" });
		expect(mockDb.supplier.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "sup-1", organization_id: ORG } }),
		);
		expect(mockDb.supplier.create).not.toHaveBeenCalled();
	});

	it("rejects an id belonging to another org", async () => {
		// The org filter above means a foreign id simply isn't found.
		mockDb.supplier.findFirst.mockResolvedValue(null);

		await expect(
			resolveSupplier(mockDb as never, ORG, { supplier_id: "sup-other" }),
		).rejects.toBeInstanceOf(SupplierValidationError);
	});

	it("adopts by normalized name before creating", async () => {
		mockDb.supplier.findFirst.mockResolvedValue({ id: "sup-1", name: "Ferguson Supply" });

		const result = await resolveSupplier(mockDb as never, ORG, {
			supplier_name: "  ferguson   supply ",
		});

		expect(result).toEqual({ id: "sup-1", name: "Ferguson Supply" });
		expect(mockDb.supplier.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { organization_id: ORG, name_key: "ferguson supply" },
			}),
		);
		expect(mockDb.supplier.create).not.toHaveBeenCalled();
	});

	it("creates on write when the name is new, storing the collapsed spelling", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(null);
		mockDb.supplier.create.mockResolvedValue({ id: "sup-new", name: "Grainger Co" });

		const result = await resolveSupplier(mockDb as never, ORG, {
			supplier_name: " Grainger   Co ",
		});

		expect(result).toEqual({ id: "sup-new", name: "Grainger Co" });
		expect(mockDb.supplier.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					organization_id: ORG,
					name: "Grainger Co",
					name_key: "grainger co",
				}),
			}),
		);
	});

	it("returns null for a blank or absent capture", async () => {
		// Optional everywhere — a receipt with no vendor is unattributed, not invalid.
		expect(await resolveSupplier(mockDb as never, ORG, null)).toBeNull();
		expect(await resolveSupplier(mockDb as never, ORG, { supplier_name: "   " })).toBeNull();
		expect(mockDb.supplier.create).not.toHaveBeenCalled();
	});

	it("rejects a name past the column cap", async () => {
		await expect(
			resolveSupplier(mockDb as never, ORG, {
				supplier_name: "x".repeat(SUPPLIER_NAME_MAX + 1),
			}),
		).rejects.toBeInstanceOf(SupplierValidationError);
	});
});

describe("createSupplier", () => {
	it("returns the existing row on a name collision instead of a bare error", async () => {
		const existing = supplier({ name: "Ferguson Supply" });
		mockDb.supplier.findFirst.mockResolvedValue(existing);

		const result = await createSupplier({ name: "ferguson   supply" }, ORG);

		// The picker adopts this rather than making the user retype a spelling
		// the org already has.
		expect(result.conflict).toBe(true);
		expect(result.supplier).toBe(existing);
		expect(result.err).toContain("Ferguson Supply");
		expect(mockDb.supplier.create).not.toHaveBeenCalled();
	});

	it("stores the collapsed name alongside its key", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(null);
		mockDb.supplier.create.mockResolvedValue(supplier({ name: "Ferguson Supply" }));

		await createSupplier({ name: "  Ferguson   Supply  " }, ORG);

		expect(mockDb.supplier.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					name: "Ferguson Supply",
					name_key: "ferguson supply",
					organization_id: ORG,
				}),
			}),
		);
	});

	it("rejects a blank name", async () => {
		const result = await createSupplier({ name: "   " }, ORG);
		expect(result.err).toBeTruthy();
		expect(mockDb.supplier.create).not.toHaveBeenCalled();
	});
});

describe("updateSupplier", () => {
	it("re-keys on rename", async () => {
		mockDb.supplier.findFirst
			.mockResolvedValueOnce(supplier())
			// No other vendor owns the new name.
			.mockResolvedValueOnce(null);
		mockDb.supplier.update.mockResolvedValue(supplier({ name: "Ferguson Supply" }));

		await updateSupplier("sup-1", { name: "Ferguson  Supply" }, ORG);

		expect(mockDb.supplier.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					name: "Ferguson Supply",
					name_key: "ferguson supply",
				}),
			}),
		);
	});

	it("refuses a rename onto another vendor's name and names the holder", async () => {
		const duplicate = supplier({ id: "sup-2", name: "Grainger" });
		mockDb.supplier.findFirst
			.mockResolvedValueOnce(supplier())
			.mockResolvedValueOnce(duplicate);

		const result = await updateSupplier("sup-1", { name: "grainger" }, ORG);

		expect(result.conflict).toBe(true);
		expect(result.supplier).toBe(duplicate);
		expect(mockDb.supplier.update).not.toHaveBeenCalled();
	});

	it("404s for a supplier outside the org", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(null);
		const result = await updateSupplier("sup-1", { name: "Ferguson" }, OTHER_ORG);
		expect(result.err).toContain("not found");
	});
});

describe("mergeSuppliers", () => {
	it("repoints movements AND lots, then deactivates the source", async () => {
		const source = supplier({ id: "sup-1", name: "Fergsuon" });
		const target = supplier({ id: "sup-2", name: "Ferguson" });
		mockDb.supplier.findFirst.mockResolvedValueOnce(source).mockResolvedValueOnce(target);
		mockDb.stock_movement.updateMany.mockResolvedValue({ count: 14 });
		mockDb.stock_batch.updateMany.mockResolvedValue({ count: 3 });
		mockDb.supplier.update.mockResolvedValue(supplier({ is_active: false }));

		const result = await mergeSuppliers("sup-1", { target_id: "sup-2" }, ORG);

		expect(result.err).toBe("");
		expect(result.moved).toEqual({ movements: 14, batches: 3, supplierItems: 0 });
		// Both tables — a merge that only moved movements would leave lots
		// pointing at a vendor the user just retired.
		expect(mockDb.stock_movement.updateMany).toHaveBeenCalledWith({
			where: { organization_id: ORG, supplier_id: "sup-1" },
			data: { supplier_id: "sup-2" },
		});
		expect(mockDb.stock_batch.updateMany).toHaveBeenCalledWith({
			where: { organization_id: ORG, supplier_id: "sup-1" },
			data: { supplier_id: "sup-2" },
		});
		// Deactivated, never deleted — the audit log still has to resolve it.
		expect(mockDb.supplier.update).toHaveBeenCalledWith({
			where: { id: "sup-1" },
			data: { is_active: false },
		});
	});

	it("repoints the source's price-list rows that don't collide with the target's", async () => {
		const source = supplier({ id: "sup-1", name: "Fergsuon" });
		const target = supplier({ id: "sup-2", name: "Ferguson" });
		mockDb.supplier.findFirst.mockResolvedValueOnce(source).mockResolvedValueOnce(target);
		mockDb.stock_movement.updateMany.mockResolvedValue({ count: 0 });
		mockDb.stock_batch.updateMany.mockResolvedValue({ count: 0 });
		mockDb.supplier_item.findMany
			.mockResolvedValueOnce([{ id: "si-1", inventory_item_id: "item-1", is_preferred: false }])
			.mockResolvedValueOnce([]); // target has no price-list rows yet
		mockDb.supplier_item.updateMany.mockResolvedValue({ count: 1 });
		mockDb.supplier.update.mockResolvedValue(supplier({ is_active: false }));

		const result = await mergeSuppliers("sup-1", { target_id: "sup-2" }, ORG);

		expect(result.err).toBe("");
		expect(result.moved.supplierItems).toBe(1);
		expect(mockDb.supplier_item.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ supplier_id: "sup-1" }),
				data: { supplier_id: "sup-2" },
			}),
		);
		// No collision, so nothing to fold or delete.
		expect(mockDb.supplier_item.delete).not.toHaveBeenCalled();
	});

	it("folds a colliding price-list row into the target's instead of orphaning it", async () => {
		const source = supplier({ id: "sup-1", name: "Fergsuon" });
		const target = supplier({ id: "sup-2", name: "Ferguson" });
		mockDb.supplier.findFirst.mockResolvedValueOnce(source).mockResolvedValueOnce(target);
		mockDb.stock_movement.updateMany.mockResolvedValue({ count: 0 });
		mockDb.stock_batch.updateMany.mockResolvedValue({ count: 0 });
		// Both the source and the target already quote the same item — the
		// source's row is the preferred one, the target's isn't.
		mockDb.supplier_item.findMany
			.mockResolvedValueOnce([{ id: "si-source", inventory_item_id: "item-1", is_preferred: true }])
			.mockResolvedValueOnce([{ id: "si-target", inventory_item_id: "item-1", is_preferred: false }]);
		mockDb.supplier_item.updateMany.mockResolvedValue({ count: 0 });
		mockDb.supplier.update.mockResolvedValue(supplier({ is_active: false }));

		const result = await mergeSuppliers("sup-1", { target_id: "sup-2" }, ORG);

		expect(result.err).toBe("");
		// The "who's preferred" bit carries over onto the target's row...
		expect(mockDb.supplier_item.update).toHaveBeenCalledWith({
			where: { id: "si-target" },
			data: { is_preferred: true },
		});
		// ...and the now-redundant source row is dropped rather than left
		// pointing at a deactivated supplier where the forecast can't see it.
		expect(mockDb.supplier_item.delete).toHaveBeenCalledWith({ where: { id: "si-source" } });
	});

	it("refuses to merge a supplier into itself", async () => {
		const result = await mergeSuppliers("sup-1", { target_id: "sup-1" }, ORG);
		expect(result.err).toContain("itself");
		expect(mockDb.stock_movement.updateMany).not.toHaveBeenCalled();
	});

	it("refuses a target in another org", async () => {
		mockDb.supplier.findFirst
			.mockResolvedValueOnce(supplier({ id: "sup-1" }))
			// The scoped lookup finds nothing for a foreign target.
			.mockResolvedValueOnce(null);

		const result = await mergeSuppliers("sup-1", { target_id: "sup-other" }, ORG);

		expect(result.err).toContain("not found");
		expect(mockDb.stock_movement.updateMany).not.toHaveBeenCalled();
	});

	it("refuses to merge into a deactivated target", async () => {
		mockDb.supplier.findFirst
			.mockResolvedValueOnce(supplier({ id: "sup-1" }))
			.mockResolvedValueOnce(supplier({ id: "sup-2", is_active: false }));

		const result = await mergeSuppliers("sup-1", { target_id: "sup-2" }, ORG);

		expect(result.err).toContain("deactivated");
		expect(mockDb.stock_movement.updateMany).not.toHaveBeenCalled();
	});
});

describe("listSuppliers", () => {
	it("hides deactivated vendors by default and scopes to the org", async () => {
		mockDb.supplier.findMany.mockResolvedValue([supplier()]);

		await listSuppliers(ORG, {});

		expect(mockDb.supplier.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ organization_id: ORG, is_active: true }),
			}),
		);
	});

	it("drops the active filter for active=all", async () => {
		mockDb.supplier.findMany.mockResolvedValue([]);

		await listSuppliers(ORG, { active: "all" });

		const { where } = mockDb.supplier.findMany.mock.calls[0][0];
		expect(where.is_active).toBeUndefined();
	});

	it("only counts usage when asked", async () => {
		mockDb.supplier.findMany.mockResolvedValue([]);

		await listSuppliers(ORG, { include_usage: "true" });
		expect(mockDb.supplier.findMany.mock.calls[0][0].select._count).toBeDefined();

		await listSuppliers(ORG, {});
		expect(mockDb.supplier.findMany.mock.calls[1][0].select._count).toBeUndefined();
	});
});

describe("getSupplierDetail", () => {
	it("404s when the supplier belongs to another org", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(null);

		const result = await getSupplierDetail("sup-1", ORG);

		expect(result.err).toBe("Supplier not found");
		expect(mockDb.supplier.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "sup-1", organization_id: ORG } }),
		);
	});

	it("always carries usage counts, unlike the list", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(supplier());

		await getSupplierDetail("sup-1", ORG);

		expect(mockDb.supplier.findFirst.mock.calls[0][0].select._count).toEqual(
			expect.objectContaining({ select: { movements: true, batches: true } }),
		);
	});
});

describe("getSupplierMovements", () => {
	it("404s when the supplier belongs to another org", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(null);

		const result = await getSupplierMovements("sup-1", ORG);

		expect(result.err).toBe("Supplier not found");
		expect(mockDb.stock_movement.findMany).not.toHaveBeenCalled();
	});

	it("scopes the ledger to this supplier and org, cursor-paginated newest first", async () => {
		mockDb.supplier.findFirst.mockResolvedValue({ id: "sup-1" });
		mockDb.stock_movement.findMany.mockResolvedValue([]);

		await getSupplierMovements("sup-1", ORG, "cursor-1", 10);

		expect(mockDb.stock_movement.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { supplier_id: "sup-1", organization_id: ORG },
				orderBy: [{ created_at: "desc" }, { id: "desc" }],
				take: 11,
				cursor: { id: "cursor-1" },
				skip: 1,
			}),
		);
	});

	it("signals a next page only once more rows exist than the page size", async () => {
		mockDb.supplier.findFirst.mockResolvedValue({ id: "sup-1" });
		const rows = Array.from({ length: 3 }, (_, i) => ({ id: `m-${i}` }));
		mockDb.stock_movement.findMany.mockResolvedValue(rows);

		const result = await getSupplierMovements("sup-1", ORG, undefined, 2);

		expect(result.movements).toHaveLength(2);
		expect(result.nextCursor).toBe("m-1");
	});
});

describe("getSupplierBatches", () => {
	it("404s when the supplier belongs to another org", async () => {
		mockDb.supplier.findFirst.mockResolvedValue(null);

		const result = await getSupplierBatches("sup-1", ORG);

		expect(result.err).toBe("Supplier not found");
		expect(mockDb.stock_batch.findMany).not.toHaveBeenCalled();
	});

	it("names the item each lot belongs to and normalizes decimals to numbers", async () => {
		mockDb.supplier.findFirst.mockResolvedValue({ id: "sup-1" });
		mockDb.stock_batch.findMany.mockResolvedValue([
			{
				id: "batch-1",
				inventory_item_id: "item-1",
				inventory_item: { id: "item-1", name: "Compressor", sku: "CMP-1" },
				batch_number: "B-004",
				received_at: new Date("2026-08-01T00:00:00.000Z"),
				expires_at: null,
				recalled_at: null,
				qty_received: "12.5" as unknown as number,
				qty_in_warehouse: "5" as unknown as number,
				unit_cost: null,
			},
		]);

		const result = await getSupplierBatches("sup-1", ORG);

		expect(result.batches![0]).toMatchObject({
			item_name: "Compressor",
			batch_number: "B-004",
			qty_received: 12.5,
			qty_in_warehouse: 5,
		});
	});
});
