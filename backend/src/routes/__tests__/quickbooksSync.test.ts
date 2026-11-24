import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));

vi.mock("../../lib/entitlements/requireModule.js", () => ({
	requireModule: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/requirePermissions.js", async (importActual) => ({
	...(await importActual<typeof import("../../lib/requirePermissions.js")>()),
	requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../services/qb/qbInvoices.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/qb/qbInvoices.js")>()),
	pushInvoice: vi.fn(),
	sendQbInvoiceEmail: vi.fn(),
}));

vi.mock("../../services/qb/qbPayments.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/qb/qbPayments.js")>()),
	pushPaymentToQB: vi.fn(),
}));

vi.mock("../../services/quickbooksService.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/quickbooksService.js")>()),
	getOrgRealmId: vi.fn(async () => "realm1"),
}));

import quickbooksRouter from "../quickbooks.js";
import { callRoute } from "./harness.js";
import { db } from "../../db.js";
import { pushInvoice, sendQbInvoiceEmail } from "../../services/qb/qbInvoices.js";
import { pushPaymentToQB } from "../../services/qb/qbPayments.js";
import { getScopedDb } from "../../lib/context.js";

const mockPush = vi.mocked(pushInvoice);
const scopedUpdateMany = vi.fn();
const scopedPaymentFindMany = vi.fn();
const sync = () =>
	callRoute(quickbooksRouter, "post", "/invoices/:id/sync", { params: { id: "inv1" } });

describe("POST /quickbooks/invoices/:id/sync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		scopedUpdateMany.mockResolvedValue({ count: 1 });
		scopedPaymentFindMany.mockResolvedValue([]);
		vi.mocked(getScopedDb).mockReturnValue({
			invoice: { updateMany: scopedUpdateMany },
			invoice_payment: { findMany: scopedPaymentFindMany },
		} as never);
	});

	it("manual invoice sync also pushes that invoice's unsynced positive payments, payments after the invoice", async () => {
		mockPush.mockResolvedValueOnce({} as never);
		scopedPaymentFindMany.mockResolvedValueOnce([{ id: "pay1" }, { id: "pay2" }]);
		const events: string[] = [];
		vi.mocked(pushPaymentToQB).mockImplementation(async (id: string) => {
			events.push(`start ${id}`);
			await new Promise((r) => setTimeout(r, 0));
			events.push(`end ${id}`);
		});

		const { status, body } = await sync();

		expect(status).toBe(200);
		expect(body.data).toEqual({ synced: true });
		// Refunds are negative rows and never pushed; a payment already in this
		// company is skipped.
		expect(scopedPaymentFindMany).toHaveBeenCalledWith({
			where: {
				invoice_id: "inv1",
				amount: { gt: 0 },
				OR: [{ qb_payment_id: null }, { account_id: { not: "realm1" } }],
			},
			orderBy: { paid_at: "asc" },
			select: { id: true },
		});
		expect(vi.mocked(pushPaymentToQB).mock.calls).toEqual([
			["pay1", "org-1"],
			["pay2", "org-1"],
		]);
		const invoiceOrder = mockPush.mock.invocationCallOrder[0];
		const paymentOrders = vi.mocked(pushPaymentToQB).mock.invocationCallOrder;
		expect(paymentOrders.every((o) => o > invoiceOrder)).toBe(true);
		// Sequential: QuickBooks rate-limits parallel writes.
		expect(events).toEqual(["start pay1", "end pay1", "start pay2", "end pay2"]);
	});

	it("a failed payment push during manual sync leaves the invoice failed and answers like a failed push", async () => {
		mockPush.mockResolvedValueOnce({} as never);
		scopedPaymentFindMany.mockResolvedValueOnce([{ id: "pay1" }, { id: "pay2" }]);
		vi.mocked(pushPaymentToQB).mockRejectedValueOnce(
			new Error(
				'QB POST /payment → 400: {"Fault":{"Error":[{"Detail":"Business Validation Error: Y","code":"6000"}]}}',
			),
		);

		const { status, body } = await sync();

		expect(status).toBe(502);
		expect(body.error.code).toBe("QB_SYNC_FAILED");
		expect(body.error.message).toBe("QuickBooks rejected this document: Business Validation Error: Y");
		expect(scopedUpdateMany).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "failed" },
		});
		// Stops at the first failure; the rest wait for the next Retry sync.
		expect(vi.mocked(pushPaymentToQB).mock.calls).toEqual([["pay1", "org-1"]]);
	});

	it("answers a QuickBooks validation fault with its message, not a 500", async () => {
		mockPush.mockRejectedValueOnce(
			new Error(
				'QB POST /invoice → 400: {"Fault":{"Error":[{"Detail":"Business Validation Error: X","code":"6000"}]}}',
			),
		);

		const { status, body } = await sync();

		expect(status).toBe(502);
		expect(body.error.code).toBe("QB_SYNC_FAILED");
		expect(body.error.message).toBe("QuickBooks rejected this document: Business Validation Error: X");
		expect(getScopedDb).toHaveBeenCalledWith("org-1");
		expect(scopedUpdateMany).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "failed" },
		});
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("passes an error with no QuickBooks fault on to the generic handler", async () => {
		const boom = new Error("socket hang up");
		mockPush.mockRejectedValueOnce(boom);

		const result = await callRoute(quickbooksRouter, "post", "/invoices/:id/sync", {
			params: { id: "inv1" },
		}).catch((e) => e);

		expect(result).toBe(boom);
		expect(getScopedDb).toHaveBeenCalledWith("org-1");
		expect(scopedUpdateMany).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "failed" },
		});
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("reports success when the push lands", async () => {
		mockPush.mockResolvedValueOnce({} as never);

		const { status, body } = await sync();

		expect(status).toBe(200);
		expect(body.data).toEqual({ synced: true });
	});
});

describe("POST /quickbooks/invoices/:id/email", () => {
	it('returns 400 VALIDATION_ERROR for "not-an-email" and does not call the sender', async () => {
		const { status, body } = await callRoute(quickbooksRouter, "post", "/invoices/:id/email", {
			params: { id: "inv1" },
			body: { sendTo: "not-an-email" },
		});

		expect(status).toBe(400);
		expect(body.error.code).toBe("VALIDATION_ERROR");
		expect(sendQbInvoiceEmail).not.toHaveBeenCalled();
	});
});
