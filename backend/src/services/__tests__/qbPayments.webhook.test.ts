const { sdb } = vi.hoisted(() => ({
	sdb: {
		invoice_payment: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
		invoice: { findFirst: vi.fn() },
		$transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sdb)),
	},
}));

vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../quickbooksService.js", () => ({ qbFetch: vi.fn(), getOrgRealmId: vi.fn() }));
vi.mock("../qb/qbInvoices.js", () => ({ pushInvoice: vi.fn() }));
vi.mock("../invoiceService.js", () => ({ syncInvoicePaymentTotals: vi.fn() }));
vi.mock("../qb/qbSyncLog.js", () => ({ logExternalSync: vi.fn() }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleInboundPaymentEvent } from "../qb/qbPayments.js";
import { qbFetch } from "../quickbooksService.js";
import { logExternalSync } from "../qb/qbSyncLog.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("handleInboundPaymentEvent create", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sdb.invoice_payment.findFirst.mockResolvedValue(null);
		sdb.invoice.findFirst.mockResolvedValue({ id: "inv1" });
	});

	it("skips a QuickBooks payment that applies a credit memo", async () => {
		mockFn(qbFetch).mockResolvedValue({
			Payment: {
				Id: "p-1",
				TotalAmt: 0,
				TxnDate: "2026-10-21",
				Line: [
					{ Amount: 17.93, LinkedTxn: [{ TxnId: "158", TxnType: "Invoice" }] },
					{ Amount: 17.93, LinkedTxn: [{ TxnId: "cm-1", TxnType: "CreditMemo" }] },
				],
			},
		});

		await handleInboundPaymentEvent("org1", "realm1", "p-1", "Create");

		expect(sdb.invoice_payment.create).not.toHaveBeenCalled();
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "webhook_skipped_credit_application" }),
		);
	});

	it("records the cash of a payment that also applies a credit memo", async () => {
		mockFn(qbFetch).mockResolvedValue({
			Payment: {
				Id: "p-4",
				TotalAmt: 50,
				TxnDate: "2026-10-21",
				Line: [
					{ Amount: 60, LinkedTxn: [{ TxnId: "158", TxnType: "Invoice" }] },
					{ Amount: 10, LinkedTxn: [{ TxnId: "cm-1", TxnType: "CreditMemo" }] },
				],
			},
		});

		await handleInboundPaymentEvent("org1", "realm1", "p-4", "Create");

		expect(sdb.invoice_payment.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ amount: 50, invoice_id: "inv1" }),
		});
	});

	it("skips a $0 payment even without a credit memo line", async () => {
		mockFn(qbFetch).mockResolvedValue({
			Payment: {
				Id: "p-2",
				TotalAmt: 0,
				TxnDate: "2026-10-21",
				Line: [{ Amount: 0, LinkedTxn: [{ TxnId: "158", TxnType: "Invoice" }] }],
			},
		});

		await handleInboundPaymentEvent("org1", "realm1", "p-2", "Create");

		expect(sdb.invoice_payment.create).not.toHaveBeenCalled();
	});

	it("still records an ordinary payment", async () => {
		mockFn(qbFetch).mockResolvedValue({
			Payment: {
				Id: "p-3",
				TotalAmt: 25,
				TxnDate: "2026-10-21",
				Line: [{ Amount: 25, LinkedTxn: [{ TxnId: "158", TxnType: "Invoice" }] }],
			},
		});

		await handleInboundPaymentEvent("org1", "realm1", "p-3", "Create");

		expect(sdb.invoice_payment.create).toHaveBeenCalledTimes(1);
	});
});
