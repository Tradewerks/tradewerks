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

import { getPurchasesBySupplierReport } from "../reportsController.js";

const raw = mockDb.$queryRaw as ReturnType<typeof vi.fn>;
const rawSql = () => (raw.mock.calls[0][0] as string[]).join("");

const row = (o: Record<string, unknown>) => ({
	id: "p1",
	number: null,
	source: "field",
	kind: "purchase",
	status: "approved",
	supplier_id: null,
	supplier_name: null,
	vendor_name: null,
	tech_name: null,
	date: new Date("2026-10-01"),
	subtotal: 0,
	tax: 0,
	...o,
});

beforeEach(() => vi.clearAllMocks());

describe("getPurchasesBySupplierReport", () => {
	it("unions counted orders and approved field purchases with refunds negated", async () => {
		raw.mockResolvedValueOnce([]);
		await getPurchasesBySupplierReport(undefined, undefined, "org1");
		const sql = rawSql();
		expect(sql).toContain("UNION ALL");
		expect(sql).toContain("po.status IN ('ordered', 'partially_received', 'received')");
		expect(sql).toContain("fp.status = 'approved'");
		expect(sql).toContain("CASE WHEN po.kind = 'refund' THEN -1");
		expect(sql).toContain("CASE WHEN fp.kind = 'refund' THEN -1");
		expect(sql).toContain("po.kind::text");
		expect(sql).toContain("fp.kind::text");
	});

	it("groups by supplier, then vendor name case-insensitively, then unknown; highest spend first", async () => {
		raw.mockResolvedValueOnce([
			row({ id: "f1", supplier_id: "s1", supplier_name: "Ferguson", source: "order", subtotal: 100.1, tax: 5 }),
			row({ id: "f2", supplier_id: "s1", supplier_name: "Ferguson", subtotal: 50.2, tax: 2, date: new Date("2026-10-20") }),
			row({ id: "m1", vendor_name: " Menards ", subtotal: 80 }),
			row({ id: "m2", vendor_name: "menards", kind: "refund", subtotal: -24.5, tax: -1 }),
			row({ id: "u1", subtotal: 10 }),
		]);

		const [first, second, third] = await getPurchasesBySupplierReport(undefined, undefined, "org1");

		expect(first).toMatchObject({
			supplierKey: "s1",
			supplierName: "Ferguson",
			purchaseCount: 2,
			subtotal: 150.3,
			tax: 7,
			orderSpend: 100.1,
			fieldSpend: 50.2,
			lastPurchaseAt: new Date("2026-10-20"),
		});
		expect(second).toMatchObject({
			supplierKey: "v:menards",
			supplierId: null,
			supplierName: "Menards",
			purchaseCount: 2,
			refundCount: 1,
			subtotal: 55.5,
		});
		expect(third).toMatchObject({ supplierKey: "unknown", supplierName: "Unknown vendor", subtotal: 10 });
	});
});
