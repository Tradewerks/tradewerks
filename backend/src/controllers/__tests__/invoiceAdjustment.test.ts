import { describe, it, expect, vi, beforeEach } from "vitest";

// Built via vi.hoisted (not a plain module-scope require, which vitest's ESM mock
// factories can't resolve) so both the db.js and lib/context.js mocks below share
// the exact same mock instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		invoice: {
			findFirst: vi.fn(),
			update: vi.fn(),
			create: vi.fn(),
			findMany: vi.fn(),
			// The over-crediting ceiling sums the adjustment chain; the
			// Revise & Resend guard counts it.
			aggregate: vi.fn(async () => ({ _sum: { total: 0 } })),
			count: vi.fn(async () => 0),
		},
		invoice_line_item: { findMany: vi.fn(), createMany: vi.fn() },
		// Attribution reads the root's billed jobs and visits; none by default.
		invoice_job: {
			findMany: vi.fn(async () => []),
			updateMany: vi.fn(),
			update: vi.fn(),
		},
		invoice_visit: {
			findMany: vi.fn(async () => []),
			updateMany: vi.fn(),
			update: vi.fn(),
		},
		invoice_note: {
			findMany: vi.fn(async () => []),
			createMany: vi.fn(),
		},
		document_dispute: {
			findFirst: vi.fn(),
			create: vi.fn(),
			update: vi.fn(),
			updateMany: vi.fn(),
		},
		tax_group: { findMany: vi.fn(async () => []) },
		inventory_item: { findMany: vi.fn(async () => []) },
		$executeRaw: vi.fn(),
		// SELECT ... FOR UPDATE on the original, taken before the chain is read.
		$queryRaw: vi.fn(async () => []),
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateInvoiceNumber: vi.fn(async () => "INV-1040"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

// The real recompute needs tax groups, the client row and the persisted lines;
// it is covered by the tax engine's own suite. What matters here is that the
// adjustment is taxed at all rather than shipping a hardcoded zero.
vi.mock("../../services/invoiceService.js", () => ({
	syncBilledAmounts: vi.fn().mockResolvedValue(undefined),
	syncInvoicePaymentTotals: vi.fn().mockResolvedValue(undefined),
	lockInvoiceTaxSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { db } from "../../db.js";
import {
	lockInvoiceTaxSnapshot,
	syncBilledAmounts,
} from "../../services/invoiceService.js";
import { logActivity } from "../../services/logger.js";
import { createAdjustmentInvoice } from "../../services/invoiceAdjustment.js";
import { DocumentRuleError } from "../../lib/statusTransitions.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const original = {
	id: "inv1",
	invoice_number: "INV-1039",
	status: "Paid",
	organization_id: "org1",
	client_id: "c1",
	amount_paid: 500,
	total: 500,
	tax_rate: 0,
	payment_terms_days: 30,
	due_date: null,
	adjusts_invoice_id: null,
	line_items: [{ id: "il1" }],
};

describe("createAdjustmentInvoice", () => {
	beforeEach(() => vi.clearAllMocks());

	it("never writes to the original", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await createAdjustmentInvoice(
			db as never,
			original as never,
			[
				{
					name: "Credit: duplicate labour",
					quantity: -1,
					unit_price: 200,
					total: -200,
				},
			],
			"org1",
			{ dispatcherId: "d1" },
		);

		// Any write to the original here is a money bug. Its status is restored
		// by the caller, not by this function.
		expect(db.invoice.update).not.toHaveBeenCalled();
	});

	it("links to the original and totals the delta", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await createAdjustmentInvoice(
			db as never,
			original as never,
			[
				{
					name: "Credit: duplicate labour",
					quantity: -1,
					unit_price: 200,
					total: -200,
				},
				{
					name: "Correction: call-out fee",
					quantity: 1,
					unit_price: 50,
					total: 50,
				},
			],
			"org1",
			{ dispatcherId: "d1" },
		);

		const created = mockFn(db.invoice.create).mock.calls[0][0].data;
		expect(created.adjusts_invoice_id).toBe("inv1");
		expect(created.subtotal).toBe(-150);
		expect(created.status).toBe("Issued");
		// Never auto-pushed: a net-negative document is a credit memo in
		// QuickBooks terms, and exporting one is out of scope.
		expect(created.qb_sync_status).toBe("not_synced");
		expect(created.invoice_number).toBe("INV-1040");
		expect(created.memo).toBe("Adjusts INV-1039");
	});

	it("taxes the adjustment from its own lines instead of shipping a zero", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.tax_group.findMany).mockResolvedValueOnce([
			{ id: "11111111-1111-1111-1111-111111111111" },
		]);
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await createAdjustmentInvoice(
			db as never,
			original as never,
			[
				{
					name: "Credit: duplicate labour",
					quantity: -1,
					unit_price: 200,
					total: -200,
					taxable: true,
					tax_group_id: "11111111-1111-1111-1111-111111111111",
				},
			],
			"org1",
			{ dispatcherId: "d1" },
		);

		// A credit that omits tax makes the organisation over-remit.
		const lines = mockFn(db.invoice_line_item.createMany).mock.calls[0][0]
			.data;
		expect(lines[0].tax_group_id).toBe(
			"11111111-1111-1111-1111-111111111111",
		);
		expect(lines[0].taxable).toBe(true);
		expect(lockInvoiceTaxSnapshot).toHaveBeenCalledWith(
			"adj1",
			"org1",
			expect.anything(),
			expect.any(Date),
		);
		// The lock has to run after the lines exist, or it taxes nothing.
		const createManyOrder = mockFn(db.invoice_line_item.createMany).mock
			.invocationCallOrder[0];
		const lockOrder = mockFn(lockInvoiceTaxSnapshot).mock
			.invocationCallOrder[0];
		expect(lockOrder).toBeGreaterThan(createManyOrder);
	});

	it("pushes the credit into job profitability after the tax lock", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.invoice_job.findMany).mockResolvedValueOnce([
			{ job_id: "22222222-2222-2222-2222-222222222222" },
		]);
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await createAdjustmentInvoice(
			db as never,
			original as never,
			[
				{
					name: "Credit: duplicate labour",
					quantity: -1,
					unit_price: 200,
					total: -200,
					source_job_id: "22222222-2222-2222-2222-222222222222",
				},
			],
			"org1",
			{ dispatcherId: "d1" },
		);

		// Without this the credit never reaches the job's billed amount.
		// syncBilledAmounts resolves the chain root itself, so the
		// adjustment's own id is the right argument.
		expect(syncBilledAmounts).toHaveBeenCalledWith("adj1", expect.anything());
		// It has to follow the lock, which rewrites the line totals it sums.
		expect(
			mockFn(syncBilledAmounts).mock.invocationCallOrder[0],
		).toBeGreaterThan(
			mockFn(lockInvoiceTaxSnapshot).mock.invocationCallOrder[0],
		);
	});

	// Spec §12 makes the audit log the only mitigation for single-actor
	// repeal, so it must agree with the document it describes.
	it("logs the total actually written, not the provisional line sum", async () => {
		mockFn(db.invoice.findFirst)
			.mockResolvedValueOnce(original)
			.mockResolvedValueOnce({ total: -216.5 });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await createAdjustmentInvoice(
			db as never,
			original as never,
			[
				{
					name: "Credit: duplicate labour",
					quantity: -1,
					unit_price: 200,
					total: -200,
				},
			],
			"org1",
			{ dispatcherId: "d1" },
		);

		const entry = mockFn(logActivity).mock.calls[0][0];
		expect(entry.changes.total.new).toBe(-216.5);
	});

	// A net-positive adjustment is a bill; the AR report ages a null due_date
	// from created_at, so without the terms it gets no grace period at all.
	it("carries the original's payment terms and derives a due date", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});

		await createAdjustmentInvoice(
			db as never,
			original as never,
			[
				{
					name: "Correction: call-out fee",
					quantity: 1,
					unit_price: 50,
					total: 50,
				},
			],
			"org1",
			{ dispatcherId: "d1" },
		);

		const created = mockFn(db.invoice.create).mock.calls[0][0].data;
		expect(created.payment_terms_days).toBe(30);
		expect(created.due_date).toBeInstanceOf(Date);
		const days = Math.round(
			(created.due_date.getTime() - created.issue_date.getTime()) /
				86_400_000,
		);
		expect(days).toBe(30);
	});

	it("refuses to adjust an adjustment", async () => {
		const adjustment = { ...original, adjusts_invoice_id: "inv0" };
		mockFn(db.invoice.findFirst).mockResolvedValue(adjustment);

		await expect(
			createAdjustmentInvoice(
				db as never,
				adjustment as never,
				[{ name: "x", quantity: -1, unit_price: 1, total: -1 }],
				"org1",
				{ dispatcherId: "d1" },
			),
		).rejects.toThrow();
	});

	it("refuses an empty adjustment", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);

		await expect(
			createAdjustmentInvoice(db as never, original as never, [], "org1", {
				dispatcherId: "d1",
			}),
		).rejects.toThrow();
	});
});

/**
 * The over-crediting ceiling. NetSuite refuses a credit note larger than the
 * invoice, QuickBooks caps a credit at the original, Zuora ships it as the
 * "Available to credit validation" setting evaluated against the whole invoice,
 * and Oracle Receivables allows the excess only behind an explicit
 * "Allow overapplication" flag. It is cumulative in all of them, which is the
 * part a per-adjustment check would miss.
 */
describe("createAdjustmentInvoice over-crediting ceiling", () => {
	beforeEach(() => vi.clearAllMocks());

	/** `written.total` is read back after the tax lock; the chain sum includes it. */
	const arrange = (writtenTotal: number, chainTotal: number) => {
		mockFn(db.invoice.findFirst)
			// createAdjustmentInvoice's own read of the original
			.mockResolvedValueOnce(original)
			// the read-back of the row it just created
			.mockResolvedValueOnce({ total: writtenTotal });
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});
		mockFn(db.invoice.aggregate).mockResolvedValue({
			_sum: { total: chainTotal },
		});
	};

	const credit = (amount: number) => [
		{ name: "Credit", quantity: -1, unit_price: amount, total: -amount },
	];

	const run = () =>
		createAdjustmentInvoice(
			db as never,
			original as never,
			credit(100) as never,
			"org1",
			{ dispatcherId: "d1" },
		);

	it("allows a credit up to the original's full total", async () => {
		// $500 invoice, $500 of credit in the chain — exactly at the ceiling.
		arrange(-500, -500);
		await expect(run()).resolves.toBe("adj1");
	});

	// A money rule, not a fault: the dispute route answers 422 with the sentence
	// instead of paging on-call with a 500 (DW-11).
	it("refuses as a rule rather than a fault", async () => {
		arrange(-600, -600);
		await expect(run()).rejects.toBeInstanceOf(DocumentRuleError);
	});

	it("refuses a single credit larger than the original", async () => {
		arrange(-600, -600);
		await expect(run()).rejects.toThrow(/credit more than INV-1039/);
	});

	it("refuses the credit that tips a chain over the ceiling", async () => {
		// $400 already credited by an earlier adjustment, this one adds $200.
		// Each looks acceptable alone; together they exceed the $500 invoice.
		arrange(-200, -600);
		await expect(run()).rejects.toThrow(/at most 100.00 can still be credited/);
	});

	it("lets a positive adjustment offset earlier credit", async () => {
		// -$500 credited, +$100 re-billed: net -$400, back inside the ceiling.
		arrange(100, -400);
		await expect(run()).resolves.toBe("adj1");
	});

	// Billing more is a new charge, not over-crediting — uncapped everywhere.
	it("never caps a net-positive adjustment", async () => {
		arrange(5000, 5000);
		await expect(run()).resolves.toBe("adj1");
	});

	// A credit's balance is genuinely negative: the organisation owes it back.
	// Flooring it at zero made every credit invisible to receivables, which
	// filter on a non-zero balance, so AR kept reporting the original in full
	// while the revenue reports had already netted the credit.
	it("writes a negative balance_due on a credit, not a floored zero", async () => {
		arrange(-100, -100);
		await run();

		const created = mockFn(db.invoice.create).mock.calls[0][0].data;
		expect(created.total).toBeLessThan(0);
		expect(created.balance_due).toBe(created.total);
	});

	// "Void the adjustment first" (D1) must free the credit it held.
	it("leaves voided adjustments out of the ceiling", async () => {
		arrange(-100, -100);
		await run();

		expect(mockFn(db.invoice.aggregate).mock.calls[0][0].where).toEqual({
			adjusts_invoice_id: "inv1",
			status: { not: "Void" },
		});
	});

	it("locks the original before reading the chain", async () => {
		arrange(-100, -100);
		await run();

		const [strings, ...values] = mockFn(db.$queryRaw).mock.calls[0] as [
			TemplateStringsArray,
			...unknown[],
		];
		expect(strings.join("?")).toMatch(/FOR UPDATE/);
		// Org-scoped: $queryRaw bypasses getScopedDb's extension entirely.
		expect(values).toEqual(["inv1", "org1"]);
	});
});

/**
 * D4: every credit lands on a job, or job profitability keeps the pre-credit
 * revenue — syncBilledAmounts only sums lines whose source matches one of the
 * root's invoice_job / invoice_visit rows.
 */
describe("createAdjustmentInvoice attributes every credit to a job", () => {
	beforeEach(() => vi.clearAllMocks());

	const JOB_A = "33333333-3333-3333-3333-333333333333";
	const JOB_B = "44444444-4444-4444-4444-444444444444";
	const VISIT = "55555555-5555-5555-5555-555555555555";

	const credit = (over: Record<string, unknown> = {}) => [
		{ name: "Goodwill", quantity: -1, unit_price: 250, total: -250, ...over },
	];
	const arm = () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.invoice.create).mockResolvedValue({
			id: "adj1",
			invoice_number: "INV-1040",
		});
	};
	const run = (lines: unknown) =>
		createAdjustmentInvoice(db as never, original as never, lines as never, "org1", {
			dispatcherId: "d1",
		});
	const written = () =>
		mockFn(db.invoice_line_item.createMany).mock.calls[0][0].data;

	it("credits the only job the invoice bills when the line names none", async () => {
		arm();
		mockFn(db.invoice_job.findMany).mockResolvedValueOnce([{ job_id: JOB_A }]);

		await run(credit());

		expect(written()[0].source_job_id).toBe(JOB_A);
		expect(written()[0].source_visit_id).toBeNull();
	});

	it("credits the only visit, and its job, when that is all the invoice bills", async () => {
		arm();
		mockFn(db.invoice_visit.findMany).mockResolvedValueOnce([
			{ visit_id: VISIT, visit: { job_id: JOB_A } },
		]);

		await run(credit());

		expect(written()[0]).toMatchObject({
			source_visit_id: VISIT,
			source_job_id: JOB_A,
		});
	});

	it("refuses an unattributed line when the invoice bills several jobs", async () => {
		arm();
		mockFn(db.invoice_job.findMany).mockResolvedValueOnce([
			{ job_id: JOB_A },
			{ job_id: JOB_B },
		]);

		await expect(run(credit())).rejects.toThrow(/more than one job or visit/);
		expect(db.invoice.create).not.toHaveBeenCalled();
	});

	it("keeps the job a line names when the invoice bills several", async () => {
		arm();
		mockFn(db.invoice_job.findMany).mockResolvedValueOnce([
			{ job_id: JOB_A },
			{ job_id: JOB_B },
		]);

		await run(credit({ source_job_id: JOB_B }));

		expect(written()[0].source_job_id).toBe(JOB_B);
	});

	it("refuses a job the invoice does not bill", async () => {
		arm();
		mockFn(db.invoice_job.findMany).mockResolvedValueOnce([{ job_id: JOB_A }]);

		const attempt = run(credit({ source_job_id: JOB_B }));

		await expect(attempt).rejects.toBeInstanceOf(DocumentRuleError);
		await expect(attempt).rejects.toThrow(/job this invoice doesn't bill/);
	});

	it("leaves attribution empty when the invoice bills no job at all", async () => {
		arm();

		await run(credit());

		expect(written()[0].source_job_id).toBeNull();
		expect(written()[0].source_visit_id).toBeNull();
	});
});

// invoice_line_item is not org-scoped, so a foreign catalog id would sit on a
// real invoice line (DW-26).
describe("createAdjustmentInvoice keeps line references inside the organization", () => {
	beforeEach(() => vi.clearAllMocks());

	const FOREIGN = "66666666-6666-6666-6666-666666666666";

	it("refuses a tax group from another organization", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.tax_group.findMany).mockResolvedValueOnce([]);

		await expect(
			createAdjustmentInvoice(
				db as never,
				original as never,
				[{ name: "x", quantity: -1, unit_price: 5, total: -5, tax_group_id: FOREIGN }],
				"org1",
				{ dispatcherId: "d1" },
			),
		).rejects.toThrow(/unknown tax group/);
		expect(mockFn(db.tax_group.findMany).mock.calls[0][0].where).toEqual({
			id: { in: [FOREIGN] },
			organization_id: "org1",
		});
		expect(db.invoice.create).not.toHaveBeenCalled();
	});

	it("refuses an inventory item from another organization", async () => {
		mockFn(db.invoice.findFirst).mockResolvedValue(original);
		mockFn(db.inventory_item.findMany).mockResolvedValueOnce([]);

		await expect(
			createAdjustmentInvoice(
				db as never,
				original as never,
				[{ name: "x", quantity: -1, unit_price: 5, total: -5, inventory_item_id: FOREIGN }],
				"org1",
				{ dispatcherId: "d1" },
			),
		).rejects.toThrow(/unknown inventory item/);
		expect(db.invoice.create).not.toHaveBeenCalled();
	});
});
