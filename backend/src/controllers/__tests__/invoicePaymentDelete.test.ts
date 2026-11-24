import { describe, it, expect, vi, beforeEach } from "vitest";

// Preamble shape copied from invoiceRefund.test.ts: one hoisted mock shared by
// the db.js and lib/context.js mocks, invoiceService left real so the lock and
// the paid aggregate run against these stubs.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: {
			findFirst: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(async () => ({ count: 1 })),
		},
		invoice_payment: {
			findFirst: vi.fn(),
			findMany: vi.fn(async () => []),
			aggregate: vi.fn(),
			count: vi.fn(async () => 0),
			delete: vi.fn(),
		},
		$queryRaw: vi.fn().mockResolvedValue([]),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../services/quickbooksService.js", () => ({
	isQBConnected: vi.fn(async () => false),
	getOrgRealmId: vi.fn(async () => null),
	qbFetch: vi.fn(),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/qb/qbPayments.js", () => ({
	pushPaymentToQB: vi.fn(),
	deleteQBPayment: vi.fn(),
}));

vi.mock("../../services/qb/qbSyncLog.js", () => ({
	logExternalSync: vi.fn(async () => undefined),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { db } from "../../db.js";
import { deleteInvoicePayment } from "../invoicesController.js";
import { getOrgRealmId, isQBConnected } from "../../services/quickbooksService.js";
import { deleteQBPayment } from "../../services/qb/qbPayments.js";
import { logExternalSync } from "../../services/qb/qbSyncLog.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

function anInvoice(overrides: Record<string, unknown> = {}) {
	return {
		id: "inv1",
		status: "PartiallyPaid",
		total: 500,
		amount_paid: 60,
		organization_id: "org1",
		invoice_number: "INV-1039",
		...overrides,
	};
}

function aPayment(amount: number, id = "pay1") {
	return {
		id,
		invoice_id: "inv1",
		amount,
		qb_payment_id: null,
		account_id: null,
	};
}

function paidSum(amount: number) {
	mockFn(db.invoice_payment.aggregate).mockResolvedValue({ _sum: { amount } });
}

describe("deleteInvoicePayment", () => {
	beforeEach(() => vi.clearAllMocks());

	it("locks the invoice before reading the payment", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ amount_paid: 100 }));
		mockFn(db.invoice_payment.findFirst).mockResolvedValue(aPayment(100));
		paidSum(100);

		await deleteInvoicePayment("inv1", "pay1", "org1", { dispatcherId: "d1" });

		const lockOrder = mockFn(db.$queryRaw).mock.invocationCallOrder[0];
		const readOrder = mockFn(db.invoice_payment.findFirst).mock.invocationCallOrder[0];
		expect(lockOrder).toBeDefined();
		expect(readOrder).toBeDefined();
		expect(lockOrder).toBeLessThan(readOrder);
		// The lock is the org-scoped one: raw SQL bypasses getScopedDb.
		const lockArgs = mockFn(db.$queryRaw).mock.calls[0];
		expect(lockArgs.slice(1)).toEqual(["inv1", "org1"]);
	});

	it("refuses to delete a 100 payment when a 40 refund stands", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice());
		mockFn(db.invoice_payment.findFirst).mockResolvedValue(aPayment(100));
		// Rows: +100, -40.
		paidSum(60);

		const result = await deleteInvoicePayment("inv1", "pay1", "org1", {
			dispatcherId: "d1",
		});

		expect(result.err).toBe(
			"This payment has refunds recorded against it. Delete the refund first.",
		);
		expect(db.invoice_payment.delete).not.toHaveBeenCalled();
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("allows deleting the refund row itself", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice());
		mockFn(db.invoice_payment.findFirst).mockResolvedValue(aPayment(-40, "ref1"));
		// Rows: +100, -40; removing the -40 leaves 100.
		paidSum(60);

		const result = await deleteInvoicePayment("inv1", "ref1", "org1", {
			dispatcherId: "d1",
		});

		expect(result.err).toBe("");
		expect(db.invoice_payment.delete).toHaveBeenCalledWith({ where: { id: "ref1" } });
	});

	it("allows deleting a payment when the remaining rows still sum to zero or more", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice());
		mockFn(db.invoice_payment.findFirst).mockResolvedValue(aPayment(50, "pay2"));
		// Rows: +100, +50, -40 = 110; removing the 50 leaves 60.
		paidSum(110);

		const partial = await deleteInvoicePayment("inv1", "pay2", "org1", {
			dispatcherId: "d1",
		});
		expect(partial.err).toBe("");
		expect(db.invoice_payment.delete).toHaveBeenCalledWith({ where: { id: "pay2" } });

		vi.clearAllMocks();
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ amount_paid: 100 }));
		mockFn(db.invoice_payment.findFirst).mockResolvedValue(aPayment(100));
		// The only row; removing it lands exactly on zero.
		paidSum(100);

		const toZero = await deleteInvoicePayment("inv1", "pay1", "org1", {
			dispatcherId: "d1",
		});
		expect(toZero.err).toBe("");
		expect(db.invoice_payment.delete).toHaveBeenCalledWith({ where: { id: "pay1" } });
	});

	it("refuses on a Void invoice, read under the lock", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ status: "Void" }));
		mockFn(db.invoice_payment.findFirst).mockResolvedValue(aPayment(100));
		paidSum(100);

		const result = await deleteInvoicePayment("inv1", "pay1", "org1", {
			dispatcherId: "d1",
		});

		expect(result.err).toBe("Cannot modify payments on a void invoice");
		expect(db.invoice_payment.delete).not.toHaveBeenCalled();
		const lockOrder = mockFn(db.$queryRaw).mock.invocationCallOrder[0];
		const invoiceRead = mockFn(db.invoice.findFirst).mock.invocationCallOrder[0];
		expect(lockOrder).toBeDefined();
		expect(lockOrder).toBeLessThan(invoiceRead);
	});
	it("refuses to delete one leg of a QuickBooks payment split across invoices", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ amount_paid: 100 }));
		mockFn(db.invoice_payment.findFirst).mockResolvedValue({
			...aPayment(100),
			qb_payment_id: "qb-7",
			account_id: "realm1",
		});
		paidSum(100);
		mockFn(db.invoice_payment.count).mockResolvedValue(1);

		const result = await deleteInvoicePayment("inv1", "pay1", "org1", {
			dispatcherId: "d1",
		});

		expect(result).toEqual({
			err: "This payment is split across several invoices in QuickBooks. Change it in QuickBooks.",
			status: 409,
			code: "QB_SPLIT_PAYMENT",
		});
		expect(db.invoice_payment.count).toHaveBeenCalledWith({
			where: { qb_payment_id: "qb-7", account_id: "realm1", id: { not: "pay1" } },
		});
		const lockOrder = mockFn(db.$queryRaw).mock.invocationCallOrder[0];
		const siblingRead = mockFn(db.invoice_payment.count).mock.invocationCallOrder[0];
		expect(lockOrder).toBeLessThan(siblingRead);
		expect(db.invoice_payment.delete).not.toHaveBeenCalled();
		expect(db.invoice.update).not.toHaveBeenCalled();
		expect(isQBConnected).not.toHaveBeenCalled();
	});

	it("still deletes a payment whose QuickBooks payment covers only this invoice", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(anInvoice({ amount_paid: 100 }));
		mockFn(db.invoice_payment.findFirst).mockResolvedValue({
			...aPayment(100),
			qb_payment_id: "qb-8",
			account_id: "realm1",
		});
		paidSum(100);
		mockFn(db.invoice_payment.count).mockResolvedValue(0);
		mockFn(getOrgRealmId).mockResolvedValue("realm1");

		const result = await deleteInvoicePayment("inv1", "pay1", "org1", {
			dispatcherId: "d1",
		});

		expect(result.err).toBe("");
		expect(db.invoice_payment.delete).toHaveBeenCalledWith({ where: { id: "pay1" } });
		// Reached the QuickBooks mirror step, unchanged for a single-invoice payment.
		expect(isQBConnected).toHaveBeenCalledWith("org1");
	});

	it("a failed QB payment delete marks the invoice diverged with qb_payment_delete_failed", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(
			anInvoice({ amount_paid: 100, qb_invoice_id: "158", account_id: "realm1" }),
		);
		mockFn(db.invoice_payment.findFirst).mockResolvedValue({
			...aPayment(100),
			qb_payment_id: "qb-9",
			account_id: "realm1",
		});
		paidSum(100);
		mockFn(db.invoice_payment.count).mockResolvedValue(0);
		mockFn(getOrgRealmId).mockResolvedValue("realm1");
		mockFn(isQBConnected).mockResolvedValueOnce(true);
		mockFn(deleteQBPayment).mockRejectedValueOnce(new Error("QuickBooks 500"));

		const result = await deleteInvoicePayment("inv1", "pay1", "org1", {
			dispatcherId: "d1",
		});

		expect(result.err).toBe("");
		// The QuickBooks mirror runs detached from the response.
		await vi.waitFor(() =>
			expect(db.invoice.updateMany).toHaveBeenCalledWith({
				where: expect.objectContaining({ id: "inv1", qb_diverged_at: null }),
				data: {
					qb_diverged_at: expect.any(Date),
					qb_diverged_reason: "qb_payment_delete_failed",
				},
			}),
		);
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "delete_failed", external_id: "qb-9" }),
		);
	});
});
