import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, taxMode, recomputeDocumentTotals } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findFirst: vi.fn(), update: vi.fn() },
		document_dispute: { findFirst: vi.fn() },
		$transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return {
		mockDb,
		taxMode: vi.fn(async () => "manual"),
		recomputeDocumentTotals: vi.fn(async () => ({ ok: true })),
	};
});

vi.mock("../../db.js", () => ({ db: mockDb }));

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

vi.mock("../../services/entitlementService.js", () => ({
	isModuleOn: vi.fn(),
}));

// The real dropClientTaxTotals, so auto mode genuinely strips client totals.
vi.mock("../../services/tax/taxMode.js", async (importActual) => ({
	...(await importActual<typeof import("../../services/tax/taxMode.js")>()),
	getEffectiveTaxMode: taxMode,
}));

vi.mock("../../lib/recomputeDocumentTotals.js", () => ({
	recomputeDocumentTotals,
	lockDocumentTaxSnapshot: vi.fn(),
}));

import type { Request } from "express";
import { db } from "../../db.js";
import { insertQuote, updateQuote } from "../quotesController.js";
import { lockDocumentTaxSnapshot } from "../../lib/recomputeDocumentTotals.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const makeReq = (body: Record<string, unknown>) =>
	({ params: { id: "q1" }, body }) as unknown as Request;

const aDraftQuote = () => ({
	id: "q1",
	status: "Draft",
	quote_number: "Q-1001",
	address: "1 Main St",
	line_items: [],
	job: null,
	tax_snapshot: { locked_at: "draft" },
});

describe("updateQuote tax totals", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.quote.findFirst).mockResolvedValue(aDraftQuote());
		mockFn(db.quote.update).mockResolvedValue({ id: "q1" });
	});

	it("applies a discount-only edit on a draft-snapshot quote and recomputes (manual mode)", async () => {
		const result = await updateQuote(
			makeReq({ discount_type: "percent", discount_value: 10 }),
			"org1",
		);

		expect(result.err).toBeFalsy();
		expect(db.quote.update).toHaveBeenCalledWith({
			where: { id: "q1" },
			data: { discount_type: "percent", discount_value: 10 },
		});
		expect(recomputeDocumentTotals).toHaveBeenCalledWith(
			"quote",
			"q1",
			"org1",
			mockDb,
			undefined,
		);
	});

	it("ignores client totals in auto mode", async () => {
		taxMode.mockResolvedValueOnce("auto");

		const result = await updateQuote(
			makeReq({
				title: "New title",
				subtotal: 50,
				tax_amount: 5,
				total: 55,
			}),
			"org1",
		);

		expect(result.err).toBeFalsy();
		for (const [arg] of mockFn(db.quote.update).mock.calls) {
			expect(arg.data).not.toHaveProperty("subtotal");
			expect(arg.data).not.toHaveProperty("tax_amount");
			expect(arg.data).not.toHaveProperty("total");
		}
		expect(
			mockFn(db.quote.update).mock.calls.at(-1)![0].data,
		).toMatchObject({
			title: "New title",
		});
	});
});

describe("updateQuote auto-mode finalize", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFn(db.quote.findFirst).mockResolvedValue(aDraftQuote());
		mockFn(db.quote.update).mockResolvedValue({ id: "q1" });
		mockFn(db.document_dispute.findFirst).mockResolvedValue(null);
		taxMode.mockResolvedValue("auto");
	});

	it("finalizes Draft→Issued and locks the snapshot, with no taxability gate", async () => {
		const result = await updateQuote(makeReq({ status: "Issued" }), "org1");

		expect(result.err).toBe("");
		expect(db.quote.update).toHaveBeenCalled();
		expect(lockDocumentTaxSnapshot).toHaveBeenCalledWith(
			"quote",
			"q1",
			"org1",
			mockDb,
			expect.any(Date),
		);
	});

	it("refuses line edits and finalize in one auto-mode request", async () => {
		const result = await updateQuote(
			makeReq({ status: "Issued", line_items: [{ name: "X", quantity: 1, unit_price: 5 }] }),
			"org1",
		);
		expect(result).toEqual({ err: "Save changes before finalizing." });
		expect(db.quote.update).not.toHaveBeenCalled();
	});
});

describe("insertQuote finalize bypass", () => {
	beforeEach(() => vi.clearAllMocks());

	it("refuses creating a quote past Draft in auto mode", async () => {
		taxMode.mockResolvedValue("auto");
		const result = await insertQuote(
			makeReq({
				client_id: "6f1d2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b",
				title: "Q",
				status: "Sent",
			}),
			"org1",
		);
		expect(result).toEqual({ err: "New quotes start as drafts. Create or send it from the quote." });
		expect(mockDb.$transaction).not.toHaveBeenCalled();
	});
});
