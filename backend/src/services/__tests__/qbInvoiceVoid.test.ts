import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb } = vi.hoisted(() => ({
	sdb: {
		invoice: {
			findFirst: vi.fn(),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		client_external_mapping: { upsert: vi.fn() },
	},
}));

// Module gating is not under test here: every module reads as on.
vi.mock("../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm1"),
	isQBConnected: vi.fn(async () => true),
}));
vi.mock("../qb/qbCustomers.js", () => ({ findOrCreateQBCustomer: vi.fn() }));
vi.mock("../qb/qbQuery.js", () => ({ qbQueryAll: vi.fn() }));
vi.mock("../appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { isQBConnected, qbFetch } from "../quickbooksService.js";
import { log } from "../appLogger.js";
import { mirrorInvoiceVoidToQuickBooks, pushInvoice } from "../qb/qbInvoices.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

// One QuickBooks behaviour for every void door (D3).
describe("mirrorInvoiceVoidToQuickBooks", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does nothing for an invoice QuickBooks never saw", async () => {
		await mirrorInvoiceVoidToQuickBooks("org1", "inv1", null);

		expect(isQBConnected).not.toHaveBeenCalled();
		expect(qbFetch).not.toHaveBeenCalled();
	});

	it("does nothing while the organization is disconnected", async () => {
		mockFn(isQBConnected).mockResolvedValueOnce(false);

		await mirrorInvoiceVoidToQuickBooks("org1", "inv1", "qb-77");

		expect(qbFetch).not.toHaveBeenCalled();
	});

	it("voids the QuickBooks copy when connected", async () => {
		mockFn(qbFetch)
			.mockResolvedValueOnce({ Invoice: { SyncToken: "3" } })
			.mockResolvedValueOnce({});

		await mirrorInvoiceVoidToQuickBooks("org1", "inv1", "qb-77");

		expect(qbFetch).toHaveBeenCalledWith("org1", "POST", "/invoice?operation=void", {
			SyncToken: "3",
			Id: "qb-77",
		});
	});

	// DW-55: the old catch swallowed the failure and then swallowed the attempt
	// to record it, leaving QuickBooks with a live invoice and no trace at all.
	it("logs and marks the invoice failed instead of swallowing the error", async () => {
		mockFn(qbFetch).mockRejectedValueOnce(new Error("token expired"));

		await expect(
			mirrorInvoiceVoidToQuickBooks("org1", "inv1", "qb-77"),
		).resolves.toBeUndefined();

		expect(log.error).toHaveBeenCalledWith(
			expect.objectContaining({ invoiceId: "inv1", orgId: "org1" }),
			"QuickBooks void failed",
		);
		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "failed" },
		});
	});

	it("logs when even the failure mark cannot be written", async () => {
		mockFn(qbFetch).mockRejectedValueOnce(new Error("token expired"));
		mockFn(sdb.invoice.updateMany).mockRejectedValueOnce(new Error("pool exhausted"));

		await mirrorInvoiceVoidToQuickBooks("org1", "inv1", "qb-77");

		expect(log.error).toHaveBeenCalledTimes(2);
	});
});

describe("pushInvoice", () => {
	beforeEach(() => vi.clearAllMocks());

	// Pushed as a document, a void invoice would create or reopen a live,
	// collectible one in QuickBooks.
	it("refuses a void invoice before reaching QuickBooks", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValueOnce({
			id: "inv1",
			status: "Void",
			client_id: "c1",
			client: { name: "Acme", contacts: [], client_external_mapping: [] },
			line_items: [],
		});

		await expect(pushInvoice("inv1", "org1")).rejects.toThrow(
			"A void invoice can't be pushed to QuickBooks.",
		);
		expect(qbFetch).not.toHaveBeenCalled();
	});
});
