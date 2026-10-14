import { describe, it, expect, vi, beforeEach } from "vitest";

// Same hoisted shape as disputes.quote.test.ts, so db.js and lib/context.js
// share one instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		client: { findUnique: vi.fn(), update: vi.fn() },
		quote: { findUnique: vi.fn(), update: vi.fn() },
		request: { findUnique: vi.fn(), update: vi.fn() },
		document_dispute: { findFirst: vi.fn() },
		job: { create: vi.fn(), findUnique: vi.fn() },
		job_line_item: { createMany: vi.fn() },
		technician: { findMany: vi.fn() },
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

import type { Request } from "express";
import { db } from "../../db.js";
import { insertJob } from "../jobsController.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

const CLIENT = "3f1c2a8e-9b4d-4c6a-8e2f-1a2b3c4d5e6f";
const QUOTE = "7a9e4b21-5c3d-4f8a-9b1e-2c4d6e8f0a1b";

const convert = () =>
	insertJob(
		{
			body: { client_id: CLIENT, quote_id: QUOTE },
			user: { organization_id: "org1" },
		} as unknown as Request,
		{ dispatcherId: "d1" },
	);

const aQuote = (overrides: Record<string, unknown> = {}) => ({
	id: QUOTE,
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
			data: { status: "Approved" },
		});
	});
});
