import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn().mockResolvedValue("realm-1"),
}));

vi.mock("../qb/qbQuery.js", () => ({
	qbQueryAll: vi.fn(),
}));

vi.mock("../../db.js", () => {
	const tx = {
		inventory_item: { create: vi.fn() },
		item_external_mapping: { create: vi.fn().mockResolvedValue({}) },
	};
	const mockDb = {
		item_external_mapping: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn() },
		$transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
		$extends: vi.fn(),
		_tx: tx,
	};
	mockDb.$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../stockMovements.js", () => ({
	recordMovements: vi.fn().mockResolvedValue({ lowStockItemIds: [], gapItemIds: [], movementIds: [] }),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { importQBItem } from "../qb/qbItems.js";
import { qbFetch } from "../quickbooksService.js";
import { recordMovements } from "../stockMovements.js";
import { db } from "../../db.js";

const mockQbFetch = vi.mocked(qbFetch);
const mockRecordMovements = vi.mocked(recordMovements);
const mockDb = db as unknown as {
	_tx: { inventory_item: { create: ReturnType<typeof vi.fn> } };
};

function qbItem(overrides: Record<string, unknown> = {}) {
	return {
		Item: {
			Id: "qb-1",
			Name: "Refrigerant R-410A",
			Sku: "R410",
			UnitPrice: 40,
			PurchaseCost: 25,
			QtyOnHand: 12,
			...overrides,
		},
	};
}

describe("importQBItem — opening quantity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb._tx.inventory_item.create.mockResolvedValue({ id: "item-1", name: "Refrigerant R-410A" });
		mockRecordMovements.mockResolvedValue({ lowStockItemIds: [], gapItemIds: [], movementIds: [] });
	});

	it("routes the QBO QtyOnHand through recordMovements as an 'initial' movement with the purchase cost", async () => {
		mockQbFetch.mockResolvedValue(qbItem({ QtyOnHand: 12 }));

		const { item } = await importQBItem("org-1", "qb-1");

		expect(item.quantity).toBe(12);
		expect(mockRecordMovements).toHaveBeenCalledWith(
			expect.anything(),
			"org-1",
			{ actor_type: "system" },
			[
				expect.objectContaining({
					inventory_item_id: "item-1",
					qty: 12,
					from_location_type: "external",
					to_location_type: "warehouse",
					reason: "initial",
					unit_cost: 25,
				}),
			],
		);
	});

	// inventory_item.quantity is numeric(10,2): a fractional QBO balance is kept,
	// not floored, so a fractional QtyOnHand imports at full precision.
	it("keeps a fractional QtyOnHand at 2 dp instead of flooring it", async () => {
		mockQbFetch.mockResolvedValue(qbItem({ QtyOnHand: 12.5 }));

		const { item } = await importQBItem("org-1", "qb-1");

		expect(item.quantity).toBe(12.5);
		expect(mockRecordMovements.mock.calls[0][3][0].qty).toBe(12.5);
	});

	it("rounds QBO precision beyond 2 dp to what the ledger can store rather than failing the import", async () => {
		mockQbFetch.mockResolvedValue(qbItem({ QtyOnHand: 3.14159 }));

		const { item } = await importQBItem("org-1", "qb-1");

		expect(item.quantity).toBe(3.14);
		expect(mockRecordMovements.mock.calls[0][3][0].qty).toBe(3.14);
	});

	it("imports a negative or missing QBO balance as 0 with no opening movement", async () => {
		mockQbFetch.mockResolvedValue(qbItem({ QtyOnHand: -4 }));

		const { item } = await importQBItem("org-1", "qb-1");

		expect(item.quantity).toBe(0);
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});
});
