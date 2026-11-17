import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: { findFirst: vi.fn() },
		quote_line_item: { findFirst: vi.fn() },
		$transaction: vi.fn(async () => {
			throw new Error("reached transaction");
		}),
		$extends,
	};
	$extends.mockReturnValue(mockDb);
	return { mockDb };
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

import { insertQuoteItem, updateQuoteItem, deleteQuoteItem } from "../quotesController.js";

const item = { name: "Widget", quantity: 1, unit_price: 10 };

const calls = [
	["insert", () => insertQuoteItem("q1", item, "org-1")],
	["update", () => updateQuoteItem("q1", "i1", { quantity: 2 }, "org-1")],
	["delete", () => deleteQuoteItem("q1", "i1", "org-1")],
] as const;

const setQuote = (quote: { status: string; job: unknown }) => {
	mockDb.quote.findFirst.mockResolvedValue(quote);
	mockDb.quote_line_item.findFirst.mockResolvedValue({ id: "i1", quote_id: "q1", quote });
};

beforeEach(() => vi.clearAllMocks());

describe("quote line items are locked like the edit screen", () => {
	describe.each(calls)("%s", (_name, call) => {
		it.each(["Approved", "Disputed", "Rejected", "Revised", "Expired", "Cancelled"])(
			"refuses a %s quote",
			async (status) => {
				setQuote({ status, job: null });
				const r = await call();
				expect(r.err).toBe(`Line items can't be changed on a ${status} quote`);
				expect(mockDb.$transaction).not.toHaveBeenCalled();
			},
		);

		it("refuses a quote converted to a job", async () => {
			setQuote({ status: "Sent", job: { id: "j1" } });
			const r = await call();
			expect(r.err).toMatch(/converted to a job/);
			expect(mockDb.$transaction).not.toHaveBeenCalled();
		});

		it.each(["Draft", "Issued", "Sent", "Viewed"])("lets a %s quote through", async (status) => {
			setQuote({ status, job: null });
			await expect(call()).rejects.toThrow("reached transaction");
		});
	});
});
