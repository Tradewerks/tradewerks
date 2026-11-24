const { sdb, syncLog } = vi.hoisted(() => {
	// Stands in for external_sync_log: the count reads back what the push logged.
	const httpFailures: string[] = [];
	return {
		sdb: {
			invoice_payment: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
		},
		syncLog: {
			httpFailures,
			logExternalSync: vi.fn(async (e: { action: string; external_id: string }) => {
				if (e.action === "push_http_failed") httpFailures.push(e.external_id);
			}),
			countPaymentPushHttpFailures: vi.fn(
				async (paymentId: string) => httpFailures.filter((id) => id === paymentId).length,
			),
		},
	};
});

vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../quickbooksService.js", () => ({ qbFetch: vi.fn(), getOrgRealmId: vi.fn() }));
vi.mock("../qb/qbInvoices.js", () => ({ pushInvoice: vi.fn() }));
vi.mock("../invoiceService.js", () => ({ syncInvoicePaymentTotals: vi.fn() }));
vi.mock("../qb/qbSyncLog.js", () => syncLog);
vi.mock("../qb/qbDivergence.js", () => ({ markQbDiverged: vi.fn(async () => true) }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	parsePaymentPrivateNote,
	paymentPrivateNote,
	pushPaymentToQB,
	deleteQBPayment,
} from "../qb/qbPayments.js";
import { getOrgRealmId, qbFetch } from "../quickbooksService.js";
import { QbHttpError } from "../qb/qbHttpError.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { markQbDiverged } from "../qb/qbDivergence.js";
import { log } from "../appLogger.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

function paymentRow(qbCustomerId: string, paidAt = "2026-11-20T15:00:00Z") {
	return {
		id: "pay1",
		amount: 125.5,
		paid_at: new Date(paidAt),
		qb_payment_id: null,
		account_id: null,
		invoice: {
			id: "inv1",
			qb_invoice_id: "158",
			account_id: "realm1",
			client: {
				client_external_mapping: [
					{ provider: "quickbooks", external_id: qbCustomerId },
				],
			},
		},
	};
}

function postCalls() {
	return mockFn(qbFetch).mock.calls.filter((c) => c[1] === "POST");
}

describe("pushPaymentToQB", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		syncLog.httpFailures.length = 0;
		mockFn(getOrgRealmId).mockResolvedValue("realm1");
		mockFn(qbFetch).mockResolvedValue({ Payment: { Id: "qb-9" } });
		sdb.invoice_payment.findFirst.mockResolvedValue(paymentRow("cust-1"));
	});

	it("push sends a deterministic requestid: same payment and payload twice gives the same id", async () => {
		await pushPaymentToQB("pay1", "org1");
		await pushPaymentToQB("pay1", "org1");

		const [first, second] = postCalls();
		const id1 = first[4]?.requestId as string;
		const id2 = second[4]?.requestId as string;
		expect(id1).toMatch(/^pay-pay1-[0-9a-f]{8}$/);
		expect(id1.length).toBeLessThanOrEqual(50);
		expect(id2).toBe(id1);
	});

	it("push requestid changes when the QB customer ref changes", async () => {
		await pushPaymentToQB("pay1", "org1");
		sdb.invoice_payment.findFirst.mockResolvedValue(paymentRow("cust-2"));
		await pushPaymentToQB("pay1", "org1");

		const [first, second] = postCalls();
		expect(first[4]?.requestId).not.toBe(second[4]?.requestId);
		expect(second[4]?.requestId).toMatch(/^pay-pay1-[0-9a-f]{8}$/);
	});

	it("push includes PrivateNote hvac:payment:<id>", async () => {
		await pushPaymentToQB("pay1", "org1");

		const [call] = postCalls();
		expect(call[2]).toBe("/payment");
		expect(call[3]).toMatchObject({ PrivateNote: "hvac:payment:pay1" });
	});
});

describe("pushPaymentToQB retries", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		syncLog.httpFailures.length = 0;
		mockFn(getOrgRealmId).mockResolvedValue("realm1");
		sdb.invoice_payment.findFirst.mockResolvedValue(paymentRow("cust-1"));
	});

	it("push requestid changes on retry after an HTTP 400 from QuickBooks", async () => {
		mockFn(qbFetch)
			.mockRejectedValueOnce(new QbHttpError("POST", "/payment", 400, "{}"))
			.mockResolvedValueOnce({ Payment: { Id: "qb-9" } });

		await expect(pushPaymentToQB("pay1", "org1")).rejects.toThrow("400");
		await pushPaymentToQB("pay1", "org1");

		const [first, second] = postCalls();
		expect(second[4]?.requestId).toMatch(/^pay-pay1-[0-9a-f]{8}$/);
		expect(second[4]?.requestId).not.toBe(first[4]?.requestId);
		expect(syncLog.logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "push_http_failed",
				entity_type: "payment",
				external_id: "pay1",
			}),
		);
	});

	it.each([503, 429])(
		"push requestid is reused on retry after an HTTP %i (not a definitive rejection)",
		async (status) => {
			mockFn(qbFetch)
				.mockRejectedValueOnce(new QbHttpError("POST", "/payment", status, "{}"))
				.mockResolvedValueOnce({ Payment: { Id: "qb-9" } });

			await expect(pushPaymentToQB("pay1", "org1")).rejects.toThrow(String(status));
			await pushPaymentToQB("pay1", "org1");

			const [first, second] = postCalls();
			expect(second[4]?.requestId).toBe(first[4]?.requestId);
			expect(syncLog.httpFailures).toHaveLength(0);
		},
	);

	it("push requestid is reused on retry after a network error", async () => {
		mockFn(qbFetch)
			.mockRejectedValueOnce(new TypeError("fetch failed"))
			.mockResolvedValueOnce({ Payment: { Id: "qb-9" } });

		await expect(pushPaymentToQB("pay1", "org1")).rejects.toThrow("fetch failed");
		await pushPaymentToQB("pay1", "org1");

		const [first, second] = postCalls();
		expect(second[4]?.requestId).toBe(first[4]?.requestId);
		expect(syncLog.httpFailures).toHaveLength(0);
	});

	it("push success path logs no failure and keeps the id", async () => {
		mockFn(qbFetch).mockResolvedValue({ Payment: { Id: "qb-9" } });

		await pushPaymentToQB("pay1", "org1");
		await pushPaymentToQB("pay1", "org1");

		const [first, second] = postCalls();
		expect(second[4]?.requestId).toBe(first[4]?.requestId);
		expect(syncLog.httpFailures).toHaveLength(0);
		expect(syncLog.logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "create", external_id: "qb-9" }),
		);
	});

	it("push requestid ignores paid_at time of day", async () => {
		mockFn(qbFetch).mockResolvedValue({ Payment: { Id: "qb-9" } });

		await pushPaymentToQB("pay1", "org1");
		sdb.invoice_payment.findFirst.mockResolvedValue(
			paymentRow("cust-1", "2026-11-20T21:45:10Z"),
		);
		await pushPaymentToQB("pay1", "org1");

		const [first, second] = postCalls();
		expect(second[4]?.requestId).toBe(first[4]?.requestId);
	});
});

describe("payment PrivateNote helpers", () => {
	const uuid = "3f2b8c1e-9a4d-4e7b-b1c2-0d5e6f7a8b9c";

	it("round-trips the marker and rejects foreign notes", () => {
		expect(paymentPrivateNote(uuid)).toBe(`hvac:payment:${uuid}`);
		expect(parsePaymentPrivateNote(paymentPrivateNote(uuid))).toBe(uuid);
		expect(parsePaymentPrivateNote("hvac:payment:")).toBeNull();
		expect(parsePaymentPrivateNote("hvac:payment:abc")).toBeNull();
		expect(parsePaymentPrivateNote("paid by check")).toBeNull();
		expect(parsePaymentPrivateNote(undefined)).toBeNull();
	});

	it("parsePaymentPrivateNote finds the marker with text after it", () => {
		expect(parsePaymentPrivateNote(`hvac:payment:${uuid} - paid by check`)).toBe(uuid);
	});

	it("parsePaymentPrivateNote finds the marker with text before it", () => {
		expect(parsePaymentPrivateNote(`Check #1042 hvac:payment:${uuid}`)).toBe(uuid);
	});
});

describe("pushPaymentToQB payment deleted during the push", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(getOrgRealmId).mockResolvedValue("realm1");
		sdb.invoice_payment.findFirst.mockResolvedValue(paymentRow("cust-1"));
		mockFn(qbFetch).mockResolvedValue({ Payment: { Id: "qb-9" } });
	});

	// The POST landed in QuickBooks but the local row is gone: an orphan there,
	// not a push failure a Retry could fix.
	it("a payment deleted while its push was in flight flags qb_payment_delete_failed, not a push failure", async () => {
		sdb.invoice_payment.update.mockRejectedValueOnce(
			new Prisma.PrismaClientKnownRequestError("Record to update not found.", {
				code: "P2025",
				clientVersion: "test",
			}),
		);

		await expect(pushPaymentToQB("pay1", "org1")).resolves.toBeUndefined();

		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "qb_payment_delete_failed");
		expect(syncLog.logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "push_orphaned", external_id: "qb-9" }),
		);
	});

	it("any other failure storing the QuickBooks id still rejects", async () => {
		sdb.invoice_payment.update.mockRejectedValueOnce(new Error("pool exhausted"));

		await expect(pushPaymentToQB("pay1", "org1")).rejects.toThrow("pool exhausted");
		expect(markQbDiverged).not.toHaveBeenCalled();
	});
});

describe("deleteQBPayment", () => {
	beforeEach(() => vi.clearAllMocks());

	const fault = (code: string) =>
		new QbHttpError(
			"GET",
			"/payment/qb-9",
			400,
			JSON.stringify({ Fault: { Error: [{ code, Message: "Object Not Found" }] } }),
		);

	it("treats QuickBooks fault 610 as already deleted and logs it", async () => {
		mockFn(qbFetch).mockRejectedValueOnce(fault("610"));

		await expect(deleteQBPayment("qb-9", "org1")).resolves.toBeUndefined();
		expect(syncLog.logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "delete_already_gone", external_id: "qb-9" }),
		);
		expect(log.info).toHaveBeenCalled();
	});

	it("rethrows a not-found message that is not QuickBooks fault 610", async () => {
		mockFn(qbFetch).mockRejectedValueOnce(new Error("Route not found"));

		await expect(deleteQBPayment("qb-9", "org1")).rejects.toThrow("Route not found");
	});

	it("rethrows another QuickBooks fault", async () => {
		mockFn(qbFetch).mockRejectedValueOnce(fault("6000"));

		await expect(deleteQBPayment("qb-9", "org1")).rejects.toThrow("6000");
	});
});
