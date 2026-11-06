/**
 * The gates that make a reimbursement defensible: per-line verification, allocations
 * accounting for the whole receipt, over-limit routed to pre-authorization, one
 * receipt image per purchase, purchaser never approver, and stock moving only for
 * lines that said they were going into stock.
 */
import { createHash } from "node:crypto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import { db } from "../../db.js";
import { SAMPLE_RECEIPT } from "../../services/receiptOcr/fixture.js";
import { OCR_MAX_BYTES } from "../../services/receiptOcr/normalize.js";
import {
	createRefund,
	decidePreauth,
	deletePurchase,
	getCaptureLocation,
	getPurchase,
	getPurchaseExtraction,
	replaceLines,
	requestPreauth,
	retryOcr,
	reviewPurchase,
	runReceiptOcr,
	secondSignoff,
	settleRefund,
	submitPurchase,
	uploadReceipt,
} from "../fieldPurchasesController.js";

// Module gating is not under test here: every module reads as on.
vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(async () => true),
	getEntitlements: vi.fn(),
}));

vi.mock("../../db.js", () => {
	const $extends = vi.fn();
	const mockDb = {
		field_purchase: {
			findFirst: vi.fn(),
			findMany: vi.fn(),
			update: vi.fn(),
			delete: vi.fn(),
			create: vi.fn(),
		},
		field_purchase_grant: { findFirst: vi.fn() },
		field_purchase_line: { findMany: vi.fn() },
		technician: { findFirst: vi.fn() },
		dispatcher: { findFirst: vi.fn() },
		field_purchase_event: { findMany: vi.fn(), create: vi.fn() },
		organization: { findFirst: vi.fn() },
		inventory_item: { findMany: vi.fn() },
		vehicle: { findMany: vi.fn() },
		supplier: { findFirst: vi.fn(), findMany: vi.fn() },
		field_purchase_job_allocation: { findMany: vi.fn() },
		job: { findMany: vi.fn() },
		job_visit: { findMany: vi.fn() },
		$transaction: vi.fn(),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { db: mockDb };
});

vi.mock("../../lib/context.js", async () => {
	const { db } = await import("../../db.js");
	return { getScopedDb: () => db };
});

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockRecordMovements = vi.fn().mockResolvedValue({ lowStockItemIds: [], movementIds: [] });
vi.mock("../../services/stockMovements.js", () => ({
	recordMovements: (...args: unknown[]) => mockRecordMovements(...args),
}));

const mockUploadFile = vi.fn().mockResolvedValue("https://bucket/receipts/r.jpg");
const mockGetBuffer = vi.fn();
vi.mock("../../services/wasabiService.js", () => ({
	uploadFile: (...args: unknown[]) => mockUploadFile(...args),
	getBuffer: (...args: unknown[]) => mockGetBuffer(...args),
	isOwnBucketUrl: () => true,
	signImageUrl: async (url: string | null) => (url ? `${url}?signed=1` : null),
}));

const mockExtract = vi.fn();
const mockProvider = vi.fn<() => { name: string; extract: unknown } | null>(() => null);
vi.mock("../../services/receiptOcr/index.js", async () => {
	// normalize.js is unmocked, so its real constants (OCR_MAX_BYTES included)
	// pass through rather than needing to be duplicated here.
	const normalize = await import("../../services/receiptOcr/normalize.js");
	return { ...normalize, getReceiptOcrProvider: () => mockProvider() };
});

vi.mock("../../services/socketService.js", () => ({
	emitToOrg: vi.fn(),
	emitInventoryUpdated: vi.fn(),
}));

const mockRecomputeVisitTotals = vi.fn().mockResolvedValue(true);
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeVisitTotals: (...args: unknown[]) => mockRecomputeVisitTotals(...args),
}));

const mockNotify = vi.fn().mockResolvedValue(undefined);
vi.mock("../notificationsController.js", () => ({
	createNotification: (...args: unknown[]) => mockNotify(...args),
	notifyDispatchers: vi.fn().mockResolvedValue([]),
}));

const mockConsume = vi.fn();
vi.mock("../../lib/entitlements/quota.js", () => ({
	consumeQuota: (...args: unknown[]) => mockConsume(...args),
}));

const ORG = "org-1";
const TECH = "tech-1";
const DISPATCHER = "disp-1";
const PURCHASE = "fp-1";
const ITEM_UUID = "11111111-1111-4111-8111-111111111111";
const VEHICLE_UUID = "22222222-2222-4222-8222-222222222222";
/** Another crew's van: in the org, and still not this technician's to stock. */
const OTHER_VEHICLE_UUID = "33333333-3333-4333-8333-333333333333";
const PARENT_UUID = "33333333-3333-4333-8333-333333333333";
const JOB_UUID = "44444444-4444-4444-8444-444444444444";
/** A job a sheet's own `allocations` rewrite adds, replacing JOB_UUID. */
const NEW_JOB_UUID = "55555555-5555-4555-8555-555555555555";
const mockDb = vi.mocked(db);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tx: any = {
	field_purchase: {
		update: vi.fn(),
		updateMany: vi.fn(),
		findUniqueOrThrow: vi.fn(),
		findFirst: vi.fn(),
		create: vi.fn(),
	},
	field_purchase_line: {
		deleteMany: vi.fn(),
		create: vi.fn(),
		createMany: vi.fn(),
		findMany: vi.fn().mockResolvedValue([]),
		update: vi.fn(),
		updateMany: vi.fn(),
	},
	field_purchase_job_allocation: {
		deleteMany: vi.fn(),
		createMany: vi.fn(),
		findMany: vi.fn(),
		upsert: vi.fn(),
		update: vi.fn(),
	},
	job_visit_line_item: { deleteMany: vi.fn(), create: vi.fn(), update: vi.fn() },
	field_purchase_event: { create: vi.fn() },
	inventory_item: { findFirst: vi.fn(), create: vi.fn() },
};

type Line = {
	id: string;
	line_total?: number;
	verified_at?: Date | null;
	quantity?: number;
	unit_price?: number;
	inventory_item_id?: string | null;
	disposition?: "receive" | "non_stock" | null;
	disposition_vehicle_id?: string | null;
	/** Which job's share the line is. Null is a line nobody claimed. */
	allocation_id?: string | null;
	visit_line_item_id?: string | null;
	visit_line_item?: { visit_id: string } | null;
	inventory_item?: { name: string; unit_price: number; taxable: boolean } | null;
	allocation?: { job_visit_id: string | null } | null;
};

function purchase(
	over: Record<string, unknown> = {},
	lines: Line[] = [],
	allocations: { job_id: string; job_visit_id?: string | null; amount?: number }[] = [
		{ job_id: "job-a", amount: 100 },
	],
) {
	return {
		id: PURCHASE,
		status: "draft",
		technician_id: TECH,
		supplier_id: null,
		total: 100,
		tax_amount: 0,
		estimated_amount: null,
		purchased_at: new Date("2026-08-21T15:00:00Z"),
		receipt_image_url: "https://bucket/receipts/r.jpg",
		capture_lat: 43.07,
		lines,
		allocations,
		...over,
	};
}

/**
 * A refund reversal reads the parent's intake and what earlier refunds returned, both
 * off field_purchase_line. The parent read is the one keyed by field_purchase_id.
 */
function parentIntake(
	intake: { inventory_item_id: string; disposition_vehicle_id: string | null; quantity: number }[],
	alreadyReturned: { inventory_item_id: string; quantity: number }[] = [],
) {
	tx.field_purchase_line.findMany.mockImplementation(
		async (args: { where: Record<string, unknown> }) =>
			"field_purchase_id" in args.where ? intake : alreadyReturned,
	);
}

const verified = (over: Partial<Line> = {}): Line => ({
	id: "line-1",
	line_total: 100,
	verified_at: new Date("2026-08-21T15:01:00Z"),
	allocation_id: "alloc-a",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	mockConsume.mockResolvedValue({ allowed: true, used: 1, limit: null });
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.$transaction.mockImplementation(async (cb: any) => cb(tx));
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	mockDb.organization.findFirst.mockResolvedValue({ timezone: "America/Chicago" } as any);
	mockDb.field_purchase_grant.findFirst.mockResolvedValue({
		id: "grant-1",
		is_active: true,
		per_transaction_limit: 500,
		daily_limit: null,
		weekly_limit: null,
		per_job_limit: null,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any);
	mockDb.field_purchase.findFirst.mockResolvedValue(null);
	// findMany on field_purchase is the counted-spend read.
	mockDb.field_purchase.findMany.mockResolvedValue([]);
	mockDb.job_visit.findMany.mockResolvedValue([]);
	// assertAllocationsInOrg's job check. A sheet's total can rewrite a single-job
	// purchase's allocation, which walks this path even on tests that never call
	// updatePurchase directly.
	mockDb.job.findMany.mockResolvedValue([{ id: JOB_UUID }] as never);
	tx.field_purchase.update.mockResolvedValue({ id: PURCHASE });
	// Every decision claims its row first; count 0 is the lost-race branch.
	tx.field_purchase.updateMany.mockResolvedValue({ count: 1 });
	// Read back inside the transaction by both derivations: the shares from the
	// lines, and the billing from the lines' own allocations.
	tx.field_purchase.findUniqueOrThrow.mockResolvedValue({
		id: PURCHASE,
		kind: "purchase",
		tax_amount: 0,
		allocations: [],
		lines: [],
	});
	tx.field_purchase_line.findMany.mockResolvedValue([]);
	// The receipt covers one job unless a test says otherwise, which is what lets
	// `settleAllocations` hand every line the only job there is.
	tx.field_purchase_job_allocation.findMany.mockResolvedValue([{ id: "alloc-a" }]);
	mockDb.field_purchase_job_allocation.findMany.mockResolvedValue([
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		{ id: "alloc-a", job_id: "job-a" } as any,
	]);
	// Separation of duties compares the two accounts' login addresses, since a
	// technician id and a dispatcher id can never be equal.
	mockDb.technician.findFirst.mockResolvedValue({ email: "tech@example.test" } as never);
	mockDb.dispatcher.findFirst.mockResolvedValue({ email: "disp@example.test" } as never);
	// No supplier resolves by default; tests that care about a phone match set this themselves.
	mockDb.supplier.findMany.mockResolvedValue([]);
});

describe("submit gates", () => {
	it("refuses while any line is unverified", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({}, [verified(), verified({ id: "line-2", verified_at: null })]) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBe("Verify every line before submitting (1 left)");
		expect(tx.field_purchase.update).not.toHaveBeenCalled();
	});

	it("refuses without a receipt image", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({ receipt_image_url: null }, [verified()]) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBe("A receipt image is required");
	});

	// The line split IS the billing split, so a line nobody claimed is money that
	// bills no customer and counts towards no job's share.
	it("refuses a split receipt while a line names no job", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{},
				[verified(), verified({ id: "line-2", allocation_id: null })],
				[
					{ job_id: "job-a", job_visit_id: "visit-a" },
					{ job_id: "job-b", job_visit_id: "visit-b" },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				],
			) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBe("Say which job each line was for (1 left)");
		expect(tx.field_purchase.update).not.toHaveBeenCalled();
	});

	it("refuses a purchase allocated to no job at all", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({}, [verified()], []) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toMatch(/at least one job allocation/);
	});

	it("sends an over-limit purchase to pre-authorization instead of accepting it", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ total: 900 }, [verified({ line_total: 900 })], [
				{ job_id: "job-a", amount: 900 },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			]) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toMatch(/exceeds your limit \(per_transaction\)/);
	});

	// The dispatcher already said yes to a bigger number; asking again would
	// strand a tech who has already paid.
	it("accepts the same over-limit purchase once it carries a pre-authorization", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{ total: 900, status: "preauth_approved", estimated_amount: 800 },
				[verified({ line_total: 900 })],
				[{ job_id: "job-a", amount: 900 }],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBeUndefined();
		expect(res.flags!.map((f) => f.code)).toContain("over_estimate");
		expect(tx.field_purchase.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "pending_review" }) }),
		);
	});

	it("refuses to submit somebody else's purchase", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.field_purchase.findFirst.mockResolvedValue(purchase({}, [verified()]) as any);
		const res = await submitPurchase(ORG, PURCHASE, { techId: "tech-2" });
		expect(res.err).toMatch(/only submit your own/);
	});

	it("carries the advisory flags onto the row for the reviewer", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({ capture_lat: null }, [verified({ line_total: 70 })]) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBeUndefined();
		expect(res.flags!.map((f) => f.code).sort()).toEqual(["geo_missing", "total_mismatch"]);
	});

	// document_type/currency live only on the OCR extraction, not on a column, so
	// evaluateFlags cannot recompute this flag - the row's stored copy has to
	// survive the rewrite or a dispatcher never sees it.
	it("carries an OCR-written not_a_receipt flag through the submit rebuild", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{
					flags: [
						{ code: "not_a_receipt", message: "The image reads as a bank statement, not a receipt" },
					],
				},
				[verified()],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBeUndefined();
		expect(res.flags!.filter((f) => f.code === "not_a_receipt")).toHaveLength(1);
	});

	it("does not duplicate a carried flag across a resubmit", async () => {
		const stored = {
			code: "not_a_receipt" as const,
			message: "The image reads as a bank statement, not a receipt",
		};
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({ flags: [stored] }, [verified()]) as any,
		);
		const first = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(first.flags!.filter((f) => f.code === "not_a_receipt")).toHaveLength(1);

		// A real resubmit reads back whatever the first submit wrote, not the
		// original single-flag row.
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({ flags: first.flags }, [verified()]) as any,
		);
		const second = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(second.flags!.filter((f) => f.code === "not_a_receipt")).toHaveLength(1);
	});

	// The receipt was already submitted once, so the money is spent and the ceiling
	// prevented nothing. Asking for permission after the fact would leave the
	// technician unable to answer the query the dispatcher raised.
	it("accepts an over-limit resubmit from queried and flags the breach", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ total: 900, status: "queried" }, [verified({ line_total: 900 })], [
				{ job_id: "job-a", amount: 900 },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			]) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBeUndefined();
		expect(res.flags!.map((f) => f.code)).toContain("limit_breach");
		expect(res.flags!.find((f) => f.code === "limit_breach")!.message).toContain(
			"per_transaction",
		);
		expect(tx.field_purchase.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "pending_review" }) }),
		);
	});

	// The widened gate is per-status, not a general amnesty: a first submit over
	// the ceiling still needs a dispatcher's yes before the money is spent.
	it("still refuses an over-limit first submit from draft", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ total: 900, status: "draft" }, [verified({ line_total: 900 })], [
				{ job_id: "job-a", amount: 900 },
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			]) as any,
		);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toMatch(/exceeds your limit \(per_transaction\)/);
		expect(tx.field_purchase.update).not.toHaveBeenCalled();
	});
});

describe("pre-authorization decisions", () => {
	const awaiting = () =>
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		purchase({ status: "pending_preauth", estimated_amount: 800, total: 0 }) as any;

	const samePerson = () => {
		mockDb.technician.findFirst.mockResolvedValue({ email: "Solo.Op@example.test" } as never);
		mockDb.dispatcher.findFirst.mockResolvedValue({ email: "solo.op@example.test" } as never);
	};

	it("refuses when the approver is the purchaser", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(awaiting());
		samePerson();
		const res = await decidePreauth(
			ORG,
			PURCHASE,
			{ approve: true, note: null },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBe("You cannot approve your own pre-authorization");
		expect(tx.field_purchase.updateMany).not.toHaveBeenCalled();
		expect(tx.field_purchase.update).not.toHaveBeenCalled();
	});

	// The check is about who decides, not which way they decided.
	it("refuses a self-approved denial too", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(awaiting());
		samePerson();
		const res = await decidePreauth(
			ORG,
			PURCHASE,
			{ approve: false, note: "no" },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBe("You cannot approve your own pre-authorization");
		expect(tx.field_purchase.updateMany).not.toHaveBeenCalled();
	});

	it("approves for a different dispatcher", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(awaiting());
		const res = await decidePreauth(
			ORG,
			PURCHASE,
			{ approve: true, note: null },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBeUndefined();
		expect(tx.field_purchase.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "preauth_approved" }),
			}),
		);
	});

	// The whole point of the guard: the ceiling a self-approval would have lifted.
	it("cannot bypass a windowed limit by pre-approving its own purchase", async () => {
		const overLimit = purchase(
			{ status: "pending_preauth", estimated_amount: 900, total: 900 },
			[verified({ line_total: 900 })],
			[{ job_id: "job-a", amount: 900 }],
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		) as any;
		mockDb.field_purchase.findFirst.mockResolvedValue(overLimit);
		samePerson();

		const decided = await decidePreauth(
			ORG,
			PURCHASE,
			{ approve: true, note: null },
			{ dispatcherId: DISPATCHER },
		);
		expect(decided.err).toBe("You cannot approve your own pre-authorization");

		// Still pending_preauth, so the over-limit submit has no pre-authorization
		// to lean on and the money never moves.
		const submitted = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(submitted.err).toBeTruthy();
		expect(tx.field_purchase.update).not.toHaveBeenCalled();
	});
});

describe("requestPreauth", () => {
	it("refuses pre-authorization on a refund, which has no purchase to authorize", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ kind: "refund", parent_purchase_id: "parent" }) as never,
		);
		const result = await requestPreauth(
			ORG,
			PURCHASE,
			{ estimated_amount: 120 },
			{ techId: TECH },
		);
		expect(result.err).toBe("A refund does not need pre-authorization — the money is coming back");
		expect(tx.field_purchase.update).not.toHaveBeenCalled();
		expect(tx.field_purchase_job_allocation.update).not.toHaveBeenCalled();
	});

	it("saves the sheet the technician typed before switching to pre-authorization", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({}, [], [{ job_id: JOB_UUID, amount: 100 }]) as never,
		);
		const sheet = {
			vendor_name: "Kelley Supply",
			total: 412.5,
			lines: [
				{ description: "Blower motor", quantity: 1, unit_price: 412.5, acknowledged: true },
			],
		};
		const result = await requestPreauth(
			ORG,
			PURCHASE,
			{ estimated_amount: 412.5, reason: null, sheet },
			{ techId: TECH },
		);
		expect(result.err).toBeUndefined();
		// applySheet's header write, through the same updatePurchase a direct edit uses.
		expect(tx.field_purchase.update).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: PURCHASE },
				data: expect.objectContaining({ vendor_name: "Kelley Supply" }),
			}),
		);
		// applySheet's line write, through the same replaceLines a direct edit uses.
		expect(tx.field_purchase_line.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ description: "Blower motor" }) }),
		);
	});

	// Pins the ordering in the brief: applySheet has to run before the allocations
	// this function reads to compute shares, or the shares are spread across the
	// purchase's stale job list instead of the sheet's. A dollar figure alone
	// cannot show this (updatePurchaseSchema's allocationSchema carries no amount,
	// so `sheet.total` never reaches the allocation write directly) - what proves
	// the order is which allocation ROW the write lands on. The mocked read is
	// wired to only see the rewritten job once the upsert that rewrites it has
	// actually run, so a regressed ordering targets the stale row and this fails.
	it("computes shares from the sheet's rewritten allocations, not the stale ones", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({}, [], [{ job_id: JOB_UUID, amount: 100 }]) as never,
		);
		mockDb.job.findMany.mockResolvedValueOnce([{ id: NEW_JOB_UUID }] as never);

		let rewritten = false;
		tx.field_purchase_job_allocation.upsert.mockImplementationOnce(async () => {
			rewritten = true;
			return {};
		});
		mockDb.field_purchase_job_allocation.findMany.mockImplementationOnce(async () =>
			rewritten
				? [{ id: "alloc-new", job_id: NEW_JOB_UUID }]
				: [{ id: "alloc-a", job_id: JOB_UUID }],
		);

		const result = await requestPreauth(
			ORG,
			PURCHASE,
			{
				estimated_amount: 500,
				reason: null,
				sheet: { allocations: [{ job_id: NEW_JOB_UUID }] },
			},
			{ techId: TECH },
		);

		expect(result.err).toBeUndefined();
		expect(tx.field_purchase_job_allocation.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "alloc-new" } }),
		);
		// Amount is a Prisma.Decimal, not a plain number, so it is read back and
		// stringified rather than matched with a literal 500 in the matcher above.
		const [[call]] = tx.field_purchase_job_allocation.update.mock.calls;
		expect(String(call.data.amount)).toBe("500");
	});
});

describe("receipt upload", () => {
	const file = {
		buffer: Buffer.from("receipt-bytes"),
		mimetype: "image/jpeg",
		originalname: "r.jpg",
	};

	it("stores the image and stamps the capture metadata", async () => {
		mockDb.field_purchase.findFirst
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.mockResolvedValueOnce(purchase() as any) // loadEditable
			.mockResolvedValueOnce(null); // no hash clash
		const res = await uploadReceipt(
			ORG,
			PURCHASE,
			file,
			{ capture_lat: "43.07", capture_lng: "-89.4" },
			{ techId: TECH },
		);
		expect(res.err).toBeUndefined();
		expect(mockUploadFile).toHaveBeenCalledWith(file.buffer, "image/jpeg", "r.jpg", "receipts");
		expect(tx.field_purchase.update.mock.calls[0][0].data).toMatchObject({
			receipt_image_url: "https://bucket/receipts/r.jpg",
			capture_lat: 43.07,
		});
	});

	// The receipt is the only proof a reimbursement has, so the same bytes can
	// never back two purchases.
	it("rejects an image already attached to another purchase", async () => {
		mockDb.field_purchase.findFirst
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.mockResolvedValueOnce(purchase() as any)
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.mockResolvedValueOnce({ id: "fp-old", technician: { name: "Dana" } } as any);
		const res = await uploadReceipt(ORG, PURCHASE, file, {}, { techId: TECH });
		expect(res.err).toBe("This receipt image has already been submitted (Dana)");
		expect(mockUploadFile).not.toHaveBeenCalled();
	});

	it("requires a file at all", async () => {
		const res = await uploadReceipt(ORG, PURCHASE, undefined, {}, { techId: TECH });
		expect(res.err).toMatch(/receipt image is required/);
	});

	// Mindee bills per page: re-uploading the same bytes to the same purchase
	// after it already read successfully is the "did that go through?" retry,
	// not a new receipt, and must not pay for a second, identical extraction.
	it("does not re-extract an image the purchase has already read", async () => {
		const hash = createHash("sha256").update(file.buffer).digest("hex");
		mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce(
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				purchase({ receipt_image_hash: hash, ocr_status: "succeeded" }) as any,
			) // loadEditable
			.mockResolvedValueOnce(null); // no cross-purchase clash

		const res = await uploadReceipt(ORG, PURCHASE, file, {}, { techId: TECH });

		expect(res.err).toBeUndefined();
		expect(mockExtract).not.toHaveBeenCalled();
		// The re-read status must resolve to something other than "pending" -
		// otherwise a skipped extraction leaves the row stuck forever.
		expect(tx.field_purchase.update.mock.calls[0][0].data.ocr_status).toBe("succeeded");
		expect(mockConsume).not.toHaveBeenCalled();
	});

	describe("receipt scan meter", () => {
		const loadFresh = () =>
			mockDb.field_purchase.findFirst
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.mockResolvedValueOnce(purchase() as any) // loadEditable
				.mockResolvedValueOnce(null); // no hash clash

		it("charges one scan and starts the read", async () => {
			mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
			mockExtract.mockReturnValue(new Promise(() => {}));
			loadFresh();
			const res = await uploadReceipt(ORG, PURCHASE, file, {}, { techId: TECH });
			expect(res.err).toBeUndefined();
			expect(mockConsume).toHaveBeenCalledWith(ORG, "receipt_scans_month");
			expect(tx.field_purchase.update.mock.calls[0][0].data.ocr_status).toBe("pending");
		});

		it("keeps the receipt but skips the read once the month's scans are used up", async () => {
			mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
			mockConsume.mockResolvedValue({ allowed: false, used: 300, limit: 300 });
			loadFresh();
			const res = await uploadReceipt(ORG, PURCHASE, file, {}, { techId: TECH });
			expect(res.err).toBeUndefined();
			const data = tx.field_purchase.update.mock.calls[0][0].data;
			expect(data.receipt_image_url).toBe("https://bucket/receipts/r.jpg");
			expect(data.ocr_status).toBe("skipped");
			expect(data.ocr_error).toBe(
				"This month's receipt scans are used up. Enter the lines by hand; scanning resumes on the 1st (UTC).",
			);
			await new Promise((r) => setTimeout(r, 0));
			expect(mockExtract).not.toHaveBeenCalled();
		});

		it("charges nothing when no reader is configured", async () => {
			mockProvider.mockReturnValue(null);
			loadFresh();
			await uploadReceipt(ORG, PURCHASE, file, {}, { techId: TECH });
			expect(mockConsume).not.toHaveBeenCalled();
		});

		it("charges nothing for an image too large to read", async () => {
			mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
			mockDb.field_purchase.update.mockResolvedValue({} as never); // the "too large" failure stamp
			loadFresh();
			const big = { ...file, buffer: Buffer.alloc(16 * 1024 * 1024) };
			await uploadReceipt(ORG, PURCHASE, big, {}, { techId: TECH });
			expect(mockConsume).not.toHaveBeenCalled();
		});

		it("charges nothing for a receipt already on another purchase", async () => {
			mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
			mockDb.field_purchase.findFirst
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.mockResolvedValueOnce(purchase() as any)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				.mockResolvedValueOnce({ id: "fp-old", technician: { name: "Dana" } } as any);
			await uploadReceipt(ORG, PURCHASE, file, {}, { techId: TECH });
			expect(mockConsume).not.toHaveBeenCalled();
		});
	});
});

describe("line entry", () => {
	beforeEach(() => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.field_purchase.findFirst.mockResolvedValue(purchase() as any);
		mockDb.inventory_item.findMany.mockResolvedValue([{ id: ITEM_UUID }]);
		mockDb.vehicle.findMany.mockResolvedValue([{ id: VEHICLE_UUID }]);
		// The truck this technician is signed onto, which is the only one their
		// lines may stock.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.technician.findFirst.mockResolvedValue({ current_vehicle_id: VEHICLE_UUID } as any);
	});

	// Stock has to move a catalog row, but mapping is optional by spec, so an
	// unmapped `receive` line gets a provisional row rather than a refusal. The
	// reconcile queue is what merges it into the real item later.
	it("provisions a catalog row for an unmapped `receive` line", async () => {
		tx.inventory_item.findFirst.mockResolvedValue(null);
		tx.inventory_item.create.mockResolvedValue({ id: "provisional-1" });

		const res = await replaceLines(
			ORG,
			PURCHASE,
			{ lines: [{ description: "Fitting", quantity: 1, unit_price: 10, disposition: "receive" }] },
			{ techId: TECH },
		);

		expect(res.err).toBeUndefined();
		expect(tx.inventory_item.create.mock.calls[0][0].data).toMatchObject({
			name: "Fitting",
			cost: 10,
			provisional: true,
			// Not tech_submission: the reconcile queue filters on this, and it is how
			// a row says which receipt it came off.
			origin: "field_purchase",
			created_by_tech_id: TECH,
		});
		expect(tx.field_purchase_line.create.mock.calls[0][0].data).toMatchObject({
			inventory_item_id: "provisional-1",
			disposition: "receive",
		});
	});

	// OCR writes lines straight through `createMany`, bypassing Zod. So a receipt
	// with a printed discount was storable by the extractor and unsavable by the
	// technician who then had to edit it.
	it("accepts a negative unit price", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{ description: "Capacitor", quantity: 1, unit_price: 24.99 },
					{ description: "Contractor discount", quantity: 1, unit_price: -5 },
				],
			},
			{ techId: TECH },
		);

		expect(res.err).toBeUndefined();
		expect(tx.field_purchase_line.create.mock.calls[1][0].data).toMatchObject({
			description: "Contractor discount",
			unit_price: -5,
			line_total: -5,
		});
	});

	it("keeps a line's OCR confidence across a replace, so a reopen knows it was read", async () => {
		await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{ description: "Capacitor 45/5", quantity: 2, unit_price: 24.99, ocr_confidence: 0.91 },
				],
			},
			{ techId: TECH },
		);
		expect(tx.field_purchase_line.create.mock.calls[0][0].data).toMatchObject({
			ocr_confidence: 0.91,
		});
	});

	// The subtotal is a sum over line totals, so a discount has to come off it. Left
	// out, the receipt would disagree with its own lines and flag total_mismatch.
	it("nets a discount out of the subtotal", async () => {
		// The subtotal read is the one asking for line totals; the unbilling read
		// that runs before it asks for visit line items.
		tx.field_purchase_line.findMany.mockImplementation(
			async (args: { select?: Record<string, unknown> }) =>
				args.select?.line_total
					? [
							{ line_total: new Prisma.Decimal("24.99") },
							{ line_total: new Prisma.Decimal("-5.00") },
						]
					: [],
		);

		await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{ description: "Capacitor", quantity: 1, unit_price: 24.99 },
					{ description: "Contractor discount", quantity: 1, unit_price: -5 },
				],
			},
			{ techId: TECH },
		);

		const subtotalWrite = tx.field_purchase.update.mock.calls
			.map((c: [{ data: Record<string, unknown> }]) => c[0].data)
			.find((d: Record<string, unknown>) => "subtotal" in d);
		expect((subtotalWrite!.subtotal as Prisma.Decimal).toFixed(2)).toBe("19.99");
	});

	// You cannot stock a coupon into a truck at negative cost.
	it("rejects a receive disposition on a negative line", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{ description: "Discount", quantity: 1, unit_price: -5, disposition: "receive" },
				],
			},
			{ techId: TECH },
		);

		expect(res.err).toMatch(/negative line cannot be received into stock/i);
		expect(tx.field_purchase_line.create).not.toHaveBeenCalled();
	});

	it("still rejects a negative quantity", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{ lines: [{ description: "Wire", quantity: -2, unit_price: 5 }] },
			{ techId: TECH },
		);

		expect(res.err).toMatch(/Quantity must be positive/);
		expect(tx.field_purchase_line.create).not.toHaveBeenCalled();
	});

	// Every save runs through here, so creating per save would leave one catalog
	// row per editing session for the same part.
	it("reuses an existing provisional row instead of making another", async () => {
		tx.inventory_item.findFirst.mockResolvedValue({ id: "provisional-1" });

		await replaceLines(
			ORG,
			PURCHASE,
			{ lines: [{ description: "Fitting", quantity: 1, unit_price: 10, disposition: "receive" }] },
			{ techId: TECH },
		);

		expect(tx.inventory_item.create).not.toHaveBeenCalled();
	});

	// "It went onto the job and was never ours" is true whether or not the line
	// was mapped, so it is the one disposition a catalog link is not a gate for.
	it("accepts `non_stock` on an unmapped line", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{ description: "Fitting", quantity: 1, unit_price: 10, disposition: "non_stock" },
				],
			},
			{ techId: TECH },
		);
		expect(res.err).toBeUndefined();
	});

	it("rejects `consume`, which would deduct stock the part never came from", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{
						description: "Fitting",
						quantity: 1,
						unit_price: 10,
						inventory_item_id: ITEM_UUID,
						disposition: "consume",
					},
				],
			},
			{ techId: TECH },
		);
		expect(res.err).toMatch(/Validation failed/);
	});

	it("keeps a destination vehicle only on a `receive` line", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{
						description: "Fitting",
						quantity: 1,
						unit_price: 10,
						inventory_item_id: ITEM_UUID,
						disposition: "non_stock",
						disposition_vehicle_id: VEHICLE_UUID,
					},
				],
			},
			{ techId: TECH },
		);
		expect(res.err).toMatch(/only a `receive` line takes a destination vehicle/);
	});

	it("derives line_total and the receive destination, and replaces the whole set", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{
						description: "Compressor",
						quantity: 2,
						unit_price: 12.5,
						inventory_item_id: ITEM_UUID,
						disposition: "receive",
						disposition_vehicle_id: VEHICLE_UUID,
					},
				],
			},
			{ techId: TECH },
		);
		expect(res.err).toBeUndefined();
		expect(tx.field_purchase_line.deleteMany).toHaveBeenCalled();
		expect(tx.field_purchase_line.create.mock.calls[0][0].data).toMatchObject({
			line_total: 25,
			disposition_location: "vehicle",
			disposition_vehicle_id: VEHICLE_UUID,
		});
	});

	// Stocking another crew's van writes an inventory ledger nobody at that van
	// can account for, so the refusal has to live on the server - the picker
	// narrowing is a convenience, not the guarantee.
	it("refuses a line that stocks a truck other than the technician's own", async () => {
		mockDb.vehicle.findMany.mockResolvedValue([
			{ id: VEHICLE_UUID },
			{ id: OTHER_VEHICLE_UUID },
		]);
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{
						description: "Compressor",
						quantity: 1,
						unit_price: 10,
						inventory_item_id: ITEM_UUID,
						disposition: "receive",
						disposition_vehicle_id: OTHER_VEHICLE_UUID,
					},
				],
			},
			{ techId: TECH },
		);
		expect(res.err).toMatch(/not your current truck/);
		expect(tx.field_purchase_line.create).not.toHaveBeenCalled();
	});

	it("refuses any truck at all from a technician signed onto none", async () => {
		mockDb.technician.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			{ current_vehicle_id: null } as any,
		);
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{
						description: "Compressor",
						quantity: 1,
						unit_price: 10,
						inventory_item_id: ITEM_UUID,
						disposition: "receive",
						disposition_vehicle_id: VEHICLE_UUID,
					},
				],
			},
			{ techId: TECH },
		);
		expect(res.err).toMatch(/no truck assigned/);
	});

	// Warehouse is every technician's destination, truck or no truck: refusing it
	// would leave a line with nowhere legitimate to go.
	it("takes a warehouse line from a technician with no truck", async () => {
		mockDb.technician.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			{ current_vehicle_id: null } as any,
		);
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{
						description: "Compressor",
						quantity: 1,
						unit_price: 10,
						inventory_item_id: ITEM_UUID,
						disposition: "receive",
					},
				],
			},
			{ techId: TECH },
		);
		expect(res.err).toBeUndefined();
		expect(mockDb.technician.findFirst).not.toHaveBeenCalled();
		expect(tx.field_purchase_line.create.mock.calls[0][0].data).toMatchObject({
			disposition_location: "warehouse",
			disposition_vehicle_id: null,
		});
	});

	// A dispatcher reaching this endpoint has no truck to compare against; the
	// org-wide check is the whole of the rule for them.
	it("leaves a dispatcher's destination to the org check alone", async () => {
		const res = await replaceLines(
			ORG,
			PURCHASE,
			{
				lines: [
					{
						description: "Compressor",
						quantity: 1,
						unit_price: 10,
						inventory_item_id: ITEM_UUID,
						disposition: "receive",
						disposition_vehicle_id: VEHICLE_UUID,
					},
				],
			},
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBeUndefined();
		expect(mockDb.technician.findFirst).not.toHaveBeenCalled();
	});

	it("refuses to edit a purchase that has left the technician's hands", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({ status: "pending_review" }) as any,
		);
		const res = await replaceLines(ORG, PURCHASE, { lines: [] }, { techId: TECH });
		expect(res.err).toMatch(/status pending_review can no longer be edited/);
	});
});

describe("review", () => {
	const pending = (lines: Line[] = []) =>
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		purchase({ status: "pending_review" }, lines) as any;

	it("requires a dispatcher, not just any authenticated caller", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(pending());
		const res = await reviewPurchase(ORG, PURCHASE, { decision: "approve" }, { techId: TECH });
		expect(res.err).toMatch(/Only a dispatcher/);
	});

	// One human with both a technician and a dispatcher account: the two rows have
	// different ids by construction, so the login address is what ties them.
	it("refuses when the reviewer is the purchaser", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(pending());
		mockDb.technician.findFirst.mockResolvedValue({ email: "Same.Person@example.test" } as never);
		mockDb.dispatcher.findFirst.mockResolvedValue({ email: "same.person@example.test" } as never);
		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "approve" },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBe("You cannot review your own purchase");
	});

	// Two dispatchers pressing Approve at once. The loser's claim matches no row,
	// so it must refuse rather than write a second intake for the same receipt.
	it("refuses a decision another dispatcher already made", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(pending());
		tx.field_purchase.updateMany.mockResolvedValue({ count: 0 });

		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "approve" },
			{ dispatcherId: DISPATCHER },
		);

		expect(res.err).toContain("decided by somebody else");
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("needs a note when querying, since the note is what the tech acts on", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(pending());
		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "query" },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toMatch(/a query needs a note/);
	});

	// The stock effect is the whole difference between the two dispositions.
	it("moves stock for a mapped `receive` line and nothing else", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			pending([
				{
					id: "l1",
					quantity: 2,
					unit_price: 10,
					inventory_item_id: "item-1",
					disposition: "receive",
					disposition_vehicle_id: "veh-1",
				},
				{
					id: "l2",
					quantity: 1,
					unit_price: 40,
					inventory_item_id: "item-2",
					disposition: "non_stock",
				},
				{ id: "l3", quantity: 5, unit_price: 1, inventory_item_id: null, disposition: null },
			]),
		);
		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "approve" },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBeUndefined();
		// Two calls, not one: the intake for `receive`, then the cost of what went
		// onto the job. The unmapped line has no item to hang either on.
		expect(mockRecordMovements).toHaveBeenCalledTimes(2);
		const movements = mockRecordMovements.mock.calls[0][3];
		expect(movements).toHaveLength(1);
		expect(movements[0]).toMatchObject({
			inventory_item_id: "item-1",
			qty: 2,
			from_location_type: "external",
			to_location_type: "vehicle",
			to_vehicle_id: "veh-1",
			reason: "supplier_purchase",
			unit_cost: 10,
			field_purchase_line_id: "l1",
		});

		// `external` to `consumed` moves no balance: it records what the part cost
		// against an item that was never on our shelf.
		const costs = mockRecordMovements.mock.calls[1][3];
		expect(costs).toHaveLength(1);
		expect(costs[0]).toMatchObject({
			inventory_item_id: "item-2",
			qty: 1,
			from_location_type: "external",
			to_location_type: "consumed",
			reason: "supplier_purchase",
			unit_cost: 40,
			field_purchase_line_id: "l2",
		});
	});

	it("sends a warehouse-bound receive to the warehouse", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			pending([
				{
					id: "l1",
					quantity: 1,
					unit_price: 10,
					inventory_item_id: "item-1",
					disposition: "receive",
					disposition_vehicle_id: null,
				},
			]),
		);
		await reviewPurchase(ORG, PURCHASE, { decision: "approve" }, { dispatcherId: DISPATCHER });
		expect(mockRecordMovements.mock.calls[0][3][0]).toMatchObject({
			to_location_type: "warehouse",
			to_vehicle_id: undefined,
		});
	});

	it("moves no stock when rejecting, and still tells the technician", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			pending([
				{
					id: "l1",
					quantity: 1,
					unit_price: 10,
					inventory_item_id: "item-1",
					disposition: "receive",
				},
			]),
		);
		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "reject", note: "Not an emergency" },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBeUndefined();
		expect(mockRecordMovements).not.toHaveBeenCalled();
		expect(mockNotify).toHaveBeenCalledWith(
			expect.objectContaining({ technicianId: TECH, title: "Purchase rejected" }),
			ORG,
		);
	});

	it("refuses a note-less rejection, which un-bills a visit with no reason on the record", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(pending());
		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "reject" },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBe("Validation failed: a rejection needs a note for the technician");
	});

	it("accepts a rejection that carries one", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(pending());
		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "reject", note: "Wrong job — this is the Harper install, not Kelly." },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBeUndefined();
		// Absence of an error only shows the guard did not fire, not that the
		// rejection itself proceeded — assert the actual effect, same as the
		// sibling "moves no stock when rejecting" test above.
		expect(mockRecordMovements).not.toHaveBeenCalled();
		expect(mockNotify).toHaveBeenCalledWith(
			expect.objectContaining({ technicianId: TECH, title: "Purchase rejected" }),
			ORG,
		);
	});

	it("only acts on a purchase that is actually awaiting review", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.field_purchase.findFirst.mockResolvedValue(purchase({ status: "approved" }) as any);
		const res = await reviewPurchase(
			ORG,
			PURCHASE,
			{ decision: "approve" },
			{ dispatcherId: DISPATCHER },
		);
		expect(res.err).toBe("This purchase is not awaiting review");
	});
});

describe("runReceiptOcr", () => {
	const BASE_EXTRACTION = {
		vendor_name: "Grainger",
		receipt_number: "INV-4471",
		vendor_address: null,
		vendor_phone: null,
		purchased_at: new Date("2026-08-21T00:00:00Z"),
		subtotal: 61,
		tax_amount: 4.27,
		total: 65.27,
		taxes: [],
		document_type: "expense_receipt",
		currency: "USD",
		lines: [
			{ description: "Capacitor", quantity: 1, unit_price: 24.99, line_total: 24.99, confidence: 0.93 },
		],
		field_confidence: { total: 0.95 },
		raw: { ok: true },
	};
	const FILE = { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" };

	function withProvider() {
		mockExtract.mockResolvedValue(BASE_EXTRACTION);
		mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
	}

	function currentPurchase(over: Record<string, unknown> = {}) {
		tx.field_purchase.findFirst.mockResolvedValue({
			id: PURCHASE,
			status: "draft",
			vendor_name: null,
			purchased_at: null,
			subtotal: new Prisma.Decimal(0),
			tax_amount: new Prisma.Decimal(0),
			total: new Prisma.Decimal(0),
			_count: { lines: 0 },
			...over,
		});
	}

	it("does nothing at all when no provider is configured", async () => {
		mockProvider.mockReturnValue(null);
		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });
		expect(mockDb.$transaction).not.toHaveBeenCalled();
	});

	it("skips extraction on a file too large to be a compressed receipt photo", async () => {
		withProvider();
		mockDb.field_purchase.update.mockResolvedValue({} as never);
		const huge = { buffer: Buffer.alloc(OCR_MAX_BYTES + 1), mimetype: "image/jpeg", filename: "r.jpg" };
		await runReceiptOcr(ORG, PURCHASE, huge);

		expect(mockExtract).not.toHaveBeenCalled();
		const data = mockDb.field_purchase.update.mock.calls[0][0].data;
		expect(data.ocr_status).toBe("failed");
		expect(data.ocr_error).toMatch(/too large/i);
	});

	it("writes the extracted lines and header onto an untouched purchase", async () => {
		withProvider();
		currentPurchase();
		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		expect(tx.field_purchase_line.createMany).toHaveBeenCalledWith({
			data: [
				expect.objectContaining({ description: "Capacitor", ocr_confidence: 0.93, sort_order: 0 }),
			],
		});
		const data = tx.field_purchase.update.mock.calls[0][0].data;
		expect(data).toMatchObject({ ocr_status: "succeeded", vendor_name: "Grainger", total: 65.27 });
		expect(data.ocr_line_count).toBe(1);
	});

	it("never overwrites a header field the technician already filled in", async () => {
		withProvider();
		currentPurchase({ vendor_name: "Ferguson", total: new Prisma.Decimal(80) });
		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		const data = tx.field_purchase.update.mock.calls[0][0].data;
		expect(data).not.toHaveProperty("vendor_name");
		expect(data).not.toHaveProperty("total");
		expect(data).toMatchObject({ tax_amount: 4.27 });
	});

	it("leaves existing lines alone but still records the extraction", async () => {
		withProvider();
		currentPurchase({ _count: { lines: 2 } });
		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		expect(tx.field_purchase_line.createMany).not.toHaveBeenCalled();
		expect(tx.field_purchase.update.mock.calls[0][0].data.ocr_status).toBe("succeeded");
		expect(tx.field_purchase_event.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ detail: expect.objectContaining({ lines_applied: 0 }) }),
			}),
		);
	});

	// The whole extraction is kept whatever happened to the lines, and says which
	// it was, so a technician who typed one line at the counter while extraction
	// was in flight does not lose the other four with nothing on the record to
	// recover them.
	it("marks the snapshot applied when it wrote the lines", async () => {
		withProvider();
		currentPurchase();
		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		expect(tx.field_purchase.update.mock.calls[0][0].data.ocr_lines).toEqual([
			expect.objectContaining({ description: "Capacitor", applied: true }),
		]);
	});

	it("keeps the whole extraction, marked unapplied, when the technician got there first", async () => {
		withProvider();
		currentPurchase({ _count: { lines: 1 } });
		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		const data = tx.field_purchase.update.mock.calls[0][0].data;
		expect(tx.field_purchase_line.createMany).not.toHaveBeenCalled();
		expect(data.ocr_lines).toEqual([
			expect.objectContaining({ description: "Capacitor", applied: false }),
		]);
		expect(data.ocr_line_count).toBe(1);
	});

	/**
	 * Lines the extraction wrote are lines like any other: the subtotal is their
	 * sum and a single-job receipt owns all of them. Left unsettled they sat under
	 * subtotal 0 with allocation_id null, and submit then billed nothing and
	 * stamped not_billed on a receipt with a perfectly good job on it.
	 */
	it("settles the lines it wrote, the way every other write path does", async () => {
		withProvider();
		currentPurchase();
		tx.field_purchase_job_allocation.findMany.mockResolvedValue([{ id: "alloc-a" }]);
		tx.field_purchase_line.findMany.mockResolvedValue([{ line_total: 24.99 }]);
		tx.field_purchase.findUniqueOrThrow.mockResolvedValue({
			tax_amount: new Prisma.Decimal(0),
			allocations: [{ id: "alloc-a", lines: [{ line_total: 24.99 }] }],
		});

		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		expect(tx.field_purchase_line.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ allocation_id: null }),
				data: { allocation_id: "alloc-a" },
			}),
		);
		expect(tx.field_purchase_job_allocation.update).toHaveBeenCalled();
	});

	it("leaves the technician's own lines unsettled, which is not its business", async () => {
		withProvider();
		currentPurchase({ _count: { lines: 2 } });
		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });
		expect(tx.field_purchase_line.updateMany).not.toHaveBeenCalled();
	});

	/**
	 * The docstring promises every exit stamps a status. It did not: a failure
	 * applying the extraction left `pending`, which the sheet reads as "still
	 * working" forever - it polls every 3s and the retry button is gated on
	 * `failed`, so there was no way out of it.
	 */
	it("stamps a failure when applying the extraction throws, not just reading it", async () => {
		withProvider();
		currentPurchase();
		tx.field_purchase.update.mockRejectedValueOnce(new Error("deadlock detected"));
		mockDb.field_purchase.update.mockResolvedValue({} as never);

		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		expect(mockDb.field_purchase.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					ocr_status: "failed",
					ocr_error: "deadlock detected",
				}),
			}),
		);
	});

	it("stamps a failure rather than leaving the purchase reading as still working", async () => {
		mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
		mockExtract.mockRejectedValue(new Error("provider 503"));
		mockDb.field_purchase.update.mockResolvedValue({} as never);

		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		expect(mockDb.field_purchase.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ ocr_status: "failed", ocr_error: "provider 503" }),
			}),
		);
	});

	it("warns when a provider returns an extraction with no confidence at all", async () => {
		const { log } = await import("../../services/appLogger.js");
		const warn = vi.spyOn(log, "warn");
		mockExtract.mockResolvedValue({ ...BASE_EXTRACTION, field_confidence: {} });
		mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
		currentPurchase();

		await runReceiptOcr(ORG, PURCHASE, { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" });

		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "mindee" }),
			expect.stringMatching(/no field confidence/i),
		);
		warn.mockRestore();
	});

	it("flags a non-receipt document instead of refusing it", async () => {
		mockExtract.mockResolvedValue({ ...BASE_EXTRACTION, document_type: "bank_statement" });
		mockProvider.mockReturnValue({ name: "mindee", extract: mockExtract });
		currentPurchase();

		await runReceiptOcr(ORG, PURCHASE, FILE);

		const data = tx.field_purchase.update.mock.calls[0][0].data;
		expect(data.flags).toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "not_a_receipt" })]),
		);
	});

	/**
	 * Flags are recomputed from this extraction, not accumulated onto whatever the
	 * row already carried - so a retry that comes back clean clears a stale flag
	 * a prior, bad read left behind rather than piling a second one on top of it.
	 */
	it("drops a stale not_a_receipt flag when a re-read comes back clean", async () => {
		withProvider();
		currentPurchase({
			flags: [{ code: "not_a_receipt", message: "The image reads as a bank statement, not a receipt" }],
		});

		await runReceiptOcr(ORG, PURCHASE, FILE);

		const data = tx.field_purchase.update.mock.calls[0][0].data;
		expect(data.flags).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ code: "not_a_receipt" })]),
		);
	});

	/**
	 * Phone-only, and only when it points at exactly one supplier: a receipt's
	 * vendor is not the org's supplier record, so name and address are not
	 * trusted to say who that is - a wrong link is worse than none.
	 */
	describe("supplier match", () => {
		let suppliers: { id: string; name: string; phone: string | null }[] = [];

		function updated() {
			return tx.field_purchase.update.mock.calls[0][0].data;
		}

		beforeEach(() => {
			suppliers = [];
			withProvider();
			currentPurchase();
			mockDb.supplier.findMany.mockImplementation(async () => suppliers);
		});

		it("links the purchase to a supplier whose phone the receipt matches", async () => {
			suppliers = [{ id: "sup-1", name: "Ferguson HVAC Supply", phone: "(414) 555-0188" }];
			mockProvider.mockReturnValue({
				name: "mindee",
				extract: async () => ({ ...BASE_EXTRACTION, vendor_phone: "414-555-0188", vendor_address: null }),
			});

			await runReceiptOcr(ORG, PURCHASE, FILE);

			expect(updated().supplier_id).toBe("sup-1");
		});

		it("leaves supplier_id unset when nothing matches, rather than guessing", async () => {
			suppliers = [];
			mockProvider.mockReturnValue({
				name: "mindee",
				extract: async () => ({ ...BASE_EXTRACTION, vendor_phone: "414-555-0188", vendor_address: null }),
			});

			await runReceiptOcr(ORG, PURCHASE, FILE);

			expect(mockDb.supplier.findMany).toHaveBeenCalled();
			expect(updated().supplier_id).toBeUndefined();
		});

		it("refuses to pick between two suppliers sharing a phone", async () => {
			suppliers = [
				{ id: "sup-1", name: "Ferguson A", phone: "414-555-0188" },
				{ id: "sup-2", name: "Ferguson B", phone: "(414) 555-0188" },
			];
			mockProvider.mockReturnValue({
				name: "mindee",
				extract: async () => ({ ...BASE_EXTRACTION, vendor_phone: "414-555-0188", vendor_address: null }),
			});

			await runReceiptOcr(ORG, PURCHASE, FILE);

			expect(mockDb.supplier.findMany).toHaveBeenCalled();
			expect(updated().supplier_id).toBeUndefined();
		});
	});
});

/**
 * Re-reading the receipt already in storage. The bytes are pulled back rather than
 * re-photographed, because a fresh photo would change the hash the duplicate guard
 * depends on.
 */
describe("retryOcr", () => {
	beforeEach(() => {
		// loadEditable reads first, then the ocr row.
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce({
				id: PURCHASE,
				status: "draft",
				technician_id: TECH,
				total: new Prisma.Decimal(0),
				tax_amount: new Prisma.Decimal(0),
				estimated_amount: null,
				receipt_image_url: "https://bucket/receipts/r.jpg",
			} as never)
			.mockResolvedValueOnce({
				receipt_image_url: "https://bucket/receipts/r.jpg",
				ocr_status: "failed",
			} as never);
	});

	it("says so rather than silently doing nothing when no provider is configured", async () => {
		mockProvider.mockReturnValue(null);
		const res = await retryOcr(ORG, PURCHASE, { techId: TECH } as never);
		expect(res.err).toBe("Receipt reading is not configured — enter the lines by hand");
		expect(mockGetBuffer).not.toHaveBeenCalled();
	});

	it("refuses to read again once the month's scans are used up, leaving the row alone", async () => {
		mockProvider.mockReturnValue({ name: "fixture", extract: mockExtract });
		mockConsume.mockResolvedValue({ allowed: false, used: 300, limit: 300 });
		mockGetBuffer.mockResolvedValue({ buffer: Buffer.from("x"), contentType: "image/jpeg" });
		const res = await retryOcr(ORG, PURCHASE, { techId: TECH } as never);
		expect(res.err).toBe(
			"This month's receipt scans are used up. Enter the lines by hand; scanning resumes on the 1st (UTC).",
		);
		expect(mockDb.field_purchase.update).not.toHaveBeenCalled();
		expect(mockExtract).not.toHaveBeenCalled();
	});

	it("reports a storage failure as a message rather than throwing a 500", async () => {
		mockProvider.mockReturnValue({ name: "fixture", extract: mockExtract });
		mockGetBuffer.mockRejectedValue(new Error("wasabi timeout"));

		const res = await retryOcr(ORG, PURCHASE, { techId: TECH } as never);
		expect(res.err).toBeTruthy();
	});

	it("re-reads the stored image and marks the purchase as reading again", async () => {
		mockProvider.mockReturnValue({ name: "fixture", extract: mockExtract });
		mockExtract.mockResolvedValue({
			vendor_name: null, purchased_at: null, subtotal: null, tax_amount: null, total: null,
			lines: [], field_confidence: {}, raw: null,
		});
		mockGetBuffer.mockResolvedValue({ buffer: Buffer.from("x"), contentType: "image/jpeg" });
		mockDb.field_purchase.update.mockResolvedValue({} as never);

		const res = await retryOcr(ORG, PURCHASE, { techId: TECH } as never);

		expect(res.started).toBe(true);
		expect(mockConsume).toHaveBeenCalledWith(ORG, "receipt_scans_month");
		expect(mockGetBuffer).toHaveBeenCalledWith("https://bucket/receipts/r.jpg");
		expect(mockDb.field_purchase.update).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ ocr_status: "pending", ocr_provider: "fixture" }),
			}),
		);
	});
});

/**
 * What the technician's sheet reads to offer an extraction it has not applied. The
 * header comes back off the stored provider payload rather than a column, because
 * the columns hold what the technician decided, not what the machine read.
 */
/**
 * The coordinates locate an employee to about a tenth of a metre, which makes them
 * sensitive personal information rather than part of the record of a spend. They
 * leave through one endpoint and no other, so both halves are pinned: what a
 * purchase response carries, and what this one returns.
 */
describe("capture location", () => {
	it("gives a purchase response whether a position exists, never the position", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.field_purchase.findFirst.mockResolvedValue(purchase({ capture_lat: 43.07 }) as any);
		mockDb.field_purchase_event.findMany.mockResolvedValue([] as never);

		const res = await getPurchase(ORG, PURCHASE, { dispatcherId: DISPATCHER });
		expect(res.err).toBeUndefined();
		const body = res.purchase as Record<string, unknown>;
		expect(body.has_geo).toBe(true);
		// Any coordinate key at all, not just the one shapePurchase strips by name:
		// re-adding capture_lng to PURCHASE_SELECT would otherwise leak silently.
		expect(Object.keys(body).filter((k) => k.startsWith("capture_l"))).toEqual([]);
	});

	it("reports the absence too, so a missing position is not a missing field", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.field_purchase.findFirst.mockResolvedValue(purchase({ capture_lat: null }) as any);
		mockDb.field_purchase_event.findMany.mockResolvedValue([] as never);

		const res = await getPurchase(ORG, PURCHASE, { dispatcherId: DISPATCHER });
		expect((res.purchase as Record<string, unknown>).has_geo).toBe(false);
	});

	it("answers the position on its own request", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			capture_lat: new Prisma.Decimal("43.812400"),
			capture_lng: new Prisma.Decimal("-91.256800"),
			capture_accuracy_m: 12,
			captured_at: new Date("2026-08-21T15:02:00Z"),
		} as never);

		const res = await getCaptureLocation(ORG, PURCHASE, { dispatcherId: DISPATCHER });
		expect(res.location).toMatchObject({ capture_accuracy_m: 12 });
		expect(res.location!.capture_lat?.toString()).toBe("43.8124");
	});

	it("refuses a purchase the caller cannot see", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(null as never);
		const res = await getCaptureLocation(ORG, PURCHASE, { techId: "tech-other" });
		expect(res.err).toBe("Field purchase not found");
	});
});

describe("getPurchaseExtraction", () => {
	it("reports nothing to review when no receipt was ever read", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			ocr_status: "skipped",
			ocr_provider: null,
			ocr_raw: null,
			ocr_lines: null,
			ocr_field_confidence: {},
			ocr_completed_at: null,
		} as never);

		const res = await getPurchaseExtraction(ORG, PURCHASE);
		expect(res.extraction).toMatchObject({ status: "skipped", lines: [], header: null });
	});

	it("returns the unapplied lines and the header the technician's own values hid", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			ocr_status: "succeeded",
			ocr_provider: "fixture",
			ocr_raw: SAMPLE_RECEIPT,
			ocr_lines: [
				{ description: "Capacitor", quantity: 1, unit_price: 24.99, line_total: 24.99, confidence: 0.93, applied: false },
			],
			ocr_field_confidence: { total: 0.98 },
			ocr_completed_at: new Date("2026-08-21T14:35:00Z"),
		} as never);

		const res = await getPurchaseExtraction(ORG, PURCHASE);
		expect(res.extraction!.lines).toEqual([
			expect.objectContaining({ description: "Capacitor", applied: false }),
		]);
		// Read back off the evidence, so a receipt value the technician disagreed
		// with is still there to show them rather than lost at write time.
		expect(res.extraction!.header).toMatchObject({
			vendor_name: "Northgate Trade Supply",
			total: 310.22,
		});
	});

	it("has no header for a provider it cannot map, rather than guessing one", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			ocr_status: "succeeded",
			ocr_provider: "taggun",
			ocr_raw: { anything: true },
			ocr_lines: [],
			ocr_field_confidence: {},
			ocr_completed_at: new Date(),
		} as never);

		expect((await getPurchaseExtraction(ORG, PURCHASE)).extraction!.header).toBeNull();
	});

	// `ocr_provider` is a plain string column, and a bare object literal answers to
	// every Object.prototype key. Only the server writes it today, so this is a
	// latch rather than a live hole.
	it("does not mistake an Object.prototype key for a provider", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			ocr_status: "succeeded",
			ocr_provider: "toString",
			ocr_raw: { anything: true },
			ocr_lines: [],
			ocr_field_confidence: {},
			ocr_completed_at: new Date(),
		} as never);

		expect((await getPurchaseExtraction(ORG, PURCHASE)).extraction!.header).toBeNull();
	});

	it("refuses a purchase the caller cannot see", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(null as never);
		expect((await getPurchaseExtraction(ORG, PURCHASE)).err).toBe("Field purchase not found");
	});
});

describe("duplicate detection at submit", () => {
	// spentSoFar reads field_purchase.findMany first, similarPurchases second.
	function priors(rows: unknown[]) {
		mockDb.field_purchase.findMany.mockResolvedValueOnce([] as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce(rows as never);
	}

	const prior = (over: Record<string, unknown> = {}) => ({
		id: "fp-prior",
		status: "approved",
		vendor_name: "Grainger",
		purchased_at: new Date("2026-08-21T09:00:00Z"),
		total: 100,
		technician_id: "tech-9",
		technician: { name: "Sam Ortiz" },
		...over,
	});

	function submittable() {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ vendor_name: "Grainger", kind: "purchase" }, [verified()], [
				{ job_id: "job-1", amount: 100 },
			]) as never,
		);
	}

	it("refuses a receipt that was already reimbursed", async () => {
		submittable();
		priors([prior()]);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toContain("already reimbursed");
		expect(tx.field_purchase.updateMany).not.toHaveBeenCalled();
	});

	it("only flags the same receipt while the earlier one is still in review", async () => {
		submittable();
		priors([prior({ status: "pending_review" })]);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBeUndefined();
		expect(res.flags?.map((f) => f.code)).toContain("duplicate_suspected");
	});

	// A return is the same vendor, the same day and the same money as the purchase
	// it reverses, so the duplicate rule would refuse every one of them.
	it("lets a refund through even though it mirrors the purchase it reverses", async () => {
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce(
				purchase({ vendor_name: "Grainger", kind: "refund", parent_purchase_id: "parent" }, [
					verified(),
				], [{ job_id: "job-1", amount: 100 }]) as never,
			)
			.mockResolvedValueOnce({ status: "approved", total: 100 } as never);
		// A refund reads its sibling refunds before spentSoFar and similarPurchases,
		// so priors' two queued reads land one call later than for a purchase.
		mockDb.field_purchase.findMany.mockResolvedValueOnce([] as never);
		priors([prior()]);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBeUndefined();
		expect(res.flags?.map((f) => f.code)).not.toContain("duplicate_suspected");
	});

	it("flags a third purchase at the same counter on the same day", async () => {
		submittable();
		priors([
			prior({ id: "a", total: 20, technician_id: TECH }),
			prior({ id: "b", total: 30, technician_id: TECH }),
		]);
		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.flags?.map((f) => f.code)).toContain("velocity");
	});
});

describe("second sign-off", () => {
	const approvable = (over: Record<string, unknown> = {}) => ({
		id: PURCHASE,
		status: "pending_review",
		kind: "purchase",
		parent_purchase_id: null,
		technician_id: TECH,
		supplier_id: null,
		total: 900,
		flags: [],
		allocations: [{ job_visit_id: null }],
		lines: [
			{
				id: "l1",
				quantity: 1,
				unit_price: 900,
				inventory_item_id: ITEM_UUID,
				disposition: "receive",
				disposition_vehicle_id: null,
			},
		],
		...over,
	});

	it("holds the stock effect when the total is over the org threshold", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(approvable() as never);
		mockDb.organization.findFirst.mockResolvedValue({
			timezone: "UTC",
			field_purchase_second_signoff_threshold: 500,
		} as never);

		await reviewPurchase(ORG, PURCHASE, { decision: "approve" }, { dispatcherId: DISPATCHER });

		expect(tx.field_purchase.updateMany.mock.calls[0][0].data.status).toBe("pending_second_signoff");
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("approves outright below the threshold", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(approvable({ total: 100 }) as never);
		mockDb.organization.findFirst.mockResolvedValue({
			timezone: "UTC",
			field_purchase_second_signoff_threshold: 500,
		} as never);

		await reviewPurchase(ORG, PURCHASE, { decision: "approve" }, { dispatcherId: DISPATCHER });

		expect(tx.field_purchase.updateMany.mock.calls[0][0].data.status).toBe("approved");
		expect(mockRecordMovements).toHaveBeenCalledTimes(1);
	});

	it("refuses the dispatcher who already approved it", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			approvable({ status: "pending_second_signoff", reviewed_by_id: DISPATCHER }) as never,
		);
		const res = await secondSignoff(ORG, PURCHASE, { approve: true }, { dispatcherId: DISPATCHER });
		expect(res.err).toContain("you approved yourself");
		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("moves the stock once a different dispatcher signs", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			approvable({ status: "pending_second_signoff", reviewed_by_id: DISPATCHER }) as never,
		);
		const res = await secondSignoff(ORG, PURCHASE, { approve: true }, { dispatcherId: "disp-2" });
		expect(res.err).toBeUndefined();
		expect(mockRecordMovements).toHaveBeenCalledTimes(1);
		expect(tx.field_purchase.updateMany.mock.calls[0][0].data.status).toBe("approved");
	});
});

/**
 * The hole this whole shape exists to close: a receipt covering two jobs used to
 * bill NEITHER of them, because the visit was read off the purchase and a purchase
 * with two allocations named no single visit. Nobody was charged, and a dispatcher
 * got a flag saying so.
 */
describe("billing a split receipt", () => {
	const SPLIT = [
		{ job_id: "job-a", job_visit_id: "visit-a" },
		{ job_id: "job-b", job_visit_id: "visit-b" },
	];

	/** What `syncBilledLines` reads back inside the transaction. */
	function billing(lines: Line[]) {
		tx.field_purchase.findUniqueOrThrow.mockResolvedValue({
			id: PURCHASE,
			kind: "purchase",
			tax_amount: 0,
			allocations: [],
			lines: lines.map((l) => ({
				quantity: 1,
				unit_price: 50,
				inventory_item_id: null,
				inventory_item: null,
				visit_line_item_id: null,
				visit_line_item: null,
				description: "Part",
				...l,
			})),
		});
	}

	const consumed = (over: Partial<Line>): Line =>
		verified({ disposition: "non_stock", line_total: 50, ...over });

	it("raises a charge on each job's own visit", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{},
				[
					consumed({ id: "line-a", allocation_id: "alloc-a" }),
					consumed({ id: "line-b", allocation_id: "alloc-b" }),
				],
				SPLIT,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			) as any,
		);
		billing([
			consumed({ id: "line-a", allocation: { job_visit_id: "visit-a" } }),
			consumed({ id: "line-b", allocation: { job_visit_id: "visit-b" } }),
		]);
		tx.job_visit_line_item.create.mockResolvedValue({ id: "vli-new" });

		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });

		expect(res.err).toBeUndefined();
		expect(res.flags!.map((f) => f.code)).not.toContain("not_billed");
		expect(tx.job_visit_line_item.create.mock.calls.map((c: any[]) => c[0].data.visit_id)).toEqual(
			["visit-a", "visit-b"],
		);
		// Both invoices moved, so both have to be squared.
		expect(mockRecomputeVisitTotals.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual([
			"visit-a",
			"visit-b",
		]);
	});

	/**
	 * The first negative line item this system produces. A discount printed on the
	 * receipt belongs on the invoice of the job that received it, or the customer
	 * pays the undiscounted price for parts the company bought cheaper.
	 */
	it("bills a negative non_stock line as a credit on the visit", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{ total: 45 },
				[
					consumed({ id: "line-a", allocation_id: "alloc-a", line_total: 50 }),
					consumed({ id: "line-d", allocation_id: "alloc-a", line_total: -5 }),
				],
				[{ job_id: "job-a", job_visit_id: "visit-a" }],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			) as any,
		);
		billing([
			consumed({ id: "line-a", allocation: { job_visit_id: "visit-a" } }),
			{
				...consumed({ id: "line-d", allocation: { job_visit_id: "visit-a" } }),
				unit_price: -5,
				line_total: -5,
				description: "Contractor discount",
			},
		]);
		tx.job_visit_line_item.create.mockResolvedValue({ id: "vli-new" });

		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });

		expect(res.err).toBeUndefined();
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const written = tx.job_visit_line_item.create.mock.calls.map((c: any[]) => c[0].data);
		const credit = written.find((d: { name: string }) => d.name === "Contractor discount");
		expect(credit.unit_price.toFixed(2)).toBe("-5.00");
		expect(credit.total.toFixed(2)).toBe("-5.00");
		// The invoice is squared afterwards, so the visit total drops by the credit.
		expect(mockRecomputeVisitTotals).toHaveBeenCalledWith("visit-a", ORG, tx);
	});

	// A discount is not a part, and T4.2 already refuses `receive` on one. This is
	// the belt to that braces: nothing reaches a shelf at a negative cost.
	it("moves no stock for a negative line", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{ total: -5 },
				[consumed({ id: "line-d", allocation_id: "alloc-a", line_total: -5 })],
				[{ job_id: "job-a", job_visit_id: "visit-a" }],
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			) as any,
		);
		billing([
			{
				...consumed({ id: "line-d", allocation: { job_visit_id: "visit-a" } }),
				unit_price: -5,
				line_total: -5,
				description: "Contractor discount",
			},
		]);
		tx.job_visit_line_item.create.mockResolvedValue({ id: "vli-new" });

		await submitPurchase(ORG, PURCHASE, { techId: TECH });
		await reviewPurchase(ORG, PURCHASE, { decision: "approve" }, { dispatcherId: DISPATCHER });

		const moved = mockRecordMovements.mock.calls.flatMap((c: unknown[]) => c[3] as unknown[]);
		expect(moved).toEqual([]);
	});

	it("a new charge from a non-taxable catalog item is written non-taxable; an uncatalogued one omits it", async () => {
		const catalog = { name: "Cylinder", unit_price: 50, taxable: false };
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{},
				[
					consumed({ id: "line-a", allocation_id: "alloc-a" }),
					consumed({ id: "line-b", allocation_id: "alloc-b" }),
				],
				SPLIT,
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
			) as any,
		);
		billing([
			consumed({
				id: "line-a",
				inventory_item_id: ITEM_UUID,
				inventory_item: catalog,
				allocation: { job_visit_id: "visit-a" },
			}),
			consumed({ id: "line-b", allocation: { job_visit_id: "visit-b" } }),
		]);
		tx.job_visit_line_item.create.mockResolvedValue({ id: "vli-new" });

		await submitPurchase(ORG, PURCHASE, { techId: TECH });

		const written = tx.job_visit_line_item.create.mock.calls.map((c: any[]) => c[0].data);
		expect(written[0].taxable).toBe(false);
		expect(written[1]).not.toHaveProperty("taxable");
	});

	// `visit_line_item_id` is unique, so moving a line between jobs is a delete
	// and a rewrite. Left as an update, the charge stays on the first customer.
	it("moves a charge when the line changes job, without billing both", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			purchase({}, [consumed({ id: "line-a", allocation_id: "alloc-b" })], SPLIT) as any,
		);
		billing([
			consumed({
				id: "line-a",
				visit_line_item_id: "vli-old",
				visit_line_item: { visit_id: "visit-a" },
				allocation: { job_visit_id: "visit-b" },
			}),
		]);
		tx.job_visit_line_item.create.mockResolvedValue({ id: "vli-new" });

		await submitPurchase(ORG, PURCHASE, { techId: TECH });

		expect(tx.job_visit_line_item.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["vli-old"] } },
		});
		expect(tx.job_visit_line_item.update).not.toHaveBeenCalled();
		expect(tx.job_visit_line_item.create.mock.calls[0][0].data.visit_id).toBe("visit-b");
		expect(mockRecomputeVisitTotals.mock.calls.map((c: unknown[]) => c[0]).sort()).toEqual([
			"visit-a",
			"visit-b",
		]);
	});

	// The one case `not_billed` is still for: a job nobody was standing on a visit
	// of. The message must not blame the split, which is no longer the cause.
	it("flags only the lines with no visit to land on", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase(
				{},
				[
					consumed({ id: "line-a", allocation_id: "alloc-a" }),
					consumed({ id: "line-b", allocation_id: "alloc-b" }),
				],
				[
					{ job_id: "job-a", job_visit_id: "visit-a" },
					{ job_id: "job-b", job_visit_id: null },
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
				],
			) as any,
		);
		billing([
			consumed({ id: "line-a", allocation: { job_visit_id: "visit-a" } }),
			consumed({ id: "line-b", allocation: { job_visit_id: null } }),
		]);
		tx.job_visit_line_item.create.mockResolvedValue({ id: "vli-new" });

		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });

		expect(tx.job_visit_line_item.create).toHaveBeenCalledTimes(1);
		const notBilled = res.flags!.find((f) => f.code === "not_billed");
		expect(notBilled).toBeDefined();
		expect(notBilled!.message).not.toMatch(/split/i);
	});
});

describe("refunds", () => {
	const parentRow = (over: Record<string, unknown> = {}) => ({
		id: "parent",
		kind: "purchase",
		status: "approved",
		technician_id: TECH,
		vendor_name: "Grainger",
		supplier_id: "sup-1",
		allocations: [{ job_id: "job-1", amount: 100 }],
		...over,
	});

	it("only opens against an approved purchase of the same technician", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(parentRow({ status: "pending_review" }) as never);
		expect((await createRefund(ORG, TECH, { parent_purchase_id: PARENT_UUID })).err).toContain(
			"approved purchase",
		);

		mockDb.field_purchase.findFirst.mockResolvedValue(parentRow({ technician_id: "tech-other" }) as never);
		expect((await createRefund(ORG, TECH, { parent_purchase_id: PARENT_UUID })).err).toContain(
			"your own",
		);
	});

	it("carries the parent job split so the reversal lands where the cost did", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(parentRow() as never);
		tx.field_purchase.create.mockResolvedValue({ id: "refund-1" });

		await createRefund(ORG, TECH, { parent_purchase_id: PARENT_UUID });

		const data = tx.field_purchase.create.mock.calls[0][0].data;
		expect(data).toMatchObject({ kind: "refund", parent_purchase_id: "parent" });
		// The jobs, never the money: a credit is worth what its own lines come to.
		expect(data.allocations.create).toEqual([
			{ job_id: "job-1", job_visit_id: undefined, amount: 0 },
		]);
	});

	it("refuses a credit larger than the purchase it reverses", async () => {
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce(
				purchase({ kind: "refund", parent_purchase_id: "parent", total: 200 }, [verified()], [
					{ job_id: "job-1", amount: 200 },
				]) as never,
			)
			.mockResolvedValueOnce({ status: "approved", total: 150 } as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([]);

		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBe("This refund and the others against the same purchase would exceed it");
	});

	// Each refund was only ever compared to the parent alone, so two could each
	// pass and together return more than was ever reimbursed.
	it("refuses a refund that would, with its siblings, return more than the purchase", async () => {
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce(
				purchase({ kind: "refund", parent_purchase_id: "parent", total: 400 }, [verified()], [
					{ job_id: "job-1", amount: 400 },
				]) as never,
			)
			.mockResolvedValueOnce({ status: "approved", total: 600 } as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([
			{ total: 300, tax_amount: 0, lines: [] },
		] as never);

		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBe("This refund and the others against the same purchase would exceed it");
	});

	// `total` is client-editable and defaults to 0, so a refund that leaves it
	// blank while a line alone claims far more than the parent ever gave back
	// must be measured by its lines, not by the number it happened to submit.
	it("refuses a refund whose lines claim more than its own (deflated) total admits", async () => {
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce(
				purchase(
					{ kind: "refund", parent_purchase_id: "parent", total: 0 },
					[verified({ line_total: 5000 })],
					[{ job_id: "job-1", amount: 5000 }],
				) as never,
			)
			.mockResolvedValueOnce({ status: "approved", total: 600 } as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([]);

		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBe("This refund and the others against the same purchase would exceed it");
	});

	it("puts stock back where the parent put it, capped at what came in", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			id: PURCHASE,
			status: "pending_review",
			kind: "refund",
			parent_purchase_id: "parent",
			technician_id: TECH,
			supplier_id: null,
			total: 50,
			flags: [],
			lines: [
				{
					id: "rl1",
					quantity: 5,
					unit_price: 10,
					inventory_item_id: ITEM_UUID,
					disposition: "receive",
					disposition_vehicle_id: null,
				},
			],
		} as never);
		mockDb.organization.findFirst.mockResolvedValue({ timezone: "UTC" } as never);
		// Two reads: the parent's intake, then whatever earlier refunds already gave
		// back. Answering both with the intake would look like it was fully returned.
		parentIntake([{ inventory_item_id: ITEM_UUID, disposition_vehicle_id: VEHICLE_UUID, quantity: 2 }]);

		await reviewPurchase(ORG, PURCHASE, { decision: "approve" }, { dispatcherId: DISPATCHER });

		expect(mockRecordMovements.mock.calls[0][3]).toEqual([
			expect.objectContaining({
				qty: 2,
				from_location_type: "vehicle",
				from_vehicle_id: VEHICLE_UUID,
				to_location_type: "external",
				reason: "reversal",
			}),
		]);
		expect(tx.field_purchase.updateMany.mock.calls[0][0].data.flags).toEqual([
			expect.objectContaining({ code: "refund_unsettled" }),
		]);
	});

	// Two refunds against one purchase, each for everything that came in: the
	// second has nothing left to give back, and reversing again would invent stock.
	it("counts what earlier refunds already returned", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			id: PURCHASE,
			status: "pending_review",
			kind: "refund",
			parent_purchase_id: "parent",
			technician_id: TECH,
			supplier_id: null,
			total: 20,
			flags: [],
			lines: [
				{
					id: "rl2",
					quantity: 2,
					unit_price: 10,
					inventory_item_id: ITEM_UUID,
					disposition: "receive",
					disposition_vehicle_id: null,
				},
			],
		} as never);
		mockDb.organization.findFirst.mockResolvedValue({ timezone: "UTC" } as never);
		parentIntake(
			[{ inventory_item_id: ITEM_UUID, disposition_vehicle_id: null, quantity: 2 }],
			[{ inventory_item_id: ITEM_UUID, quantity: 2 }],
		);

		await reviewPurchase(ORG, PURCHASE, { decision: "approve" }, { dispatcherId: DISPATCHER });

		expect(mockRecordMovements).not.toHaveBeenCalled();
	});

	it("clears the unsettled flag only once the credit lands", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			id: PURCHASE,
			kind: "refund",
			status: "approved",
			refund_settled_at: null,
			flags: [{ code: "refund_unsettled", message: "waiting" }],
		} as never);

		await settleRefund(ORG, PURCHASE, { dispatcherId: DISPATCHER });

		const data = tx.field_purchase.updateMany.mock.calls[0][0].data;
		expect(data.refund_settled_at).toBeInstanceOf(Date);
		expect(data.flags).toEqual([]);
	});

	it("refuses to delete a submitted purchase as a state problem, not an authority one", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.field_purchase.findFirst.mockResolvedValue(purchase({ status: "pending_review" }) as any);
		const result = await deletePurchase(ORG, PURCHASE, { techId: TECH });
		expect(result.err).toBe("This purchase is not a draft, so it cannot be deleted");
	});

	it("refuses to settle a non-refund as a state problem", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		mockDb.field_purchase.findFirst.mockResolvedValue(purchase({ kind: "purchase", status: "approved" }) as any);
		const result = await settleRefund(ORG, PURCHASE, { dispatcherId: DISPATCHER });
		expect(result.err).toBe("Only refunds can be settled");
	});
});

describe("refund context on the detail read", () => {
	const refundRow = (over: Record<string, unknown> = {}) => ({
		id: "r",
		status: "pending_review",
		total: 0,
		tax_amount: 0,
		refund_settled_at: null,
		created_at: new Date("2026-09-01T00:00:00Z"),
		lines: [],
		...over,
	});

	it("summarises what is open, approved, settled and left on an approved purchase", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ kind: "purchase", status: "approved", total: 100 }) as never,
		);
		mockDb.field_purchase_event.findMany.mockResolvedValue([] as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([
			refundRow({ id: "d", status: "draft", total: 5 }),
			refundRow({ id: "p", status: "pending_review", total: 42 }),
			refundRow({ id: "a", status: "approved", total: 10 }),
			refundRow({ id: "s", status: "approved", total: 8, refund_settled_at: new Date() }),
			refundRow({ id: "x", status: "rejected", total: 99 }),
		] as never);

		const res = await getPurchase(ORG, PURCHASE, { techId: TECH });
		const summary = (res.purchase as { refund_summary: Record<string, unknown> }).refund_summary;
		expect(summary).toMatchObject({
			draft_id: "d",
			in_progress_count: 1,
			in_progress_value: "42",
			approved_value: "10",
			settled_value: "8",
			// Drafts and rejections claim nothing.
			remaining: "40",
		});
	});

	it("says what each refund returned, and when", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ kind: "purchase", status: "approved", total: 100 }) as never,
		);
		mockDb.field_purchase_event.findMany.mockResolvedValue([] as never);
		const returned = new Date("2026-09-02T15:00:00Z");
		mockDb.field_purchase.findMany.mockResolvedValueOnce([
			refundRow({
				purchased_at: returned,
				lines: [{ line_total: 40, inventory_item_id: null, quantity: 2, description: "Capacitor" }],
			}),
		] as never);

		const res = await getPurchase(ORG, PURCHASE, { techId: TECH });
		const [row] = (res.purchase as { refund_summary: { refunds: unknown[] } }).refund_summary.refunds;
		expect(row).toMatchObject({
			returned_at: returned,
			parts: [{ description: "Capacitor", quantity: "2" }],
		});
	});

	it("never reports a negative remainder", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ kind: "purchase", status: "approved", total: 50 }) as never,
		);
		mockDb.field_purchase_event.findMany.mockResolvedValue([] as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([
			refundRow({ status: "approved", total: 0, lines: [{ line_total: 80 }] }),
		] as never);

		const res = await getPurchase(ORG, PURCHASE, { techId: TECH });
		expect((res.purchase as { refund_summary: { remaining: string } }).refund_summary.remaining).toBe("0");
	});

	it("carries no summary on a purchase that cannot be refunded yet", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue(
			purchase({ kind: "purchase", status: "pending_review" }) as never,
		);
		mockDb.field_purchase_event.findMany.mockResolvedValue([] as never);

		const res = await getPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.purchase).not.toHaveProperty("refund_summary");
	});

	it("gives a refund its parent, net of what sibling refunds already claim", async () => {
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce(
				purchase({ kind: "refund", parent_purchase_id: "parent", status: "draft" }) as never,
			)
			.mockResolvedValueOnce({
				id: "parent",
				vendor_name: "Grainger",
				total: 120,
				purchased_at: new Date("2026-08-21T15:00:00Z"),
				lines: [
					{
						id: "pl-1",
						description: "Capacitor",
						inventory_item_id: ITEM_UUID,
						unit_price: 20,
						quantity: 3,
						disposition: "receive",
						disposition_vehicle: { name: "Van 2" },
					},
					{
						id: "pl-2",
						description: "Tape",
						inventory_item_id: null,
						unit_price: 5,
						quantity: 1,
						disposition: "non_stock",
						disposition_vehicle: null,
					},
				],
			} as never);
		mockDb.field_purchase_event.findMany.mockResolvedValue([] as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([
			refundRow({
				status: "pending_review",
				total: 40,
				lines: [{ line_total: 40, inventory_item_id: ITEM_UUID, quantity: 2 }],
			}),
		] as never);

		const res = await getPurchase(ORG, PURCHASE, { techId: TECH });
		const parent = (res.purchase as { parent: Record<string, unknown> }).parent;
		expect(parent).toMatchObject({ id: "parent", vendor_name: "Grainger", remaining: "80" });
		expect(parent.lines).toEqual([
			expect.objectContaining({ id: "pl-1", returnable_qty: "1", vehicle_name: "Van 2" }),
			expect.objectContaining({ id: "pl-2", returnable_qty: "1", disposition: "non_stock" }),
		]);
	});
});

describe("refund creation and submit guards", () => {
	it("goes back to the technician's open draft instead of starting another", async () => {
		mockDb.field_purchase.findFirst.mockResolvedValue({
			id: "parent",
			kind: "purchase",
			status: "approved",
			technician_id: TECH,
			vendor_name: "Grainger",
			supplier_id: null,
			allocations: [],
		} as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([
			purchase({ id: "refund-open", kind: "refund", parent_purchase_id: "parent" }),
		] as never);

		const res = await createRefund(ORG, TECH, { parent_purchase_id: PARENT_UUID });
		expect((res.purchase as { id: string }).id).toBe("refund-open");
		expect(tx.field_purchase.create).not.toHaveBeenCalled();
	});

	it("refuses a refund that credits a job the purchase never covered", async () => {
		mockDb.field_purchase.findFirst
			.mockResolvedValueOnce(
				purchase({ kind: "refund", parent_purchase_id: "parent", total: 50 }, [verified()], [
					{ job_id: "job-other", amount: 50 },
				]) as never,
			)
			.mockResolvedValueOnce({
				status: "approved",
				total: 100,
				allocations: [{ job_id: "job-1" }],
			} as never);
		mockDb.field_purchase.findMany.mockResolvedValueOnce([]);

		const res = await submitPurchase(ORG, PURCHASE, { techId: TECH });
		expect(res.err).toBe("A refund can only credit jobs the original purchase was for");
	});
});
