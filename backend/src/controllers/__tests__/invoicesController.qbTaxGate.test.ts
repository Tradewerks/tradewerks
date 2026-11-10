import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, confirmQuickBooksTax } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn() },
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb, confirmQuickBooksTax: vi.fn() };
});

vi.mock("../../db.js", () => ({ db: mockDb }));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../services/invoiceService.js", () => ({
	syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
	syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
	lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue([]),
	invoicePaidTotal: vi.fn().mockResolvedValue(0),
	createInvoiceRecord: vi.fn().mockResolvedValue(undefined),
	recomputeInvoiceTotals: vi.fn().mockResolvedValue(undefined),
	invoiceInclude: {},
}));

vi.mock("../../services/qb/qbInvoices.js", () => ({
	mirrorInvoiceVoidToQuickBooks: vi.fn().mockResolvedValue(undefined),
	pushInvoiceDetached: vi.fn(),
}));

vi.mock("../../services/qb/qbAstAuthority.js", () => ({ confirmQuickBooksTax }));

vi.mock("../../services/quickbooksService.js", () => ({
	isQBConnected: vi.fn().mockResolvedValue(false),
	getOrgRealmId: vi.fn(),
}));

vi.mock("../../services/disputeService.js", () => ({
	openDisputeStatusChangeRefusal: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
	getEffectiveTaxMode: vi.fn(async () => "auto"),
}));

import type { Request } from "express";
import { isQbTaxReviewRefusal, updateInvoice } from "../invoicesController.js";
import { lockInvoiceTaxSnapshot } from "../../services/invoiceService.js";
import { getEffectiveTaxMode } from "../../services/tax/taxMode.js";

const patch = (
	body: object,
	options: { qbTaxConfirmed?: boolean; canAckQbTaxReview?: boolean } = { canAckQbTaxReview: true },
) =>
	updateInvoice(
		{ params: { id: "inv1" }, body } as unknown as Request,
		"org1",
		{ dispatcherId: "d1" },
		options,
	);

const draft = (status = "Draft") => ({
	id: "inv1",
	status,
	invoice_number: "INV-1001",
	amount_paid: 0,
	line_items: [],
	// Read by the kept-rate check (holdsKeptRate) on a manual-mode save that sends totals.
	jobs: [],
	client: { address: null, coords: null },
	tax_snapshot: { locked_at: status === "Draft" ? "draft" : "2026-10-01T00:00:00.000Z" },
});

describe("updateInvoice QuickBooks AST finalize gate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.invoice.findFirst.mockResolvedValue(draft());
		mockDb.invoice.update.mockResolvedValue({ id: "inv1" });
		confirmQuickBooksTax.mockResolvedValue({ status: "skipped" });
	});

	it("refuses an unacknowledged QuickBooks delta without writing anything", async () => {
		confirmQuickBooksTax.mockResolvedValue({
			status: "needs_ack",
			qbTaxCents: 812,
			oursCents: 750,
			reason: "QuickBooks calculated $8.12 (you estimated $7.50)",
		});

		const result = await patch({ status: "Issued" });

		expect(confirmQuickBooksTax).toHaveBeenCalledWith("inv1", "org1");
		expect(isQbTaxReviewRefusal(result)).toBe(true);
		expect(result).toEqual({
			err: "QuickBooks calculated $8.12 (you estimated $7.50). Acknowledge the tax review to continue.",
			code: "QB_TAX_REVIEW",
			details: {
				qb_tax_cents: 812,
				ours_cents: 750,
				reason: "QuickBooks calculated $8.12 (you estimated $7.50)",
			},
		});
		expect(mockDb.$transaction).not.toHaveBeenCalled();
		expect(mockDb.invoice.update).not.toHaveBeenCalled();
		expect(lockInvoiceTaxSnapshot).not.toHaveBeenCalled();
	});

	it.each(["adopted", "unavailable", "skipped"])(
		"finalizes when the confirm is %s",
		async (status) => {
			confirmQuickBooksTax.mockResolvedValue({ status });

			const result = await patch({ status: "Issued" });

			expect(confirmQuickBooksTax).toHaveBeenCalledTimes(1);
			expect(result.err).toBe("");
			expect(isQbTaxReviewRefusal(result)).toBe(false);
			expect(lockInvoiceTaxSnapshot).toHaveBeenCalled();
		},
	);

	it("confirms before the update transaction opens", async () => {
		const order: string[] = [];
		confirmQuickBooksTax.mockImplementation(async () => {
			order.push("confirm");
			return { status: "adopted" };
		});
		mockDb.$transaction.mockImplementationOnce(async (fn: (tx: unknown) => unknown) => {
			order.push("tx");
			return fn(mockDb);
		});

		await patch({ status: "Sent" });

		expect(order).toEqual(["confirm", "tx"]);
	});

	it("does not confirm a non-finalizing edit", async () => {
		const result = await patch({ memo: "Gate code 1234" });

		expect(confirmQuickBooksTax).not.toHaveBeenCalled();
		expect(result.err).toBe("");
	});

	it("does not confirm a move between finalized statuses", async () => {
		mockDb.invoice.findFirst.mockResolvedValue(draft("Issued"));

		await patch({ status: "Sent" });

		expect(confirmQuickBooksTax).not.toHaveBeenCalled();
	});

	it("does not confirm twice when the caller already ran the gate", async () => {
		const result = await patch({ status: "Sent" }, { qbTaxConfirmed: true });

		expect(confirmQuickBooksTax).not.toHaveBeenCalled();
		expect(result.err).toBe("");
	});

	it("lets a user who cannot acknowledge finalize on QuickBooks' figure, review left open", async () => {
		confirmQuickBooksTax.mockResolvedValue({
			status: "needs_ack",
			qbTaxCents: 812,
			oursCents: 750,
			reason: "QuickBooks calculated $8.12 (you estimated $7.50)",
		});

		const result = await patch({ status: "Issued" }, { canAckQbTaxReview: false });

		expect(confirmQuickBooksTax).toHaveBeenCalledWith("inv1", "org1");
		expect(isQbTaxReviewRefusal(result)).toBe(false);
		expect(result.err).toBe("");
		expect(lockInvoiceTaxSnapshot).toHaveBeenCalled();
		// Nothing in the finalize path clears the review the confirm left on the draft.
		for (const [arg] of mockDb.invoice.update.mock.calls) {
			expect(arg.data).not.toHaveProperty("tax_needs_review");
			expect(arg.data).not.toHaveProperty("tax_review_ack_at");
		}
	});

	it("treats a caller that says nothing about its permissions as unable to acknowledge", async () => {
		confirmQuickBooksTax.mockResolvedValue({ status: "needs_ack", qbTaxCents: 812, oursCents: 750 });

		const result = await patch({ status: "Issued" }, {});

		expect(isQbTaxReviewRefusal(result)).toBe(false);
		expect(confirmQuickBooksTax).toHaveBeenCalledTimes(1);
	});
});

describe("updateInvoice manual-mode client totals vs an adopted QuickBooks figure", () => {
	const clientTotals = { subtotal: 100, tax_amount: 7.5, total: 107.5, memo: "Gate code 1234" };

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getEffectiveTaxMode).mockResolvedValue("manual");
		mockDb.invoice.update.mockResolvedValue({ id: "inv1" });
	});

	const finalWrite = () =>
		mockDb.invoice.update.mock.calls.find(([arg]) => "memo" in arg.data)![0].data;

	it("keeps QuickBooks' adopted totals over the client's estimate", async () => {
		mockDb.invoice.findFirst.mockResolvedValue({
			...draft(),
			tax_snapshot: { locked_at: "draft", source: "qb_ast", qb_tax_cents: 812 },
		});

		const result = await patch(clientTotals);

		expect(result.err).toBe("");
		const data = finalWrite();
		expect(data.memo).toBe("Gate code 1234");
		for (const k of ["subtotal", "tax_amount", "total", "balance_due"]) {
			expect(data).not.toHaveProperty(k);
		}
	});

	it("still writes the client's totals when nothing was adopted", async () => {
		mockDb.invoice.findFirst.mockResolvedValue(draft());

		await patch(clientTotals);

		expect(finalWrite()).toMatchObject({ subtotal: 100, tax_amount: 7.5, total: 107.5 });
	});
});

describe("updateInvoice auto-mode finalize", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.invoice.findFirst.mockResolvedValue(draft());
		mockDb.invoice.update.mockResolvedValue({ id: "inv1" });
		confirmQuickBooksTax.mockResolvedValue({ status: "skipped" });
		vi.mocked(getEffectiveTaxMode).mockResolvedValue("auto");
	});

	it("finalizes after the QuickBooks confirm, with no taxability gate", async () => {
		const result = await patch({ status: "Issued" });

		expect(result.err).toBe("");
		expect(confirmQuickBooksTax).toHaveBeenCalledWith("inv1", "org1");
		expect(lockInvoiceTaxSnapshot).toHaveBeenCalled();
	});

	it("does not confirm twice when the send route already ran the gates", async () => {
		await patch({ status: "Sent" }, { qbTaxConfirmed: true });
		expect(confirmQuickBooksTax).not.toHaveBeenCalled();
	});

	it("refuses line edits and finalize in one auto-mode request", async () => {
		const result = await patch({
			status: "Issued",
			line_items: [{ name: "New", quantity: 1, unit_price: 10 }],
		});

		expect(result).toEqual({ err: "Save changes before finalizing." });
		expect(confirmQuickBooksTax).not.toHaveBeenCalled();
		expect(mockDb.invoice.update).not.toHaveBeenCalled();
	});
});

describe("updateInvoice QuickBooks $0 block", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockDb.invoice.findFirst.mockResolvedValue(draft());
		mockDb.invoice.update.mockResolvedValue({ id: "inv1" });
		vi.mocked(getEffectiveTaxMode).mockResolvedValue("auto");
		confirmQuickBooksTax.mockResolvedValue({
			status: "zero_blocked",
			qbTaxCents: 0,
			oursCents: 550,
			items: ["Air Filter 16x25", "Services"],
			lineIds: ["l1", "l2"],
		});
	});

	const zeroRefusal = {
		err: "QuickBooks charged no tax. Check the sales tax category on these QuickBooks items: Air Filter 16x25, Services",
		code: "QB_TAX_ZERO",
		details: { items: ["Air Filter 16x25", "Services"], line_ids: ["l1", "l2"] },
	};

	it("refuses a send_invoices holder with QB_TAX_ZERO", async () => {
		expect(await patch({ status: "Issued" })).toEqual(zeroRefusal);
		expect(mockDb.invoice.update).not.toHaveBeenCalled();
	});

	it("zero block applies without send_invoices too", async () => {
		expect(await patch({ status: "Issued" }, {})).toEqual(zeroRefusal);
		expect(mockDb.invoice.update).not.toHaveBeenCalled();
	});
});
