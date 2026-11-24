import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock shape from controllers/__tests__/invoiceRefund.test.ts. Only the db
// surface syncInvoicePaymentTotals touches is stubbed.
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
	generateInvoiceNumber: vi.fn(),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

import { Prisma } from "../../../generated/prisma/client.js";
import { syncInvoicePaymentTotals } from "../invoiceService.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const tx = mockDb as unknown as Prisma.TransactionClient;
const D = (v: string) => new Prisma.Decimal(v);

type InvoiceRow = {
	total: Prisma.Decimal;
	status: string;
	adjusts_invoice_id: string | null;
	sent_at: Date | null;
	viewed_at: Date | null;
};

function arrange(
	invoice: Partial<InvoiceRow> & { total: Prisma.Decimal },
	payments: { amount: Prisma.Decimal; paid_at?: Date }[],
) {
	mockFn(mockDb.invoice.findFirst).mockResolvedValue({
		status: "Sent",
		adjusts_invoice_id: null,
		sent_at: new Date("2026-09-30T12:00:00Z"),
		viewed_at: null,
		...invoice,
	});
	mockFn(mockDb.invoice_payment.findMany).mockResolvedValue(
		payments.map((p) => ({
			amount: p.amount,
			paid_at: p.paid_at ?? new Date("2026-10-01T12:00:00Z"),
		})),
	);
}

function written() {
	const calls = mockFn(mockDb.invoice.update).mock.calls;
	expect(calls).toHaveLength(1);
	return calls[0][0].data as {
		amount_paid: number;
		balance_due: number;
		status: string;
		paid_at?: Date | null;
	};
}

describe("syncInvoicePaymentTotals", () => {
	beforeEach(() => vi.clearAllMocks());

	it("marks Paid when 1.10 + 2.20 is paid on a 3.30 invoice", async () => {
		arrange({ total: D("3.30") }, [{ amount: D("1.10") }, { amount: D("2.20") }]);

		await syncInvoicePaymentTotals("inv1", tx);

		const data = written();
		expect(data.status).toBe("Paid");
		expect(data.amount_paid).toBe(3.3);
		expect(data.balance_due).toBe(0);
	});

	it("marks Paid with balance 0 for 1234.56 paid as three 411.52 payments", async () => {
		arrange({ total: D("1234.56") }, [
			{ amount: D("411.52") },
			{ amount: D("411.52") },
			{ amount: D("411.52") },
		]);

		await syncInvoicePaymentTotals("inv1", tx);

		const data = written();
		expect(data.status).toBe("Paid");
		expect(data.amount_paid).toBe(1234.56);
		expect(data.balance_due).toBe(0);
	});

	it("marks Paid with balance 0 after seven odd-cent payments summing to 3.30", async () => {
		arrange(
			{ total: D("3.30") },
			["0.10", "0.20", "0.30", "0.40", "0.50", "0.60", "1.20"].map((a) => ({
				amount: D(a),
			})),
		);

		await syncInvoicePaymentTotals("inv1", tx);

		const data = written();
		expect(data.status).toBe("Paid");
		expect(data.amount_paid).toBe(3.3);
		expect(data.balance_due).toBe(0);
	});

	it("sets paid_at to the latest positive payment's paid_at, not now", async () => {
		const oct1 = new Date("2026-10-01T15:00:00Z");
		const oct5 = new Date("2026-10-05T15:00:00Z");
		// Listed out of order so the pick is by date, not by row position.
		arrange({ total: D("100.00") }, [
			{ amount: D("60.00"), paid_at: oct5 },
			{ amount: D("40.00"), paid_at: oct1 },
		]);

		await syncInvoicePaymentTotals("inv1", tx);

		const data = written();
		expect(data.status).toBe("Paid");
		expect(data.paid_at).toEqual(oct5);
	});

	it("clears paid_at when a refund takes the invoice out of Paid", async () => {
		arrange({ total: D("100.00"), status: "Paid" }, [
			{ amount: D("100.00"), paid_at: new Date("2026-10-01T15:00:00Z") },
			{ amount: D("-25.00"), paid_at: new Date("2026-10-09T15:00:00Z") },
		]);

		await syncInvoicePaymentTotals("inv1", tx);

		const data = written();
		expect(data.status).toBe("PartiallyPaid");
		expect(data.paid_at).toBeNull();
		expect(data.amount_paid).toBe(75);
		expect(data.balance_due).toBe(25);
	});

	it("falls back to Issued, not Sent, when every payment is removed from a never-sent invoice", async () => {
		arrange({ total: D("100.00"), status: "Paid", sent_at: null }, []);

		await syncInvoicePaymentTotals("inv1", tx);

		const data = written();
		expect(data.status).toBe("Issued");
		expect(data.amount_paid).toBe(0);
		expect(data.balance_due).toBe(100);
		expect(data.paid_at).toBeNull();
	});

	it("falls back to Viewed when every payment is removed from a viewed invoice", async () => {
		arrange(
			{
				total: D("100.00"),
				status: "PartiallyPaid",
				sent_at: new Date("2026-09-30T12:00:00Z"),
				viewed_at: new Date("2026-10-02T12:00:00Z"),
			},
			[],
		);

		await syncInvoicePaymentTotals("inv1", tx);

		expect(written().status).toBe("Viewed");
	});

	it("keeps a credit adjustment's negative balance", async () => {
		arrange(
			{ total: D("-50.00"), status: "Issued", adjusts_invoice_id: "inv0" },
			[],
		);

		await syncInvoicePaymentTotals("inv1", tx);

		const data = written();
		expect(data.balance_due).toBe(-50);
		expect(data.status).toBe("Issued");
	});
});
