import { describe, it, expect, vi, beforeEach } from "vitest";

// Built via vi.hoisted (not a plain module-scope require, which vitest's ESM mock
// factories can't resolve) so both the db.js and lib/context.js mocks below share
// the exact same mock instance.
const { mockDb } = vi.hoisted(() => {
	const $extends = vi.fn();
	const mockDb = {
		quote: {
			findFirst: vi.fn(),
		},
		// getQuoteById now resolves the revision chain through
		// resolveDocumentLineage, which reaches for $queryRaw on this same
		// scoped client. Without the stub every case in this file throws
		// "$queryRaw is not a function" before reaching its assertions.
		$queryRaw: vi.fn().mockResolvedValue([]),
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

import { db } from "../../db.js";
import { getQuoteById, getQuoteDetail } from "../quotesController.js";

const mockFn = (f: unknown) => f as ReturnType<typeof vi.fn>;

describe("getQuoteById revision chain", () => {
	beforeEach(() => vi.clearAllMocks());

	it("returns both directions of the revision chain", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1043",
			version: 2,
			status: "Issued",
			previous_quote: {
				id: "q1",
				quote_number: "Q-1042",
				version: 1,
				status: "Revised",
			},
			revised_quote: null,
			line_items: [],
		});

		const result = await getQuoteById("q2", "org1");

		expect(result.previous_quote).toEqual({
			id: "q1",
			quote_number: "Q-1042",
			version: 1,
			status: "Revised",
		});
		expect(result.revised_quote).toBeNull();
		const include = mockFn(db.quote.findFirst).mock.calls[0][0].include;
		expect(include.previous_quote).toEqual({
			select: {
				id: true,
				quote_number: true,
				version: true,
				status: true,
			},
		});
		expect(include.revised_quote).toEqual({
			select: {
				id: true,
				quote_number: true,
				version: true,
				status: true,
			},
		});
	});

	it("attaches the resolved lineage alongside the document", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue({
			id: "q2",
			quote_number: "Q-1043",
			version: 2,
			status: "Revised",
			previous_quote: null,
			revised_quote: null,
			line_items: [],
		});
		mockFn(db.$queryRaw).mockResolvedValue([
			{ id: "q1", number: "Q-1042", version: 1, status: "Revised" },
			{ id: "q2", number: "Q-1043", version: 2, status: "Revised" },
			{ id: "q3", number: "Q-1044", version: 3, status: "Sent" },
		]);

		const result = await getQuoteDetail("q2", "org1");

		expect(result!.quote_number).toBe("Q-1043");
		expect(result!.lineage!.self_version).toBe(2);
		expect(result!.lineage!.final.id).toBe("q3");
		expect(result!.lineage!.successor!.id).toBe("q3");
	});

	it("returns null without resolving a chain when the quote is missing", async () => {
		mockFn(db.quote.findFirst).mockResolvedValue(null);

		const result = await getQuoteDetail("nope", "org1");

		expect(result).toBeNull();
		expect(mockFn(db.$queryRaw)).not.toHaveBeenCalled();
	});
});
