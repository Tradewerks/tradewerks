import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb } = vi.hoisted(() => ({
	sdb: {
		invoice: {
			findFirst: vi.fn(),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		invoice_payment: { findFirst: vi.fn() },
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
vi.mock("../qb/qbCustomers.js", () => ({ ensureQBCustomerForClient: vi.fn() }));
vi.mock("../qb/qbQuery.js", () => ({ qbQueryAll: vi.fn() }));
vi.mock("../qb/qbSyncLog.js", () => ({
	logExternalSync: vi.fn(async () => undefined),
	countPaymentPushHttpFailures: vi.fn(async () => 0),
}));
vi.mock("../appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../../controllers/notificationsController.js", () => ({
	notifyDispatchers: vi.fn(async () => []),
}));

import { mirrorInvoiceVoidToQuickBooks, pushInvoiceDetached } from "../qb/qbInvoices.js";
import { qbFetch } from "../quickbooksService.js";
import { pushPaymentDetached } from "../qb/qbPayments.js";
import { logExternalSync } from "../qb/qbSyncLog.js";
import { notifyDispatchers } from "../../controllers/notificationsController.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const voidInvoice = {
	id: "inv1",
	status: "Void",
	client_id: "c1",
	client: { name: "Acme", contacts: [], client_external_mapping: [] },
	line_items: [],
};

describe("QuickBooks push failure notifications", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(sdb.invoice.updateMany).mockResolvedValue({ count: 1 });
	});

	it("a failed detached invoice push marks failed and notifies once", async () => {
		mockFn(sdb.invoice.findFirst)
			.mockResolvedValueOnce(voidInvoice)
			.mockResolvedValueOnce({ invoice_number: "INV-1039" });

		pushInvoiceDetached("inv1", "org1");

		await vi.waitFor(() => expect(notifyDispatchers).toHaveBeenCalled());
		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "inv1", qb_sync_status: { not: "failed" } },
			data: { qb_sync_status: "failed" },
		});
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "qb_sync_failed",
				title: "QuickBooks sync failed for Invoice INV-1039",
				body: "Open the invoice and choose Retry sync.",
				actionUrl: "/dispatch/invoices/inv1",
			},
			"org1",
		);
	});

	it("a second failure on an already-failed invoice does not notify", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValueOnce(voidInvoice);
		mockFn(sdb.invoice.updateMany).mockResolvedValueOnce({ count: 0 });

		pushInvoiceDetached("inv1", "org1");

		await vi.waitFor(() => expect(sdb.invoice.updateMany).toHaveBeenCalled());
		await new Promise((r) => setTimeout(r, 0));
		expect(notifyDispatchers).not.toHaveBeenCalled();
	});

	it("a failed void mirror notifies with void_failed copy", async () => {
		mockFn(qbFetch).mockRejectedValueOnce(new Error("token expired"));
		mockFn(sdb.invoice.findFirst).mockResolvedValueOnce({ invoice_number: "INV-1039" });

		await mirrorInvoiceVoidToQuickBooks("org1", "inv1", "qb-77");

		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "inv1", qb_sync_status: { not: "failed" } },
			data: { qb_sync_status: "failed" },
		});
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "qb_sync_failed",
				title: "Invoice INV-1039 is void here but still open in QuickBooks",
				body: "Void the invoice in QuickBooks.",
				actionUrl: "/dispatch/invoices/inv1",
			},
			"org1",
		);
	});

	it("a failed payment push marks the parent invoice failed and notifies with payment_push_failed", async () => {
		// No payment row: the push itself throws.
		mockFn(sdb.invoice_payment.findFirst).mockResolvedValueOnce(null);
		mockFn(sdb.invoice.findFirst).mockResolvedValueOnce({ invoice_number: "INV-1039" });

		pushPaymentDetached("pay1", "inv1", "org1");

		await vi.waitFor(() => expect(notifyDispatchers).toHaveBeenCalled());
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({
				external_id: "pay1",
				entity_type: "payment",
				action: "push_failed",
			}),
		);
		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "inv1", qb_sync_status: { not: "failed" } },
			data: { qb_sync_status: "failed" },
		});
		expect(notifyDispatchers).toHaveBeenCalledTimes(1);
		expect(notifyDispatchers).toHaveBeenCalledWith(
			{
				type: "qb_sync_failed",
				title: "A payment on Invoice INV-1039 didn't reach QuickBooks",
				body: "Open the invoice and choose Retry sync.",
				actionUrl: "/dispatch/invoices/inv1",
			},
			"org1",
		);
	});
});
