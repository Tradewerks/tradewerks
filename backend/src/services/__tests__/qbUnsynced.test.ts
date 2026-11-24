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
// The client has no QB mapping, so the push reaches the resolver; stopping there ends the test.
vi.mock("../qb/qbCustomers.js", () => ({
	ensureQBCustomerForClient: vi.fn(async () => {
		throw new Error("customer resolution reached");
	}),
}));

import { listUnsynced, syncUnsynced } from "../qb/qbUnsynced.js";
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

		expect(mockFn(sdb.invoice.findMany).mock.calls[0][0].where.OR[0].AND[0].OR).toContainEqual(
			staleBranch,
		);
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
			invoice: { id: "inv1", qb_invoice_id: null, account_id: "", client: { id: "c1", name: "Acme", client_external_mapping: [] } },
		};
		mockFn(sdb.invoice_payment.findFirst).mockResolvedValueOnce(payment).mockResolvedValueOnce(payment);

		await expect(pushPaymentToQB("p1", "org1")).rejects.toThrow("customer resolution reached");

		expect(pushInvoice).toHaveBeenCalledWith("inv1", "org1");
		// re-fetch is by id only: a never-pushed payment has no account_id yet
		expect(mockFn(sdb.invoice_payment.findFirst).mock.calls[1][0].where).toEqual({ id: "p1" });
	});
});

// A re-push cannot fix a refund QuickBooks never saw, so a diverged invoice is
// listed for a person to reconcile but never pushed by Sync all.
describe("listUnsynced diverged invoices", () => {
	beforeEach(() => vi.clearAllMocks());

	it("listUnsynced includes a diverged invoice even when qb_sync_status is synced", async () => {
		mockFn(sdb.invoice.findMany).mockResolvedValueOnce([
			{
				id: "i2",
				invoice_number: "INV-2",
				qb_sync_status: "synced",
				account_id: "realm2",
				qb_diverged_at: new Date(),
				updated_at: new Date(),
			},
		]);

		const rows = await listUnsynced("org1");

		expect(mockFn(sdb.invoice.findMany).mock.calls[0][0].where.OR).toContainEqual({
			qb_diverged_at: { not: null },
			account_id: "realm2",
		});
		expect(rows).toEqual([expect.objectContaining({ id: "i2", status: "diverged" })]);
	});

	// A void that never reached QuickBooks is a divergence; Retry cannot push a
	// void, so only the stale/unsynced branch leaves Void invoices out.
	it("lists a diverged Void invoice but still hides a stale or unsynced Void one", async () => {
		await listUnsynced("org1");

		const where = mockFn(sdb.invoice.findMany).mock.calls[0][0].where;
		expect(where.status).toBeUndefined();
		expect(where.OR).toContainEqual({
			AND: [{ OR: expect.arrayContaining([staleBranch]) }, { status: { not: "Void" } }],
		});
		expect(where.OR).toContainEqual({
			qb_diverged_at: { not: null },
			account_id: "realm2",
		});
	});

	it("syncUnsynced never pushes a diverged Void invoice, even one marked failed earlier", async () => {
		mockFn(sdb.invoice.findMany).mockResolvedValueOnce([
			{
				id: "i3",
				invoice_number: "INV-3",
				status: "Void",
				qb_sync_status: "failed",
				account_id: "realm2",
				qb_diverged_at: new Date(),
				updated_at: new Date(),
			},
		]);

		const result = await syncUnsynced("org1");

		expect(pushInvoice).not.toHaveBeenCalled();
		expect(result).toEqual({ synced: 0, failed: [] });
	});

	it("syncUnsynced does not re-push a diverged invoice", async () => {
		mockFn(sdb.invoice.findMany).mockResolvedValueOnce([
			{
				id: "i2",
				invoice_number: "INV-2",
				qb_sync_status: "synced",
				account_id: "realm2",
				qb_diverged_at: new Date(),
				updated_at: new Date(),
			},
		]);

		const result = await syncUnsynced("org1");

		expect(pushInvoice).not.toHaveBeenCalled();
		expect(result).toEqual({ synced: 0, failed: [] });
	});
});
