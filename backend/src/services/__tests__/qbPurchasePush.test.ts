import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb } = vi.hoisted(() => ({
	sdb: { purchase: { findFirst: vi.fn(), update: vi.fn(async () => ({})) } },
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	qbFetchBinary: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm2"),
}));
vi.mock("../qb/qbQuery.js", () => ({ qbQueryAll: vi.fn(), getAccountId: vi.fn(async () => "acct") }));
vi.mock("../qb/qbVendors.js", () => ({ pushVendor: vi.fn(async () => "vendor1") }));
vi.mock("../qb/qbItems.js", () => ({ pushItem: vi.fn(async () => "item1") }));
vi.mock("../qb/qbCustomers.js", () => ({ findOrCreateQBCustomer: vi.fn() }));

import { qbFetch } from "../quickbooksService.js";
import { pushPurchase } from "../qb/qbPurchases.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const purchase = (over: Record<string, unknown>) => ({
	id: "p1",
	kind: "purchase",
	supplier_id: "s1",
	submitted_at: new Date(),
	tax_amount: 0,
	purchased_at: null,
	created_at: new Date("2026-10-01"),
	qb_purchase_id: null,
	account_id: null,
	lines: [{ inventory_item_id: null, description: "Filters", line_total: 40, quantity: 2, unit_price: 20 }],
	...over,
});

describe("pushPurchase, closed purchases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Drops queued Once values a failed test left behind.
		mockFn(qbFetch).mockReset();
		sdb.purchase.findFirst.mockReset();
	});

	it.each(["received", "cancelled"])("creates a never-pushed %s purchase already Closed", async (status) => {
		sdb.purchase.findFirst.mockResolvedValueOnce(purchase({ status }));
		mockFn(qbFetch).mockResolvedValueOnce({ PurchaseOrder: { Id: "qb9" } });

		await expect(pushPurchase("p1", "org1")).resolves.toBe("qb9");

		const [, method, path, body] = mockFn(qbFetch).mock.calls[0];
		expect([method, path]).toEqual(["POST", "/purchaseorder"]);
		expect(body).toMatchObject({ POStatus: "Closed", VendorRef: { value: "vendor1" } });
		expect(sdb.purchase.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ qb_purchase_id: "qb9", qb_sync_status: "synced" }) }),
		);
	});

	it("closes one already in this company with a sparse update", async () => {
		sdb.purchase.findFirst.mockResolvedValueOnce(
			purchase({ status: "received", qb_purchase_id: "qb5", account_id: "realm2" }),
		);
		mockFn(qbFetch)
			.mockResolvedValueOnce({ PurchaseOrder: { SyncToken: "3" } })
			.mockResolvedValueOnce({});

		await expect(pushPurchase("p1", "org1")).resolves.toBe("qb5");

		expect(mockFn(qbFetch).mock.calls[1][3]).toEqual({
			sparse: true,
			Id: "qb5",
			SyncToken: "3",
			POStatus: "Closed",
		});
	});

	it("leaves an open purchase open when creating it", async () => {
		sdb.purchase.findFirst.mockResolvedValueOnce(purchase({ status: "ordered" }));
		mockFn(qbFetch).mockResolvedValueOnce({ PurchaseOrder: { Id: "qb7" } });

		await pushPurchase("p1", "org1");

		expect(mockFn(qbFetch).mock.calls[0][3]).not.toHaveProperty("POStatus");
	});
});
