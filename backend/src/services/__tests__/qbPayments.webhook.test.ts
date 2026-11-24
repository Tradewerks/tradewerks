type Inv = { id: string; qb_invoice_id: string; total: number; status?: string };
type Row = {
	id: string;
	invoice_id: string;
	amount: number;
	qb_payment_id: string | null;
	account_id: string;
};
type Where = Record<string, unknown>;

const { sdb, db } = vi.hoisted(() => {
	const db = { invoices: [] as Inv[], rows: [] as Row[] };
	const inList = (cond: unknown, value: string) =>
		cond === undefined || (cond as { in: string[] }).in.includes(value);
	const sdb = {
		invoice_payment: {
			findMany: vi.fn(async ({ where }: { where: Where }) =>
				db.rows.filter(
					(r) =>
						r.qb_payment_id === where.qb_payment_id &&
						r.account_id === where.account_id,
				),
			),
			findFirst: vi.fn(async ({ where }: { where: Where }) => {
				const row = db.rows.find((r) => r.id === where.id);
				if (!row) return null;
				if ("qb_payment_id" in where && where.qb_payment_id === null && row.qb_payment_id !== null) {
					return null;
				}
				return row;
			}),
			aggregate: vi.fn(async ({ where }: { where: Where }) => {
				const rows = db.rows.filter((r) => r.invoice_id === where.invoice_id);
				return {
					_sum: { amount: rows.length ? rows.reduce((s, r) => s + r.amount, 0) : null },
				};
			}),
			create: vi.fn(async () => ({})),
			update: vi.fn(async () => ({})),
			delete: vi.fn(async () => ({})),
			deleteMany: vi.fn(async () => ({ count: 0 })),
		},
		invoice: {
			findMany: vi.fn(async ({ where }: { where: Where }) =>
				db.invoices
					.filter(
						(i) => inList(where.qb_invoice_id, i.qb_invoice_id) && inList(where.id, i.id),
					)
					.map((i) => ({ status: "Sent", ...i })),
			),
		},
		$queryRaw: vi.fn(async () => []),
		$transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(sdb)),
	};
	return { sdb, db };
});

vi.mock("../entitlementService.js", () => ({ isModuleOn: vi.fn(async () => true) }));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../quickbooksService.js", () => ({ qbFetch: vi.fn(), getOrgRealmId: vi.fn() }));
vi.mock("../qb/qbInvoices.js", () => ({ pushInvoice: vi.fn() }));
vi.mock("../invoiceService.js", async (importActual) => {
	const actual = await importActual<typeof import("../invoiceService.js")>();
	return { ...actual, syncInvoicePaymentTotals: vi.fn() };
});
vi.mock("../qb/qbSyncLog.js", () => ({ logExternalSync: vi.fn() }));
vi.mock("../qb/qbDivergence.js", () => ({ markQbDiverged: vi.fn(async () => true) }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import { log as appLog } from "../appLogger.js";
import { handleInboundPaymentEvent } from "../qb/qbPayments.js";
import { qbFetch } from "../quickbooksService.js";
import { logExternalSync } from "../qb/qbSyncLog.js";
import { syncInvoicePaymentTotals } from "../invoiceService.js";
import { markQbDiverged } from "../qb/qbDivergence.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const invLine = (txnId: string, amount: number) => ({
	Amount: amount,
	LinkedTxn: [{ TxnId: txnId, TxnType: "Invoice" }],
});

function qbPayment(id: string, totalAmt: number, lines: unknown[], privateNote?: string) {
	mockFn(qbFetch).mockResolvedValue({
		Payment: {
			Id: id,
			TotalAmt: totalAmt,
			TxnDate: "2026-10-21",
			Line: lines,
			PrivateNote: privateNote,
		},
	});
}

function lockedInvoiceIds(): string[] {
	return sdb.$queryRaw.mock.calls.map((c: unknown[]) => {
		expect((c[0] as string[]).join("?")).toContain("FOR UPDATE");
		return c[1] as string;
	});
}

function syncedInvoiceIds(): string[] {
	return mockFn(syncInvoicePaymentTotals)
		.mock.calls.map((c: unknown[]) => c[0] as string)
		.sort();
}

function resetFixtures() {
	vi.clearAllMocks();
	db.invoices = [{ id: "inv1", qb_invoice_id: "158", total: 1000 }];
	db.rows = [];
}

describe("handleInboundPaymentEvent create", () => {
	beforeEach(resetFixtures);

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

describe("handleInboundPaymentEvent per-invoice rows", () => {
	beforeEach(() => {
		resetFixtures();
		db.invoices = [
			{ id: "inv1", qb_invoice_id: "158", total: 300 },
			{ id: "inv2", qb_invoice_id: "159", total: 300 },
			{ id: "inv3", qb_invoice_id: "160", total: 300 },
		];
	});

	it("Create writes one row per linked invoice, all with the same qb_payment_id", async () => {
		qbPayment("p-10", 900, [invLine("158", 300), invLine("159", 300), invLine("160", 300)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-10", "Create");

		expect(sdb.invoice_payment.create).toHaveBeenCalledTimes(3);
		for (const invoiceId of ["inv1", "inv2", "inv3"]) {
			expect(sdb.invoice_payment.create).toHaveBeenCalledWith({
				data: expect.objectContaining({
					invoice_id: invoiceId,
					amount: 300,
					qb_payment_id: "p-10",
					account_id: "realm1",
				}),
			});
		}
		expect(syncedInvoiceIds()).toEqual(["inv1", "inv2", "inv3"]);
	});

	it("Create skips a line whose invoice is not in this app and still records the others", async () => {
		qbPayment("p-11", 600, [invLine("158", 300), invLine("999", 300)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-11", "Create");

		expect(sdb.invoice_payment.create).toHaveBeenCalledTimes(1);
		expect(sdb.invoice_payment.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ invoice_id: "inv1", amount: 300, qb_payment_id: "p-11" }),
		});
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "webhook_skipped_no_invoice",
				payload: expect.objectContaining({ qbInvoiceId: "999" }),
			}),
		);
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "webhook_created" }),
		);
	});

	it("Update rewrites amounts per invoice and deletes the row of an invoice no longer on the payment", async () => {
		db.invoices = [
			{ id: "inv1", qb_invoice_id: "158", total: 1000 },
			{ id: "inv2", qb_invoice_id: "159", total: 1000 },
			{ id: "inv3", qb_invoice_id: "160", total: 1000 },
		];
		db.rows = [
			{ id: "r1", invoice_id: "inv1", amount: 300, qb_payment_id: "p-12", account_id: "realm1" },
			{ id: "r2", invoice_id: "inv2", amount: 300, qb_payment_id: "p-12", account_id: "realm1" },
		];
		qbPayment("p-12", 500, [invLine("158", 400), invLine("160", 100)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-12", "Update");

		expect(sdb.invoice_payment.update).toHaveBeenCalledWith({
			where: { id: "r1" },
			data: expect.objectContaining({ amount: 400 }),
		});
		expect(sdb.invoice_payment.create).toHaveBeenCalledTimes(1);
		expect(sdb.invoice_payment.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ invoice_id: "inv3", amount: 100, qb_payment_id: "p-12" }),
		});
		expect(sdb.invoice_payment.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["r2"] } },
		});
		expect(syncedInvoiceIds()).toEqual(["inv1", "inv2", "inv3"]);
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "webhook_updated" }),
		);
	});

	it("Delete removes every row with that qb_payment_id and resyncs each invoice", async () => {
		db.rows = [
			{ id: "r1", invoice_id: "inv1", amount: 300, qb_payment_id: "p-13", account_id: "realm1" },
			{ id: "r2", invoice_id: "inv2", amount: 300, qb_payment_id: "p-13", account_id: "realm1" },
		];

		await handleInboundPaymentEvent("org1", "realm1", "p-13", "Delete");

		expect(sdb.invoice_payment.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["r1", "r2"] } },
		});
		expect(syncedInvoiceIds()).toEqual(["inv1", "inv2"]);
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "webhook_deleted" }),
		);
	});

	it("Delete removes only the rows it re-read under the locks", async () => {
		db.rows = [
			{ id: "r1", invoice_id: "inv1", amount: 300, qb_payment_id: "p-15", account_id: "realm1" },
		];
		// A row on an invoice this webhook never locked lands after the re-read.
		const reread = sdb.invoice_payment.findMany.getMockImplementation()!;
		sdb.invoice_payment.findMany
			.mockImplementationOnce(reread)
			.mockImplementationOnce(async (args: { where: Where }) => {
				const rows = await reread(args);
				db.rows.push({
					id: "r9",
					invoice_id: "inv3",
					amount: 300,
					qb_payment_id: "p-15",
					account_id: "realm1",
				});
				return rows;
			});

		await handleInboundPaymentEvent("org1", "realm1", "p-15", "Delete");

		expect(sdb.invoice_payment.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["r1"] } },
		});
		expect(syncedInvoiceIds()).toEqual(["inv1"]);
	});

	it("Create marks each overapplied invoice diverged after the write commits", async () => {
		db.invoices = [
			{ id: "inv1", qb_invoice_id: "158", total: 300 },
			{ id: "inv2", qb_invoice_id: "159", total: 100 },
		];
		qbPayment("p-16", 600, [invLine("158", 300), invLine("159", 300)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-16", "Create");

		expect(markQbDiverged).toHaveBeenCalledTimes(1);
		expect(markQbDiverged).toHaveBeenCalledWith("inv2", "org1", "qb_payment_overapplied");
		const committed = Math.max(...mockFn(syncInvoicePaymentTotals).mock.invocationCallOrder);
		expect(mockFn(markQbDiverged).mock.invocationCallOrder[0]).toBeGreaterThan(committed);
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "webhook_overapplied",
				payload: expect.objectContaining({ unplacedCents: 20000 }),
			}),
		);
	});

	it("every webhook write takes the invoice row lock first", async () => {
		// Local ids sort opposite to QB line order, so line order can't pass for id order.
		db.invoices = [
			{ id: "inv-b", qb_invoice_id: "158", total: 300 },
			{ id: "inv-a", qb_invoice_id: "159", total: 300 },
		];
		const firstWriteOrder = () =>
			Math.min(
				...[
					sdb.invoice_payment.create,
					sdb.invoice_payment.update,
					sdb.invoice_payment.deleteMany,
					sdb.invoice_payment.aggregate,
				].flatMap((f) => f.mock.invocationCallOrder),
			);
		const lastLockOrder = () => Math.max(...sdb.$queryRaw.mock.invocationCallOrder);

		qbPayment("p-14", 600, [invLine("158", 300), invLine("159", 300)]);
		await handleInboundPaymentEvent("org1", "realm1", "p-14", "Create");
		expect(lockedInvoiceIds()).toEqual(["inv-a", "inv-b"]);
		expect(lastLockOrder()).toBeLessThan(firstWriteOrder());

		vi.clearAllMocks();
		db.rows = [
			{ id: "r1", invoice_id: "inv-b", amount: 300, qb_payment_id: "p-14", account_id: "realm1" },
			{ id: "r2", invoice_id: "inv-a", amount: 300, qb_payment_id: "p-14", account_id: "realm1" },
		];
		qbPayment("p-14", 200, [invLine("158", 200)]);
		await handleInboundPaymentEvent("org1", "realm1", "p-14", "Update");
		expect(lockedInvoiceIds()).toEqual(["inv-a", "inv-b"]);
		expect(lastLockOrder()).toBeLessThan(firstWriteOrder());

		vi.clearAllMocks();
		await handleInboundPaymentEvent("org1", "realm1", "p-14", "Delete");
		expect(lockedInvoiceIds()).toEqual(["inv-a", "inv-b"]);
		expect(lastLockOrder()).toBeLessThan(firstWriteOrder());
	});
});

describe("handleInboundPaymentEvent own-push echo", () => {
	const localId = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

	beforeEach(resetFixtures);

	it("Create links its own pushed payment by PrivateNote instead of inserting a duplicate", async () => {
		db.rows = [
			{ id: localId, invoice_id: "inv1", amount: 25, qb_payment_id: null, account_id: "" },
		];
		qbPayment("p-20", 25, [invLine("158", 25)], `hvac:payment:${localId}`);

		await handleInboundPaymentEvent("org1", "realm1", "p-20", "Create");

		expect(sdb.invoice_payment.create).not.toHaveBeenCalled();
		expect(sdb.invoice_payment.update).toHaveBeenCalledWith({
			where: { id: localId },
			data: { qb_payment_id: "p-20", account_id: "realm1" },
		});
		expect(lockedInvoiceIds()).toEqual(["inv1"]);
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "webhook_linked_own_push" }),
		);
	});

	// The marker names a row already linked to another QuickBooks payment in
	// this company: QuickBooks holds the same payment twice.
	it("an echo whose local payment is linked to a different QuickBooks payment flags qb_payment_duplicate", async () => {
		db.rows = [
			{ id: localId, invoice_id: "inv1", amount: 25, qb_payment_id: "p-19", account_id: "realm1" },
		];
		qbPayment("p-20", 25, [invLine("158", 25)], `memo hvac:payment:${localId}`);

		await handleInboundPaymentEvent("org1", "realm1", "p-20", "Create");

		expect(sdb.invoice_payment.create).not.toHaveBeenCalled();
		expect(sdb.invoice_payment.update).not.toHaveBeenCalled();
		expect(appLog.error).toHaveBeenCalledWith(
			expect.objectContaining({ qbPaymentId: "p-20", linkedQbPaymentId: "p-19" }),
			expect.any(String),
		);
		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "qb_payment_duplicate");
		expect(lockedInvoiceIds()).toEqual(["inv1"]);
		const committed = Math.max(...sdb.$transaction.mock.invocationCallOrder);
		expect(mockFn(markQbDiverged).mock.invocationCallOrder[0]).toBeGreaterThan(committed);
	});

	it("an echo whose local payment is linked in a previous QuickBooks company is a plain echo skip", async () => {
		db.rows = [
			{ id: localId, invoice_id: "inv1", amount: 25, qb_payment_id: "p-19", account_id: "realm-old" },
		];
		qbPayment("p-20", 25, [invLine("158", 25)], `hvac:payment:${localId}`);

		await handleInboundPaymentEvent("org1", "realm1", "p-20", "Create");

		expect(sdb.invoice_payment.update).not.toHaveBeenCalled();
		expect(markQbDiverged).not.toHaveBeenCalled();
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "webhook_echo_skipped" }),
		);
	});

	// Deleted here while its push was in flight: the QuickBooks payment is an orphan.
	it("an echo whose local payment no longer exists flags its invoice qb_payment_delete_failed", async () => {
		qbPayment("p-21", 25, [invLine("158", 25)], `hvac:payment:${localId}`);

		await handleInboundPaymentEvent("org1", "realm1", "p-21", "Create");

		expect(sdb.invoice_payment.create).not.toHaveBeenCalled();
		expect(sdb.invoice_payment.update).not.toHaveBeenCalled();
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "webhook_echo_skipped",
				payload: expect.objectContaining({ paymentId: localId }),
			}),
		);
		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "qb_payment_delete_failed");
	});
});

describe("handleInboundPaymentEvent void and draft invoices", () => {
	beforeEach(resetFixtures);

	it("Create on a Void invoice writes no row and flags qb_payment_on_void", async () => {
		db.invoices = [{ id: "inv1", qb_invoice_id: "158", total: 1000, status: "Void" }];
		qbPayment("p-40", 25, [invLine("158", 25)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-40", "Create");

		expect(sdb.invoice_payment.create).not.toHaveBeenCalled();
		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "qb_payment_on_void");
	});

	it("Create on a Void invoice still records the cash on a live invoice beside it", async () => {
		db.invoices = [
			{ id: "inv1", qb_invoice_id: "158", total: 1000, status: "Void" },
			{ id: "inv2", qb_invoice_id: "159", total: 1000 },
		];
		qbPayment("p-41", 50, [invLine("158", 25), invLine("159", 25)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-41", "Create");

		expect(sdb.invoice_payment.create).toHaveBeenCalledTimes(1);
		expect(sdb.invoice_payment.create).toHaveBeenCalledWith({
			data: expect.objectContaining({ invoice_id: "inv2", amount: 25 }),
		});
		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "qb_payment_on_void");
	});

	it("Update keeps the existing row on a Void invoice rather than deleting it", async () => {
		db.invoices = [{ id: "inv1", qb_invoice_id: "158", total: 1000, status: "Void" }];
		db.rows = [
			{ id: "r1", invoice_id: "inv1", amount: 25, qb_payment_id: "p-42", account_id: "realm1" },
		];
		qbPayment("p-42", 30, [invLine("158", 30)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-42", "Update");

		expect(sdb.invoice_payment.update).not.toHaveBeenCalled();
		expect(sdb.invoice_payment.deleteMany).not.toHaveBeenCalled();
		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "qb_payment_on_void");
	});

	it("Create on a Draft invoice is skipped and logged", async () => {
		db.invoices = [{ id: "inv1", qb_invoice_id: "158", total: 1000, status: "Draft" }];
		qbPayment("p-43", 25, [invLine("158", 25)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-43", "Create");

		expect(sdb.invoice_payment.create).not.toHaveBeenCalled();
		expect(markQbDiverged).not.toHaveBeenCalled();
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "webhook_skipped_no_invoice",
				payload: expect.objectContaining({ qbInvoiceId: "158", message: "Invoice is a draft" }),
			}),
		);
	});
});

describe("handleInboundPaymentEvent refunds left uncovered", () => {
	beforeEach(resetFixtures);

	it("Delete of a payment a refund drew on flags refund_exceeds_payments after commit", async () => {
		db.rows = [
			{ id: "r1", invoice_id: "inv1", amount: 50, qb_payment_id: "p-30", account_id: "realm1" },
			{ id: "ref1", invoice_id: "inv1", amount: -40, qb_payment_id: null, account_id: "" },
		];
		sdb.invoice_payment.deleteMany.mockImplementationOnce(
			async ({ where }: { where: { id: { in: string[] } } }) => {
				db.rows = db.rows.filter((r) => !where.id.in.includes(r.id));
				return { count: 1 };
			},
		);

		await handleInboundPaymentEvent("org1", "realm1", "p-30", "Delete");

		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "refund_exceeds_payments");
		expect(appLog.warn).toHaveBeenCalledWith(
			expect.objectContaining({ invoiceId: "inv1", paidCents: -4000 }),
			expect.any(String),
		);
		const committed = Math.max(...sdb.$transaction.mock.invocationCallOrder);
		expect(mockFn(markQbDiverged).mock.invocationCallOrder[0]).toBeGreaterThan(committed);
	});

	it("Update that shrinks a payment below its refunds flags refund_exceeds_payments", async () => {
		db.rows = [
			{ id: "r1", invoice_id: "inv1", amount: 100, qb_payment_id: "p-31", account_id: "realm1" },
			{ id: "ref1", invoice_id: "inv1", amount: -80, qb_payment_id: null, account_id: "" },
		];
		sdb.invoice_payment.update.mockImplementationOnce(
			async ({ where, data }: { where: { id: string }; data: { amount: number } }) => {
				const row = db.rows.find((r) => r.id === where.id)!;
				row.amount = data.amount;
				return row;
			},
		);
		qbPayment("p-31", 30, [invLine("158", 30)]);

		await handleInboundPaymentEvent("org1", "realm1", "p-31", "Update");

		expect(markQbDiverged).toHaveBeenCalledWith("inv1", "org1", "refund_exceeds_payments");
	});

	it("Delete that leaves the paid total at zero or more flags nothing", async () => {
		db.rows = [
			{ id: "r1", invoice_id: "inv1", amount: 50, qb_payment_id: "p-32", account_id: "realm1" },
		];

		await handleInboundPaymentEvent("org1", "realm1", "p-32", "Delete");

		expect(markQbDiverged).not.toHaveBeenCalled();
	});
});

describe("handleInboundPaymentEvent failure", () => {
	beforeEach(resetFixtures);

	it("a failed webhook is logged to the app log, not only the sync log", async () => {
		const boom = new Error("QuickBooks 503");
		mockFn(qbFetch).mockRejectedValueOnce(boom);

		await handleInboundPaymentEvent("org1", "realm1", "p-50", "Create");

		expect(appLog.error).toHaveBeenCalledWith(
			{ err: boom, qbPaymentId: "p-50", orgId: "org1" },
			expect.any(String),
		);
		expect(logExternalSync).toHaveBeenCalledWith(
			expect.objectContaining({ action: "webhook_failed" }),
		);
	});
});
