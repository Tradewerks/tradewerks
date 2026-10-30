import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb, db } = vi.hoisted(() => ({
	sdb: {
		invoice: { findMany: vi.fn(async () => []) },
		purchase: { findMany: vi.fn(async () => []) },
		field_purchase: { findMany: vi.fn(async () => []) },
		invoice_payment: { findFirst: vi.fn() },
	},
	db: { invoice_payment: { findMany: vi.fn(async () => []) } },
}));

vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../db.js", () => ({ db }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm2"),
	isQBConnected: vi.fn(async () => true),
}));
vi.mock("../qb/qbInvoices.js", () => ({ pushInvoice: vi.fn() }));
vi.mock("../qb/qbPurchases.js", () => ({ pushPurchase: vi.fn(), pushFieldPurchase: vi.fn() }));
vi.mock("../qb/qbSyncLog.js", () => ({ logExternalSync: vi.fn() }));

import { listUnsynced } from "../qb/qbUnsynced.js";
import { pushPaymentToQB } from "../qb/qbPayments.js";
import { pushInvoice } from "../qb/qbInvoices.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const staleBranch = {
	qb_sync_status: { in: ["synced", "tax_mismatch"] },
	account_id: { not: "realm2" },
};

// Synced to a previously connected company is unsynced in the current one.
describe("listUnsynced stale company", () => {
	beforeEach(() => vi.clearAllMocks());

	it("includes records synced to another company, shown as not synced", async () => {
		mockFn(sdb.invoice.findMany).mockResolvedValueOnce([
			{ id: "i1", invoice_number: "INV-1", qb_sync_status: "synced", updated_at: new Date() },
		]);

		const rows = await listUnsynced("org1");

		expect(mockFn(sdb.invoice.findMany).mock.calls[0][0].where.OR).toContainEqual(staleBranch);
		expect(mockFn(sdb.field_purchase.findMany).mock.calls[0][0].where.OR).toContainEqual(staleBranch);
		// purchase keeps its own status OR alongside the stale one
		const pWhere = mockFn(sdb.purchase.findMany).mock.calls[0][0].where;
		expect(pWhere.AND[0].OR).toContainEqual(staleBranch);
		expect(pWhere.AND[1].OR).toHaveLength(2);
		expect(mockFn(db.invoice_payment.findMany).mock.calls[0][0].where.OR).toContainEqual({
			account_id: { not: "realm2" },
		});
		expect(rows[0]).toMatchObject({ id: "i1", status: "not_synced" });
	});
});

describe("pushPaymentToQB stale company", () => {
	beforeEach(() => vi.clearAllMocks());

	it("re-pushes a payment whose QB id belongs to another company", async () => {
		const payment = {
			id: "p1",
			qb_payment_id: "old-9",
			account_id: "realm1",
			amount: 10,
			paid_at: new Date(),
			invoice: { id: "inv1", qb_invoice_id: null, account_id: "", client: { client_external_mapping: [] } },
		};
		mockFn(sdb.invoice_payment.findFirst).mockResolvedValueOnce(payment).mockResolvedValueOnce(payment);

		await expect(pushPaymentToQB("p1", "org1")).rejects.toThrow("Customer not found in QuickBooks");

		expect(pushInvoice).toHaveBeenCalledWith("inv1", "org1");
		// re-fetch is by id only: a never-pushed payment has no account_id yet
		expect(mockFn(sdb.invoice_payment.findFirst).mock.calls[1][0].where).toEqual({ id: "p1" });
	});
});
