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
import {
	mirrorInvoiceVoidToQuickBooks,
	pushInvoice,
	pushInvoiceDetached,
} from "../qb/qbInvoices.js";

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

// QuickBooks cannot void a CreditMemo, so the mirror deletes it, applying Payment first.
describe("mirrorInvoiceVoidToQuickBooks for a credit adjustment", () => {
	beforeEach(() => vi.clearAllMocks());

	const tokens: Record<string, unknown> = {
		"/payment/p-1": { Payment: { SyncToken: "2" } },
		"/creditmemo/cm-1": { CreditMemo: { SyncToken: "5" } },
	};

	it("voiding a pushed credit removes the applying payment, then deletes the credit memo", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string, path: string) =>
			method === "GET" ? tokens[path] : {},
		);

		await mirrorInvoiceVoidToQuickBooks("org1", "adj1", null, {
			id: "cm-1",
			appliedPaymentId: "p-1",
		});

		const posts = mockFn(qbFetch).mock.calls.filter((c) => c[1] === "POST");
		expect(posts).toEqual([
			["org1", "POST", "/payment?operation=delete", { Id: "p-1", SyncToken: "2" }],
			["org1", "POST", "/creditmemo?operation=delete", { Id: "cm-1", SyncToken: "5" }],
		]);
		expect(qbFetch).not.toHaveBeenCalledWith(
			"org1",
			"POST",
			expect.stringContaining("operation=void"),
			expect.anything(),
		);
		const updates = mockFn(sdb.invoice.updateMany).mock.calls;
		expect(updates[updates.length - 1][0]).toEqual({
			where: { id: "adj1" },
			data: {
				qb_credit_applied_payment_id: null,
				qb_credit_memo_id: null,
				qb_sync_status: "synced",
			},
		});
	});

	it("deletes only the credit memo when it was never applied", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string, path: string) =>
			method === "GET" ? tokens[path] : {},
		);

		await mirrorInvoiceVoidToQuickBooks("org1", "adj1", null, {
			id: "cm-1",
			appliedPaymentId: null,
		});

		const posts = mockFn(qbFetch).mock.calls.filter((c) => c[1] === "POST");
		expect(posts.map((c) => c[2])).toEqual(["/creditmemo?operation=delete"]);
	});

	it("a failed credit memo delete marks the adjustment failed", async () => {
		mockFn(qbFetch).mockImplementation(async (_o: string, method: string, path: string) => {
			if (method === "POST" && path.startsWith("/creditmemo")) throw new Error("QB 400");
			return method === "GET" ? tokens[path] : {};
		});

		await expect(
			mirrorInvoiceVoidToQuickBooks("org1", "adj1", null, { id: "cm-1", appliedPaymentId: "p-1" }),
		).resolves.toBeUndefined();

		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "adj1" },
			data: { qb_sync_status: "failed" },
		});
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

describe("pushInvoiceDetached", () => {
	beforeEach(() => vi.clearAllMocks());

	const voidInvoice = {
		id: "inv1",
		status: "Void",
		client_id: "c1",
		client: { name: "Acme", contacts: [], client_external_mapping: [] },
		line_items: [],
	};
	const settle = () => new Promise((r) => setTimeout(r, 0));

	it("does not push while the organization is disconnected", async () => {
		mockFn(isQBConnected).mockResolvedValueOnce(false);

		pushInvoiceDetached("inv1", "org1");
		await settle();

		expect(sdb.invoice.findFirst).not.toHaveBeenCalled();
		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
	});

	it("logs and marks the invoice failed when the push rejects", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValueOnce(voidInvoice);

		pushInvoiceDetached("inv1", "org1");
		await settle();

		expect(log.error).toHaveBeenCalledWith(
			expect.objectContaining({ invoiceId: "inv1", organizationId: "org1" }),
			"QuickBooks invoice push failed",
		);
		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "failed" },
		});
	});

	it("logs when even the failure mark cannot be written", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValueOnce(voidInvoice);
		mockFn(sdb.invoice.updateMany).mockRejectedValueOnce(new Error("pool exhausted"));

		pushInvoiceDetached("inv1", "org1");
		await settle();

		expect(log.error).toHaveBeenCalledTimes(2);
	});
});
