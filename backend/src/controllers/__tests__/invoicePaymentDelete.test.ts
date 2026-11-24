import { describe, it, expect, vi, beforeEach } from "vitest";

// Preamble shape copied from invoiceRefund.test.ts: one hoisted mock shared by
// the db.js and lib/context.js mocks, invoiceService left real so the lock and
// the paid aggregate run against these stubs.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: { findFirst: vi.fn(), update: vi.fn() },
		invoice_payment: {
			findFirst: vi.fn(),
			findMany: vi.fn(async () => []),
			aggregate: vi.fn(),
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

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { db } from "../../db.js";
import { deleteInvoicePayment } from "../invoicesController.js";

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
});
