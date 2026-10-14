import { describe, it, expect, vi, beforeEach } from "vitest";

// Built via vi.hoisted (not a plain module-scope require, which vitest's ESM mock
// factories can't resolve) so both the db.js and lib/context.js mocks below share
// the exact same mock instance. Preamble shape copied from
// disputes.invoice.test.ts.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: { findFirst: vi.fn(), update: vi.fn() },
		invoice_payment: {
			create: vi.fn(),
			findMany: vi.fn(),
			aggregate: vi.fn(),
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

// insertInvoicePayment fires a QuickBooks push after commit; keep it offline.
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
import { insertInvoicePayment, recordRefund } from "../invoicesController.js";
import { createRefundSchema } from "../../lib/validate/invoices.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("recordRefund", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses a refund larger than what was paid", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue({
			id: "inv1",
			status: "PartiallyPaid",
			amount_paid: 100,
			total: 500,
			organization_id: "org1",
			invoice_number: "INV-1039",
		});
		// paid is now derived from a live aggregate, not the cached column.
		mockFn(db.invoice_payment.aggregate).mockResolvedValue({ _sum: { amount: 100 } });

		const result = await recordRefund(
			"inv1",
			{ amount: 250, reason: "goodwill" },
			"org1",
			{ dispatcherId: "d1" },
		);

		expect(result.err).toBeTruthy();
		expect(db.invoice_payment.create).not.toHaveBeenCalled();
	});

	it("writes a negative payment row with the actor and reason", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue({
			id: "inv1",
			status: "Paid",
			amount_paid: 500,
			total: 500,
			organization_id: "org1",
			invoice_number: "INV-1039",
		});
		mockFn(db.invoice_payment.aggregate).mockResolvedValue({ _sum: { amount: 500 } });
		mockFn(db.invoice_payment.create).mockResolvedValue({ id: "pay2", amount: -200 });
		mockFn(db.invoice_payment.findMany).mockResolvedValue([
			{ amount: 500 },
			{ amount: -200 },
		]);

		const result = await recordRefund(
			"inv1",
			{ amount: 200, reason: "credit from INV-1040" },
			"org1",
			{ dispatcherId: "d1" },
		);

		expect(result.err).toBe("");

		const created = mockFn(db.invoice_payment.create).mock.calls[0][0].data;
		expect(created.amount).toBe(-200);
		expect(created.note).toBe("credit from INV-1040");
		expect(created.recorded_by_dispatcher_id).toBe("d1");
		// Refunds are never pushed; QuickBooks payment sync is out of scope.
		expect(created.qb_payment_id ?? null).toBeNull();

		// syncInvoicePaymentTotals runs for real here (not mocked) against the
		// signed sum of payment rows above (500 - 200 = 300 of 500) — a Paid
		// invoice must fall back to PartiallyPaid, never stay Paid.
		const statusUpdate = mockFn(db.invoice.update).mock.calls.find(
			(c: [{ data: { status?: string } }]) => c[0].data.status !== undefined,
		);
		expect(statusUpdate?.[0].data.status).toBe("PartiallyPaid");
	});

	it("refuses a refund on a voided invoice", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue({
			id: "inv1",
			status: "Void",
			amount_paid: 500,
			total: 500,
			organization_id: "org1",
			invoice_number: "INV-1039",
		});

		const result = await recordRefund("inv1", { amount: 10, reason: "x" }, "org1", {
			dispatcherId: "d1",
		});

		expect(result.err).toBeTruthy();
	});

	it("refuses a zero-amount refund at the schema level", () => {
		// amount validation lives in createRefundSchema, not recordRefund itself —
		// the route parses before calling recordRefund. Zero must still be
		// rejected even though negative payment rows are now storable.
		const result = createRefundSchema.safeParse({ amount: 0, reason: "x" });
		expect(result.success).toBe(false);
	});

	// The code uses `>`, not `>=`, so a refund of exactly what was paid must
	// succeed — nothing else in this file pins that boundary, and a future
	// edit to `>=` would otherwise pass unnoticed.
	it("allows a refund of exactly what was paid", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue({
			id: "inv1",
			status: "Paid",
			amount_paid: 500,
			total: 500,
			organization_id: "org1",
			invoice_number: "INV-1039",
		});
		mockFn(db.invoice_payment.aggregate).mockResolvedValue({ _sum: { amount: 500 } });
		mockFn(db.invoice_payment.create).mockResolvedValue({ id: "pay2", amount: -500 });
		mockFn(db.invoice_payment.findMany).mockResolvedValue([{ amount: 500 }, { amount: -500 }]);

		const result = await recordRefund("inv1", { amount: 500, reason: "full refund" }, "org1", {
			dispatcherId: "d1",
		});

		expect(result.err).toBe("");
		expect(db.invoice_payment.create).toHaveBeenCalled();
	});

	// Two near-simultaneous refunds on the same invoice (double-click, client
	// retry) must serialize on the invoice row rather than both reading the
	// same pre-refund paid total and both passing the ceiling check. Approach
	// copied from updatePartsUsedQty.test.ts ("locks the line item... before
	// reading it") and stockMovements.test.ts.
	//
	// The invariant is "lock first, then any number of reads" — NOT "exactly
	// one read". recordRefund reads the invoice once for the status/void
	// check, then again derives the paid total from a live
	// invoice_payment.aggregate, and syncInvoicePaymentTotals (real, not
	// mocked, in this test) reads the invoice and payment rows again to
	// recompute status. All of those reads are legitimate as long as they
	// happen after the lock; only their position relative to "lock" matters,
	// not their count. So every read source (invoice.findFirst,
	// invoice_payment.aggregate, invoice_payment.findMany) is instrumented
	// here, and the assertion checks "lock is first, everything else is a
	// read" rather than pinning an exact call count.
	it("locks the invoice (SELECT … FOR UPDATE) inside the transaction before reading it", async () => {
		const order: string[] = [];
		mockFn(db.$queryRaw).mockImplementation(async () => {
			order.push("lock");
			return [];
		});
		mockFn(db.invoice.findFirst).mockImplementation(async () => {
			order.push("read");
			return {
				id: "inv1",
				status: "Paid",
				amount_paid: 500,
				total: 500,
				organization_id: "org1",
				invoice_number: "INV-1039",
			};
		});
		mockFn(db.invoice_payment.aggregate).mockImplementation(async () => {
			order.push("read");
			return { _sum: { amount: 500 } };
		});
		mockFn(db.invoice_payment.create).mockResolvedValue({ id: "pay2", amount: -200 });
		mockFn(db.invoice_payment.findMany).mockImplementation(async () => {
			order.push("read");
			return [{ amount: 500 }, { amount: -200 }];
		});

		await recordRefund("inv1", { amount: 200, reason: "goodwill" }, "org1", {
			dispatcherId: "d1",
		});

		// The lock must be the very first operation, before any read of the
		// invoice row or its payment rows — a lock that's dropped entirely
		// (no "lock" entry at all, so order[0] is "read") or moved after a
		// read (a "read" ahead of "lock") both fail this.
		expect(order[0]).toBe("lock");
		expect(order.length).toBeGreaterThan(1);
		expect(order.slice(1).every((entry) => entry === "read")).toBe(true);

		const [strings, ...values] = mockFn(db.$queryRaw).mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		// organization_id is in the predicate on purpose: getScopedDb's
		// extension cannot reach raw SQL, so without it a caller in one org
		// can lock another org's invoice row for the life of this transaction
		// even though the scoped read that follows correctly refuses it.
		expect(strings.join("?")).toMatch(
			/SELECT id FROM invoice WHERE id = \? AND organization_id = \? FOR UPDATE/,
		);
		expect(values).toEqual(["inv1", "org1"]);
	});
});

// Payments stay allowed while a dispute is open (D7). resolveDispute takes this
// same lock, so a payment racing a Repeal serializes instead of both passing a
// money check made against stale rows (DW-08).
describe("insertInvoicePayment", () => {
	beforeEach(() => vi.clearAllMocks());

	it("locks the invoice before any read", async () => {
		const order: string[] = [];
		mockFn(db.$queryRaw).mockImplementationOnce(async () => {
			order.push("lock");
			return [];
		});
		mockFn(db.invoice.findFirst).mockImplementation(async () => {
			order.push("read");
			return {
				id: "inv1",
				status: "Disputed",
				total: 500,
				invoice_number: "INV-1039",
				adjusts_invoice_id: null,
			};
		});
		mockFn(db.invoice_payment.aggregate).mockImplementation(async () => {
			order.push("read");
			return { _sum: { amount: 0 } };
		});
		mockFn(db.invoice_payment.create).mockResolvedValue({ id: "pay1" });
		mockFn(db.invoice_payment.findMany).mockResolvedValue([{ amount: 100 }]);

		const result = await insertInvoicePayment(
			"inv1",
			{ amount: 100 },
			"org1",
			{ dispatcherId: "d1" },
		);

		expect(result.err).toBe("");
		expect(order[0]).toBe("lock");
		const [strings, ...values] = mockFn(db.$queryRaw).mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(strings.join("?")).toMatch(
			/SELECT id FROM invoice WHERE id = \? AND organization_id = \? FOR UPDATE/,
		);
		expect(values).toEqual(["inv1", "org1"]);
	});
});
