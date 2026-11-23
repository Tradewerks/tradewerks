import { describe, it, expect, vi, beforeEach } from "vitest";

// Same hoisted shape as disputes.quote.test.ts, so db.js and lib/context.js
// share one instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		client: { findUnique: vi.fn(), update: vi.fn() },
		quote: { findUnique: vi.fn(), update: vi.fn() },
		request: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
		document_dispute: { findFirst: vi.fn() },
		job: { create: vi.fn(), findUnique: vi.fn() },
		job_line_item: { createMany: vi.fn() },
		technician: { findMany: vi.fn() },
		tax_group: { count: vi.fn(async () => 1) },
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
});

vi.mock("../../db.js", () => ({
	db: mockDb,
	generateJobNumber: vi.fn(async () => "J-0042"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(() => mockDb),
	getUserContext: vi.fn(() => ({ dispatcherId: "d1" })),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn().mockResolvedValue(undefined),
	buildChanges: vi.fn().mockReturnValue({}),
}));

vi.mock("../../services/appLogger.js", () => ({
	log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../../services/socketService.js", () => ({
	getSocket: vi.fn(() => ({ emit: vi.fn() })),
}));

const { taxMode, recomputeJobTotals, lockDocumentTaxSnapshot } = vi.hoisted(() => ({
	taxMode: vi.fn(async () => "manual"),
	recomputeJobTotals: vi.fn(async () => ({ ok: true })),
	lockDocumentTaxSnapshot: vi.fn(async () => undefined),
}));
vi.mock("../../services/tax/taxMode.js", () => ({
	getEffectiveTaxMode: taxMode,
	dropClientTaxTotals: <T,>(p: T) => p,
}));
vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeJobTotals,
	lockDocumentTaxSnapshot,
	holdsKeptRate: vi.fn(async () => false),
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { insertJob } from "../jobsController.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const CLIENT = "3f1c2a8e-9b4d-4c6a-8e2f-1a2b3c4d5e6f";
const QUOTE = "7a9e4b21-5c3d-4f8a-9b1e-2c4d6e8f0a1b";

const convert = (body: Record<string, unknown> = {}) =>
	insertJob(
		{
			body: { client_id: CLIENT, quote_id: QUOTE, ...body },
			user: { organization_id: "org1" },
		} as unknown as Request,
		{ dispatcherId: "d1" },
	);

const aQuote = (overrides: Record<string, unknown> = {}) => ({
	id: QUOTE,
	client_id: CLIENT,
	issued_at: new Date("2026-01-01T00:00:00Z"),
	approved_at: null,
	approved_via: null,
	status: "Sent",
	title: "Replace condenser",
	description: "Swap the failed unit",
	address: "1 Main St",
	coords: { lat: 30.2, lon: -97.7 },
	priority: "Medium",
	total: 1200,
	subtotal: 1200,
	tax_rate: 0,
	tax_amount: 0,
	discount_type: null,
	discount_value: null,
	discount_amount: null,
	request_id: "r1",
	line_items: [],
	job: null,
	request: { id: "r1", status: "Quoted", jobs: [] },
	...overrides,
});

/**
 * Conversion wrote the quote to Approved with no dispute, sold-work or status
 * check. Under an open dispute that is a deadlock only a DB edit could clear;
 * on work a sibling quote already sold it bills the client twice. The page gates
 * both, but a stale tab or a direct API call does not go through the page.
 */
describe("converting a quote to a job", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.client.findUnique).mockResolvedValue({ id: CLIENT });
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		mockFn(db.job.create).mockResolvedValue({
			id: "j1",
			job_number: "J-0042",
			name: "Replace condenser",
			priority: "Medium",
			status: "Unscheduled",
			client_id: CLIENT,
		});
		mockFn(db.job.findUnique).mockResolvedValue({ id: "j1" });
		mockFn(db.request.updateMany).mockResolvedValue({ count: 1 });
	});

	it("refuses a quote under an open dispute and leaves it untouched", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote({ status: "Disputed" }));
		mockFn(db.document_dispute.findFirst).mockResolvedValue({ id: "disp1" });

		const result = await convert();

		expect(result.err).toBe(
			"This quote is under dispute — resolve the dispute before converting it to a job.",
		);
		expect(db.document_dispute.findFirst).toHaveBeenCalledWith({
			where: { quote_id: QUOTE, status: "Open" },
			select: { id: true },
		});
		expect(db.quote.update).not.toHaveBeenCalled();
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("refuses work a sibling quote on the request already sold", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(
			aQuote({
				request: {
					id: "r1",
					status: "ConvertedToJob",
					jobs: [{ id: "j9", job_number: "J-0009", quote_id: "q-sibling" }],
				},
			}),
		);

		const result = await convert();

		expect(result.err).toMatch(/Another quote on this request was already sold as a job/);
		expect(db.job.create).not.toHaveBeenCalled();
		// The load has to bring the evidence, or the check silently passes.
		expect(mockFn(db.quote.findUnique).mock.calls[0][0].include).toMatchObject({
			job: { select: { id: true } },
			request: { include: { jobs: { where: { quote_id: { not: null } } } } },
		});
	});

	it("refuses a quote that already became a job", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote({ job: { id: "j1" } }));

		const result = await convert();

		expect(result.err).toBe("A job was already created from this quote.");
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("refuses a dead quote", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote({ status: "Expired" }));

		const result = await convert();

		expect(result.err).toBe("An expired quote can't be converted to a job.");
		expect(db.quote.update).not.toHaveBeenCalled();
	});

	// The transition table has no Draft → Approved edge, yet a Draft quote
	// converts today; the gate must not quietly take that away.
	it.each(["Draft", "Sent", "Approved"])("still converts a %s quote", async (status) => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote({ status }));

		const result = await convert();

		expect(result.err).toBe("");
		expect(db.quote.update).toHaveBeenCalledWith({
			where: { id: QUOTE },
			data: expect.objectContaining({ status: "Approved" }),
		});
	});

	it("refuses with WRONG_STATE when the request already has a job", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote());
		mockFn(db.request.updateMany).mockResolvedValue({ count: 0 });

		const result = await convert();

		expect(result.err).toBe("This request already has a job.");
		expect(result.code).toBe("WRONG_STATE");
		expect(mockFn(db.request.updateMany).mock.calls[0][0]).toMatchObject({
			where: { id: "r1", status: { notIn: ["ConvertedToJob", "Cancelled"] } },
		});
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("refuses with WRONG_STATE when the quote's request was cancelled", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote());
		mockFn(db.request.updateMany).mockResolvedValue({ count: 0 });
		mockFn(db.request.findUnique).mockResolvedValue({ status: "Cancelled" });

		const result = await convert();

		expect(result).toMatchObject({
			err: "This request was cancelled.",
			code: "WRONG_STATE",
		});
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("refuses a body request_id that isn't the quote's request, before writing anything", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote());

		const result = await convert({ request_id: "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f" });

		expect(result.err).toBe("This request isn't the quote's request.");
		expect("code" in result ? result.code : undefined).toBeUndefined();
		expect(db.quote.update).not.toHaveBeenCalled();
		expect(db.request.updateMany).not.toHaveBeenCalled();
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("writes the quote's request_id on the job, whatever the body omits", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote());

		const result = await convert();

		expect(result.err).toBe("");
		expect(mockFn(db.job.create).mock.calls[0][0].data.request_id).toBe("r1");
	});

	// Database errors carry internals; they go to the 500 handler, not the caller.
	it("rethrows a database error instead of returning its message", async () => {
		const dbErr = Object.assign(new Error("connection reset by peer at 10.0.0.5"), { name: "PrismaClientUnknownRequestError" });
		mockFn(db.quote.findUnique).mockRejectedValue(dbErr);

		await expect(convert()).rejects.toBe(dbErr);
	});

	it("maps a lost quote_id unique race to CONFLICT", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote());
		const { Prisma } = await import("../../../generated/prisma/client.js");
		mockFn(db.job.create).mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError("dup", {
				code: "P2002",
				clientVersion: "x",
				meta: { target: ["quote_id"] },
			}),
		);

		const result = await convert();

		expect(result.err).toBe("This quote was already converted to a job.");
		expect(result.code).toBe("CONFLICT");
	});

	it("quote conversion with another client's id is refused", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(aQuote({ client_id: "someone-else" }));

		const result = await convert();

		expect(result.err).toMatch(/different client/);
		expect(db.quote.update).not.toHaveBeenCalled();
		expect(db.job.create).not.toHaveBeenCalled();
	});

	it("converting a Draft quote sets issued_at, approved_at and locks the tax snapshot", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(
			aQuote({ status: "Draft", issued_at: null }),
		);

		const result = await convert();

		expect(result.err).toBe("");
		const data = mockFn(db.quote.update).mock.calls[0][0].data;
		expect(data).toMatchObject({ status: "Approved", approved_via: "staff" });
		expect(data.issued_at).toBeInstanceOf(Date);
		expect(data.approved_at).toBeInstanceOf(Date);
		expect(lockDocumentTaxSnapshot).toHaveBeenCalledWith(
			"quote",
			QUOTE,
			"org1",
			mockDb,
			data.issued_at,
		);
	});

	it("keeps an existing approval stamp and does not relock an issued quote", async () => {
		const approvedAt = new Date("2026-02-01T00:00:00Z");
		mockFn(db.quote.findUnique).mockResolvedValue(
			aQuote({ status: "Approved", approved_at: approvedAt, approved_via: "client" }),
		);

		await convert();

		const data = mockFn(db.quote.update).mock.calls[0][0].data;
		expect(data).not.toHaveProperty("approved_at");
		expect(data).not.toHaveProperty("approved_via");
		expect(data).not.toHaveProperty("issued_at");
		expect(lockDocumentTaxSnapshot).not.toHaveBeenCalled();
	});

	it("carries each quote line's taxable flag and tax group onto the job", async () => {
		mockFn(db.quote.findUnique).mockResolvedValue(
			aQuote({
				line_items: [
					{
						name: "Labor",
						description: null,
						quantity: 1,
						unit_price: 100,
						total: 100,
						item_type: "labor",
						inventory_item_id: null,
						taxable: false,
						tax_group_id: "11111111-1111-4111-8111-111111111111",
					},
				],
			}),
		);

		await convert();

		const line = mockFn(db.job_line_item.createMany).mock.calls[0][0].data[0];
		expect(line).toMatchObject({
			taxable: false,
			tax_group_id: "11111111-1111-4111-8111-111111111111",
		});
		for (const k of ["tax_category", "taxability_source", "work_class"]) {
			expect(line).not.toHaveProperty(k);
		}
		expect(mockFn(db.job.create).mock.calls[0][0].data).not.toHaveProperty("work_class");
		expect(recomputeJobTotals).not.toHaveBeenCalled();
	});

	it("recomputes the new job server-side in auto mode", async () => {
		taxMode.mockResolvedValueOnce("auto");
		mockFn(db.quote.findUnique).mockResolvedValue(
			aQuote({
				line_items: [
					{
						name: "Labor",
						description: null,
						quantity: 1,
						unit_price: 100,
						total: 100,
						item_type: "labor",
						inventory_item_id: null,
						taxable: true,
						tax_group_id: null,
					},
				],
			}),
		);

		await convert();

		expect(recomputeJobTotals).toHaveBeenCalledWith("j1", "org1", mockDb);
	});
});
