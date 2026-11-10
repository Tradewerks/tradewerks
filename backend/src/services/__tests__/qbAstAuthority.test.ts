const { sdb } = vi.hoisted(() => {
	const sdb: any = {
		invoice: { findFirst: vi.fn(), update: vi.fn(async () => ({})) },
		$queryRaw: vi.fn(async () => []),
		organization: { findUnique: vi.fn(async () => null) },
	};
	sdb.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(sdb));
	return { sdb };
});

vi.mock("../entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));
vi.mock("../../lib/context.js", () => ({ getScopedDb: vi.fn(() => sdb) }));
vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../quickbooksService.js", () => ({
	qbFetch: vi.fn(),
	getOrgRealmId: vi.fn(async () => "realm1"),
	isQBConnected: vi.fn(async () => true),
}));
vi.mock("../qb/qbTax.js", () => ({ getQBTaxPrefs: vi.fn(async () => ({ automatedSalesTax: true })) }));
vi.mock("../qb/qbInvoices.js", () => ({
	pushInvoice: vi.fn(),
	invoiceForQBInclude: vi.fn(() => ({})),
}));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isModuleOn } from "../entitlementService.js";
import { isQBConnected } from "../quickbooksService.js";
import { getQBTaxPrefs } from "../qb/qbTax.js";
import { pushInvoice } from "../qb/qbInvoices.js";
import { buildInvoicePayload, qbPushFingerprint } from "../qb/qbInvoiceTax.js";
import { TAXABLE_ITEM_NAME } from "../qb/qbTaxableItem.js";
import {
	confirmQuickBooksTax,
	QB_CONFIRM_DEADLINE_MS,
	QB_UNAVAILABLE_REASON,
} from "../qb/qbAstAuthority.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

function line(over: Record<string, unknown> = {}) {
	return {
		total: "100.00",
		quantity: "1",
		unit_price: "100.00",
		name: "Furnace repair",
		description: null,
		taxable: true,
		tax_group_id: "g1",
		tax_amount: "5.50",
		inventory_item: null,
		...over,
	};
}

function invoiceFixture(over: Record<string, unknown> = {}, snapOver: Record<string, unknown> = {}) {
	return {
		id: "inv1",
		status: "Draft",
		discount_amount: null,
		amount_paid: "0",
		adjusts_invoice_id: null,
		tax_needs_review: false,
		tax_review_ack_at: null,
		tax_snapshot: {
			version: 2,
			source: "manual",
			rounding: "jurisdiction_half_up",
			locked_at: "draft",
			client_exempt: false,
			groups: [{ id: "g1", tax_amount_cents: 550, rates: [] }],
			total_tax_cents: 550,
			subtotal_cents: 10000,
			discount_cents: 0,
			total_cents: 10550,
			...snapOver,
		},
		line_items: [line()],
		client: { is_tax_exempt: false, address: "1 Client Way, Onalaska, WI 54650", coords: null },
		jobs: [{ job: { address: "2842 Main St, La Crosse, WI 54601", coords: null } }],
		...over,
	};
}

function fingerprintOf(inv: ReturnType<typeof invoiceFixture>) {
	const { lines, shipAddr, clientExempt } = buildInvoicePayload(inv, null);
	return qbPushFingerprint(lines, shipAddr, clientExempt);
}

function pushReturns(inv: ReturnType<typeof invoiceFixture>, qbTaxCents: number | null) {
	mockFn(pushInvoice).mockResolvedValue({
		qbTaxCents,
		fingerprint: fingerprintOf(inv),
		automatedSalesTax: true,
		mismatch: qbTaxCents !== 550,
	});
}

function lastUpdateData(): Record<string, any> {
	const calls = mockFn(sdb.invoice.update).mock.calls;
	return calls.find((c) => "tax_source" in c[0].data)?.[0].data;
}

describe("confirmQuickBooksTax", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: true });
	});

	it("skips without pushing or writing when QuickBooks does not run AST", async () => {
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: false });
		sdb.invoice.findFirst.mockResolvedValue(invoiceFixture());

		expect(await confirmQuickBooksTax("inv1", "org1")).toEqual({ status: "skipped" });
		expect(pushInvoice).not.toHaveBeenCalled();
		expect(sdb.invoice.update).not.toHaveBeenCalled();
	});

	it("skips when the module is off or QuickBooks is disconnected", async () => {
		sdb.invoice.findFirst.mockResolvedValue(invoiceFixture());
		mockFn(isModuleOn).mockResolvedValueOnce(false);
		expect((await confirmQuickBooksTax("inv1", "org1")).status).toBe("skipped");
		mockFn(isQBConnected).mockResolvedValueOnce(false);
		expect((await confirmQuickBooksTax("inv1", "org1")).status).toBe("skipped");
		expect(getQBTaxPrefs).not.toHaveBeenCalled();
		expect(sdb.invoice.update).not.toHaveBeenCalled();
	});

	it("skips a document that is no longer a draft", async () => {
		sdb.invoice.findFirst.mockResolvedValue(
			invoiceFixture({ status: "Issued" }, { locked_at: "2026-10-19T00:00:00.000Z" }),
		);
		expect((await confirmQuickBooksTax("inv1", "org1")).status).toBe("skipped");
		expect(pushInvoice).not.toHaveBeenCalled();
	});

	it("adopts QuickBooks' figure within a cent, with no review", async () => {
		const inv = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 551);

		const r = await confirmQuickBooksTax("inv1", "org1");

		expect(r).toEqual({ status: "adopted", qbTaxCents: 551, oursCents: 550 });
		const data = lastUpdateData();
		expect(data).toMatchObject({
			tax_amount: 5.51,
			total: 105.51,
			balance_due: 105.51,
			tax_source: "qb_ast",
		});
		expect(data).not.toHaveProperty("tax_needs_review");
		expect(data.tax_snapshot).toMatchObject({
			source: "qb_ast",
			qb_tax_cents: 551,
			qb_fingerprint: fingerprintOf(inv),
			qb_review: false,
			total_tax_cents: 550,
			groups: [{ id: "g1", tax_amount_cents: 550 }],
		});
		expect(data.tax_snapshot.review_reason).toBeUndefined();
	});

	it("adopts a delta but asks for acknowledgment", async () => {
		const inv = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 610);

		const r = await confirmQuickBooksTax("inv1", "org1");

		const reason = "QuickBooks calculated $6.10 (you estimated $5.50)";
		expect(r).toEqual({ status: "needs_ack", qbTaxCents: 610, oursCents: 550, reason });
		const data = lastUpdateData();
		expect(data).toMatchObject({
			tax_amount: 6.1,
			total: 106.1,
			tax_needs_review: true,
			tax_review_ack_by: null,
			tax_review_ack_at: null,
		});
		expect(data.tax_snapshot).toMatchObject({ review_reason: reason, qb_review: true });
		// The push flagged a mismatch against our old estimate; adoption resolves it.
		expect(sdb.invoice.update).toHaveBeenCalledWith({
			where: { id: "inv1" },
			data: { qb_sync_status: "synced" },
		});
	});

	it("locks the invoice row before reading it for the fingerprint check", async () => {
		const inv = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 550);

		await confirmQuickBooksTax("inv1", "org1");

		const lock = mockFn(sdb.$queryRaw).mock;
		expect(lock.calls).toHaveLength(1);
		const [sql, ...params] = lock.calls[0];
		expect(sql.join("?")).toMatch(/SELECT id FROM invoice WHERE id = \? AND organization_id = \? FOR UPDATE/);
		expect(params).toEqual(["inv1", "org1"]);
		// The pre-check read happens outside the tx; every read inside it must follow the lock.
		const reads = mockFn(sdb.invoice.findFirst).mock.invocationCallOrder;
		const lockOrder = lock.invocationCallOrder[0];
		expect(reads.filter((o) => o > lockOrder)).toHaveLength(2);
		expect(reads.filter((o) => o < lockOrder)).toHaveLength(1);
	});

	it("adds the one-rate note when lines carry more than one manual group", async () => {
		const inv = invoiceFixture({
			line_items: [line(), line({ tax_group_id: "g2" }), line({ taxable: false, tax_group_id: "g3" })],
		});
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 610);

		const r = await confirmQuickBooksTax("inv1", "org1");

		expect(r.reason).toBe(
			"QuickBooks calculated $6.10 (you estimated $5.50); QuickBooks applies one rate — line tax groups were not used",
		);
	});

	it("never throws when QuickBooks fails: unavailable, flagged and marked failed", async () => {
		sdb.invoice.findFirst.mockResolvedValue(invoiceFixture());
		mockFn(pushInvoice).mockRejectedValue(new Error("503"));

		const r = await confirmQuickBooksTax("inv1", "org1");

		expect(r).toEqual({ status: "unavailable", reason: QB_UNAVAILABLE_REASON });
		const data = mockFn(sdb.invoice.update).mock.calls.at(-1)![0].data;
		expect(data).toMatchObject({ qb_sync_status: "failed", tax_needs_review: true });
		expect(data.tax_snapshot).toMatchObject({
			review_reason: QB_UNAVAILABLE_REASON,
			qb_review: true,
			source: "manual",
		});
		expect(data).not.toHaveProperty("tax_amount");
	});

	it("treats an unreadable TotalTax as unavailable rather than adopting zero", async () => {
		const inv = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, null);

		expect((await confirmQuickBooksTax("inv1", "org1")).status).toBe("unavailable");
		expect(lastUpdateData()).toBeUndefined();
	});

	it("keeps the ack when a re-confirm yields the same reason", async () => {
		const reason = "QuickBooks calculated $6.10 (you estimated $5.50)";
		const inv = invoiceFixture(
			{ tax_source: "qb_ast", tax_needs_review: true, tax_review_ack_at: new Date() },
			{ source: "qb_ast", review_reason: reason, qb_review: true, qb_tax_cents: 610 },
		);
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 610);

		const r = await confirmQuickBooksTax("inv1", "org1");

		expect(r.status).toBe("adopted");
		const data = lastUpdateData();
		expect(data).not.toHaveProperty("tax_review_ack_at");
		expect(data).not.toHaveProperty("tax_review_ack_by");
	});

	it("resets the ack when the reason changes", async () => {
		const inv = invoiceFixture(
			{ tax_needs_review: true, tax_review_ack_at: new Date() },
			{ source: "qb_ast", review_reason: "QuickBooks calculated $6.10 (you estimated $5.50)", qb_review: true },
		);
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 720);

		const r = await confirmQuickBooksTax("inv1", "org1");

		expect(r.status).toBe("needs_ack");
		expect(lastUpdateData()).toMatchObject({ tax_review_ack_by: null, tax_review_ack_at: null });
	});

	it("clears an earlier QuickBooks review once QuickBooks agrees, but leaves a resolver review", async () => {
		const qbInv = invoiceFixture(
			{ tax_needs_review: true },
			{ review_reason: "QuickBooks calculated $6.10 (you estimated $5.50)", qb_review: true },
		);
		sdb.invoice.findFirst.mockResolvedValue(qbInv);
		pushReturns(qbInv, 550);
		await confirmQuickBooksTax("inv1", "org1");
		expect(lastUpdateData()).toMatchObject({ tax_needs_review: false });
		expect(lastUpdateData().tax_snapshot.review_reason).toBeUndefined();

		vi.clearAllMocks();
		const resolverInv = invoiceFixture({ tax_needs_review: true }, { review_reason: "Address not found" });
		sdb.invoice.findFirst.mockResolvedValue(resolverInv);
		pushReturns(resolverInv, 550);
		await confirmQuickBooksTax("inv1", "org1");
		expect(lastUpdateData()).not.toHaveProperty("tax_needs_review");
		expect(lastUpdateData().tax_snapshot.review_reason).toBe("Address not found");
	});

	it("retries once when the draft changed during the push", async () => {
		const inv = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValue(inv);
		mockFn(pushInvoice)
			.mockResolvedValueOnce({ qbTaxCents: 550, fingerprint: "stale", automatedSalesTax: true, mismatch: false })
			.mockResolvedValueOnce({
				qbTaxCents: 550,
				fingerprint: fingerprintOf(inv),
				automatedSalesTax: true,
				mismatch: false,
			});

		expect((await confirmQuickBooksTax("inv1", "org1")).status).toBe("adopted");
		expect(pushInvoice).toHaveBeenCalledTimes(2);
	});
});

describe("confirmQuickBooksTax deadline", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: true });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function deferred<T>() {
		let resolve!: (v: T) => void;
		const promise = new Promise<T>((r) => (resolve = r));
		return { promise, resolve };
	}

	it("gives up on a hung QuickBooks push at the deadline: unavailable and flagged", async () => {
		sdb.invoice.findFirst.mockResolvedValue(invoiceFixture());
		mockFn(pushInvoice).mockReturnValue(new Promise(() => {}));

		const pending = confirmQuickBooksTax("inv1", "org1");
		await vi.advanceTimersByTimeAsync(QB_CONFIRM_DEADLINE_MS - 1);
		expect(sdb.invoice.update).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		expect(await pending).toEqual({ status: "unavailable", reason: QB_UNAVAILABLE_REASON });
		const data = mockFn(sdb.invoice.update).mock.calls.at(-1)![0].data;
		expect(data).toMatchObject({ qb_sync_status: "failed", tax_needs_review: true });
	});

	it("bounds a hung tax-preference read too", async () => {
		sdb.invoice.findFirst.mockResolvedValue(invoiceFixture());
		mockFn(getQBTaxPrefs).mockReturnValue(new Promise(() => {}));

		const pending = confirmQuickBooksTax("inv1", "org1");
		await vi.advanceTimersByTimeAsync(QB_CONFIRM_DEADLINE_MS);

		expect((await pending).status).toBe("unavailable");
		expect(pushInvoice).not.toHaveBeenCalled();
	});

	it("a push that returns after the deadline writes nothing", async () => {
		const inv = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValue(inv);
		const late = deferred<unknown>();
		mockFn(pushInvoice).mockReturnValue(late.promise);

		const pending = confirmQuickBooksTax("inv1", "org1");
		await vi.advanceTimersByTimeAsync(QB_CONFIRM_DEADLINE_MS);
		expect((await pending).status).toBe("unavailable");
		const writesAtDeadline = mockFn(sdb.invoice.update).mock.calls.length;
		const txAtDeadline = mockFn(sdb.$transaction).mock.calls.length;

		late.resolve({ qbTaxCents: 610, fingerprint: fingerprintOf(inv), automatedSalesTax: true, mismatch: true });
		await vi.runAllTimersAsync();

		expect(mockFn(sdb.invoice.update).mock.calls).toHaveLength(writesAtDeadline);
		expect(mockFn(sdb.$transaction).mock.calls).toHaveLength(txAtDeadline);
		expect(lastUpdateData()).toBeUndefined();
		expect(pushInvoice).toHaveBeenCalledTimes(1);
	});

	it("an adoption still waiting on the row lock at the deadline backs out under the lock", async () => {
		const inv = invoiceFixture();
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 610);
		const lock = deferred<unknown[]>();
		mockFn(sdb.$queryRaw).mockReturnValueOnce(lock.promise);

		const pending = confirmQuickBooksTax("inv1", "org1");
		await vi.advanceTimersByTimeAsync(QB_CONFIRM_DEADLINE_MS);
		expect((await pending).status).toBe("unavailable");
		const writesAtDeadline = mockFn(sdb.invoice.update).mock.calls.length;

		lock.resolve([]);
		await vi.runAllTimersAsync();

		expect(mockFn(sdb.invoice.update).mock.calls).toHaveLength(writesAtDeadline);
		expect(lastUpdateData()).toBeUndefined();
	});

	it("takes the row lock before flagging unavailable", async () => {
		sdb.invoice.findFirst.mockResolvedValue(invoiceFixture());
		mockFn(pushInvoice).mockRejectedValue(new Error("503"));

		await confirmQuickBooksTax("inv1", "org1");

		const lockOrder = mockFn(sdb.$queryRaw).mock.invocationCallOrder[0];
		const writeOrder = mockFn(sdb.invoice.update).mock.invocationCallOrder.at(-1)!;
		expect(lockOrder).toBeLessThan(writeOrder);
		expect(mockFn(sdb.$queryRaw).mock.calls[0][0].join("?")).toMatch(/FOR UPDATE/);
	});
});

describe("confirmQuickBooksTax $0 block", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(getQBTaxPrefs).mockResolvedValue({ automatedSalesTax: true });
	});

	it("names the taxable stand-in for a hand-typed taxable line", async () => {
		const inv = invoiceFixture({ line_items: [line({ id: "l1" })] });
		sdb.invoice.findFirst.mockResolvedValue(inv);
		sdb.organization.findUnique.mockResolvedValueOnce({
			qb_taxable_item_id: "88",
			qb_taxable_item_realm_id: "realm1",
		});
		const { lines, shipAddr, clientExempt } = buildInvoicePayload(inv, {
			id: "88",
			name: TAXABLE_ITEM_NAME,
		});
		mockFn(pushInvoice).mockResolvedValue({
			qbTaxCents: 0,
			fingerprint: qbPushFingerprint(lines, shipAddr, clientExempt),
			automatedSalesTax: true,
			mismatch: true,
		});

		const result = await confirmQuickBooksTax("inv1", "org1");

		expect(result.status).toBe("zero_blocked");
		expect(result.items).toEqual([TAXABLE_ITEM_NAME]);
	});

	it("QB $0 with taxable lines → zero_blocked, no adoption", async () => {
		const inv = invoiceFixture({ line_items: [line({ id: "l1" })] });
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 0);

		const result = await confirmQuickBooksTax("inv1", "org1");

		expect(result).toEqual({
			status: "zero_blocked",
			qbTaxCents: 0,
			oursCents: 550,
			items: ["Services"],
			lineIds: ["l1"],
		});
		expect(lastUpdateData()).toBeUndefined();
	});

	it("QB $0 with all lines exempt → adopted", async () => {
		const inv = invoiceFixture(
			{ line_items: [line({ id: "l1", taxable: false, tax_group_id: null, tax_amount: "0" })] },
			{ total_tax_cents: 0, groups: [], total_cents: 10000 },
		);
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 0);

		const result = await confirmQuickBooksTax("inv1", "org1");

		expect(result.status).toBe("adopted");
		expect(lastUpdateData()).toMatchObject({ tax_source: "qb_ast", tax_amount: 0 });
	});

	it("refusal lists QB item names", async () => {
		const mapped = line({
			id: "l1",
			inventory_item: { name: "Air Filter 16x25", external_mappings: [{ external_id: "19" }] },
		});
		const exempt = line({
			id: "l3",
			name: "Duct cleaning",
			taxable: false,
			tax_group_id: null,
			tax_amount: "0",
		});
		const inv = invoiceFixture({ line_items: [mapped, line({ id: "l2" }), exempt, line({ id: "l4" })] });
		sdb.invoice.findFirst.mockResolvedValue(inv);
		pushReturns(inv, 0);

		const result = await confirmQuickBooksTax("inv1", "org1");

		expect(result.items).toEqual(["Air Filter 16x25", "Services"]);
		expect(result.lineIds).toEqual(["l1", "l2", "l4"]);
	});
});
