import { describe, it, expect, vi, beforeEach } from "vitest";

const { sdb } = vi.hoisted(() => ({
	sdb: {
		invoice: {
			findFirst: vi.fn(),
			updateMany: vi.fn(),
		},
	},
}));

const { rawDb } = vi.hoisted(() => ({
	rawDb: { invoice_payment: { findFirst: vi.fn() } },
}));

vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../db.js", () => ({ db: rawDb }));
vi.mock("../quickbooksService.js", () => ({
	getOrgRealmId: vi.fn(async () => "realm1"),
}));
vi.mock("../logger.js", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("../qb/qbNotify.js", () => ({ notifyQbProblem: vi.fn(async () => undefined) }));
vi.mock("../appLogger.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
	clearQbDivergence,
	flagRefundsMissingFromQb,
	markQbDiverged,
	parseQbDivergenceReasons,
} from "../qb/qbDivergence.js";
import { logActivity } from "../logger.js";
import { notifyQbProblem } from "../qb/qbNotify.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("markQbDiverged", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			qb_invoice_id: "158",
			account_id: "realm1",
			invoice_number: "INV-1039",
		});
	});

	it("marking twice returns false the second time and does not notify again", async () => {
		mockFn(sdb.invoice.findFirst)
			.mockResolvedValueOnce({
				qb_invoice_id: "158",
				account_id: "realm1",
				invoice_number: "INV-1039",
				qb_diverged_at: null,
				qb_diverged_reason: null,
			})
			.mockResolvedValueOnce({
				qb_invoice_id: "158",
				account_id: "realm1",
				invoice_number: "INV-1039",
				qb_diverged_at: new Date(),
				qb_diverged_reason: "refund_not_in_qb",
			});
		mockFn(sdb.invoice.updateMany).mockResolvedValueOnce({ count: 1 });

		const first = await markQbDiverged("inv1", "org1", "refund_not_in_qb");
		const second = await markQbDiverged("inv1", "org1", "refund_not_in_qb");

		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(sdb.invoice.updateMany).toHaveBeenCalledTimes(1);
		expect(mockFn(sdb.invoice.updateMany).mock.calls[0][0].where).toMatchObject({
			id: "inv1",
			qb_diverged_at: null,
			qb_diverged_reason: null,
		});
		expect(mockFn(sdb.invoice.updateMany).mock.calls[0][0].data).toEqual({
			qb_diverged_at: expect.any(Date),
			qb_diverged_reason: "refund_not_in_qb",
		});
		expect(notifyQbProblem).toHaveBeenCalledTimes(1);
		expect(notifyQbProblem).toHaveBeenCalledWith(
			"org1",
			{ id: "inv1", invoice_number: "INV-1039" },
			"refund_not_in_qb",
		);
	});

	it("a second reason on a flagged invoice is appended, bumps the time and notifies for it", async () => {
		const firstAt = new Date("2026-11-20T10:00:00.000Z");
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			qb_invoice_id: "158",
			account_id: "realm1",
			invoice_number: "INV-1039",
			qb_diverged_at: firstAt,
			qb_diverged_reason: "refund_not_in_qb",
		});
		mockFn(sdb.invoice.updateMany).mockResolvedValue({ count: 1 });

		const marked = await markQbDiverged("inv1", "org1", "qb_payment_delete_failed");

		expect(marked).toBe(true);
		const [arg] = mockFn(sdb.invoice.updateMany).mock.calls[0];
		expect(arg.where).toMatchObject({
			id: "inv1",
			qb_diverged_at: firstAt,
			qb_diverged_reason: "refund_not_in_qb",
		});
		expect(arg.data.qb_diverged_reason).toBe("refund_not_in_qb,qb_payment_delete_failed");
		expect(arg.data.qb_diverged_at.getTime()).toBeGreaterThan(firstAt.getTime());
		expect(notifyQbProblem).toHaveBeenCalledWith(
			"org1",
			{ id: "inv1", invoice_number: "INV-1039" },
			"qb_payment_delete_failed",
		);
	});

	it("a reason already in the set writes nothing and does not notify", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			qb_invoice_id: "158",
			account_id: "realm1",
			invoice_number: "INV-1039",
			qb_diverged_at: new Date(),
			qb_diverged_reason: "refund_not_in_qb,qb_payment_duplicate",
		});

		expect(await markQbDiverged("inv1", "org1", "qb_payment_duplicate")).toBe(false);
		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
		expect(notifyQbProblem).not.toHaveBeenCalled();
	});

	it("a mark that loses the race re-reads and appends to the winning reason", async () => {
		const at = new Date("2026-11-20T10:00:00.000Z");
		mockFn(sdb.invoice.findFirst)
			.mockResolvedValueOnce({
				qb_invoice_id: "158",
				account_id: "realm1",
				invoice_number: "INV-1039",
				qb_diverged_at: null,
				qb_diverged_reason: null,
			})
			.mockResolvedValueOnce({
				qb_invoice_id: "158",
				account_id: "realm1",
				invoice_number: "INV-1039",
				qb_diverged_at: at,
				qb_diverged_reason: "refund_not_in_qb",
			});
		mockFn(sdb.invoice.updateMany)
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });

		expect(await markQbDiverged("inv1", "org1", "void_not_in_qb")).toBe(true);
		expect(mockFn(sdb.invoice.updateMany).mock.calls[1][0].data.qb_diverged_reason).toBe(
			"refund_not_in_qb,void_not_in_qb",
		);
		expect(notifyQbProblem).toHaveBeenCalledTimes(1);
	});

	it("never rejects when the database write fails", async () => {
		mockFn(sdb.invoice.updateMany).mockRejectedValue(new Error("db down"));

		await expect(markQbDiverged("inv1", "org1", "refund_not_in_qb")).resolves.toBe(false);
	});

	it("does not mark an invoice synced to another QuickBooks company", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			qb_invoice_id: "158",
			account_id: "realm-old",
		});

		expect(await markQbDiverged("inv1", "org1", "refund_not_in_qb")).toBe(false);
		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
	});
});

describe("parseQbDivergenceReasons", () => {
	it("splits the comma-joined column and treats empty as no reasons", () => {
		expect(parseQbDivergenceReasons("refund_not_in_qb,void_not_in_qb")).toEqual([
			"refund_not_in_qb",
			"void_not_in_qb",
		]);
		expect(parseQbDivergenceReasons(null)).toEqual([]);
	});
});

describe("flagRefundsMissingFromQb", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			qb_invoice_id: "158",
			account_id: "realm1",
			invoice_number: "INV-1039",
			qb_diverged_at: null,
			qb_diverged_reason: null,
		});
		mockFn(sdb.invoice.updateMany).mockResolvedValue({ count: 1 });
	});

	it("flags refund_not_in_qb when the invoice that just reached QuickBooks carries a refund", async () => {
		rawDb.invoice_payment.findFirst.mockResolvedValue({ id: "refund1" });

		await flagRefundsMissingFromQb("inv1", "org1");

		expect(rawDb.invoice_payment.findFirst.mock.calls[0][0].where).toMatchObject({
			invoice_id: "inv1",
			amount: { lt: 0 },
			invoice: { organization_id: "org1" },
		});
		expect(notifyQbProblem).toHaveBeenCalledWith(
			"org1",
			{ id: "inv1", invoice_number: "INV-1039" },
			"refund_not_in_qb",
		);
	});

	it("leaves an invoice without refunds alone", async () => {
		rawDb.invoice_payment.findFirst.mockResolvedValue(null);

		await flagRefundsMissingFromQb("inv1", "org1");

		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
	});
});

describe("clearQbDivergence", () => {
	beforeEach(() => vi.clearAllMocks());

	it("clearing writes nulls and logs invoice.qb_reconciled", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			invoice_number: "INV-1039",
			qb_diverged_at: new Date("2026-11-20T10:00:00.000Z"),
			qb_diverged_reason: "refund_not_in_qb",
		});
		mockFn(sdb.invoice.updateMany).mockResolvedValue({ count: 1 });

		const result = await clearQbDivergence(
			"inv1",
			"org1",
			{ dispatcherId: "d1" },
			new Date("2026-11-20T10:00:00.000Z"),
		);

		expect(result).toEqual({ err: "" });
		expect(sdb.invoice.updateMany).toHaveBeenCalledWith({
			where: { id: "inv1", qb_diverged_at: new Date("2026-11-20T10:00:00.000Z") },
			data: { qb_diverged_at: null, qb_diverged_reason: null },
		});
		expect(logActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "invoice.qb_reconciled",
				entity_type: "invoice",
				entity_id: "inv1",
				organization_id: "org1",
				actor_type: "dispatcher",
				actor_id: "d1",
			}),
		);
	});

	it("refuses to clear when the problems changed after the page loaded", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			invoice_number: "INV-1039",
			qb_diverged_at: new Date("2026-11-21T09:00:00.000Z"),
			qb_diverged_reason: "refund_not_in_qb,qb_payment_duplicate",
		});

		const result = await clearQbDivergence(
			"inv1",
			"org1",
			{ dispatcherId: "d1" },
			new Date("2026-11-20T10:00:00.000Z"),
		);

		expect(result).toEqual({ err: "", changed: true });
		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("refuses to clear when a new reason lands between the read and the write", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue({
			invoice_number: "INV-1039",
			qb_diverged_at: new Date("2026-11-20T10:00:00.000Z"),
			qb_diverged_reason: "refund_not_in_qb",
		});
		mockFn(sdb.invoice.updateMany).mockResolvedValue({ count: 0 });

		const result = await clearQbDivergence(
			"inv1",
			"org1",
			{ dispatcherId: "d1" },
			new Date("2026-11-20T10:00:00.000Z"),
		);

		expect(result).toEqual({ err: "", changed: true });
		expect(logActivity).not.toHaveBeenCalled();
	});

	it("refuses an invoice outside the org", async () => {
		mockFn(sdb.invoice.findFirst).mockResolvedValue(null);

		const result = await clearQbDivergence("inv1", "org1", { dispatcherId: "d1" }, new Date());

		expect(result.err).toBe("Invoice not found");
		expect(sdb.invoice.updateMany).not.toHaveBeenCalled();
		expect(logActivity).not.toHaveBeenCalled();
	});
});
