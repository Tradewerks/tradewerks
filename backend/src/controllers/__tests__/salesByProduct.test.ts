import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = { $extends, $queryRaw: vi.fn() };
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({ db: mockDb }));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

import { getSalesByProduct } from "../reportsController.js";

const raw = mockDb.$queryRaw as ReturnType<typeof vi.fn>;
const rawSql = () => (raw.mock.calls[0][0] as string[]).join("");

const row = (o: Record<string, unknown>) => ({
	itemId: "i1",
	itemName: "Item",
	unitsSold: 1,
	invoiceCount: 1,
	grossRevenue: 0,
	discount: 0,
	cost: null,
	lastSold: new Date("2026-10-01"),
	...o,
});

beforeEach(() => vi.clearAllMocks());

describe("getSalesByProduct", () => {
	it("counts issued invoices only and prorates the invoice discount per line", async () => {
		raw.mockResolvedValueOnce([]);
		await getSalesByProduct(undefined, undefined, "org1");
		const sql = rawSql();
		expect(sql).toContain("i.status NOT IN ('Draft', 'Void')");
		expect(sql).toContain("ili.total / NULLIF(i.subtotal, 0) * COALESCE(i.discount_amount, 0)");
		expect(sql).toContain("JOIN inventory_item ii ON ii.id = ili.inventory_item_id");
	});

	it("computes net, profit and margin, null when cost is unknown; highest net first", async () => {
		raw.mockResolvedValueOnce([
			row({ itemId: "a", grossRevenue: 100, discount: 10, cost: 30 }),
			row({ itemId: "b", grossRevenue: 200, discount: 0, cost: null }),
			row({ itemId: "c", grossRevenue: 0, discount: 0, cost: 5 }),
		]);
		const { rows: res } = await getSalesByProduct(undefined, undefined, "org1");
		expect(res.map((r) => r.id)).toEqual(["b", "a", "c"]);
		expect(res[1]).toMatchObject({ netRevenue: 90, grossProfit: 60, marginPct: 66.67 });
		expect(res[0]).toMatchObject({ netRevenue: 200, grossProfit: null, marginPct: null });
		expect(res[2]).toMatchObject({ netRevenue: 0, grossProfit: -5, marginPct: null });
	});
});
