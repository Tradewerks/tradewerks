import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be before any import that resolves to them) ───────────────────

// requirePermission is mocked to tag the middleware with the permission string
// it closes over (same technique as disputeRoutePermissions.test.ts) — this
// both lets requests through without a real permission check and lets the
// "requires edit_quotes" test read the gate off the mounted handler.
vi.mock("../../lib/requirePermissions.js", () => ({
	requirePermission: (permission: string) => {
		const mw = (_req: unknown, _res: unknown, next: () => void) => next();
		(mw as unknown as { __permission: string }).__permission = permission;
		return mw;
	},
}));

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateQuoteNumber: vi.fn(),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));

vi.mock("../../services/quoteRevision.js", () => ({
	createQuoteRevision: vi.fn(),
}));

vi.mock("../../controllers/quotesController.js", () => ({
	getAllQuotes: vi.fn(),
	getQuoteById: vi.fn(),
	insertQuote: vi.fn(),
	updateQuote: vi.fn(),
	deleteQuote: vi.fn(),
	getQuoteItems: vi.fn(),
	getQuoteItemById: vi.fn(),
	insertQuoteItem: vi.fn(),
	updateQuoteItem: vi.fn(),
	deleteQuoteItem: vi.fn(),
}));

vi.mock("../../services/emailService.js", () => ({
	sendQuoteEmail: vi.fn(),
}));

vi.mock("../../lib/pdf/pdfService.js", () => ({
	generateQuotePdf: vi.fn(),
}));

vi.mock("../../services/followupTriggers.js", () => ({
	onQuoteSent: vi.fn(),
}));

vi.mock("../../controllers/quoteNotesController.js", () => ({
	getQuoteNotes: vi.fn(),
	insertQuoteNote: vi.fn(),
	updateQuoteNote: vi.fn(),
	deleteQuoteNote: vi.fn(),
}));

vi.mock("../../controllers/disputesController.js", () => ({
	disputeErrorResponse: vi.fn(),
	listDisputes: vi.fn(),
	postDispute: vi.fn(),
	postResolution: vi.fn(),
}));

vi.mock("../../controllers/logsController.js", () => ({
	getEntityHistory: vi.fn(),
	parseHistoryLimit: vi.fn().mockReturnValue(50),
	INVALID_HISTORY_LIMIT: Symbol("INVALID_HISTORY_LIMIT"),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import quotesRouter from "../quotes.js";
import { callRoute, getHandlers } from "./harness.js";
import { createQuoteRevision } from "../../services/quoteRevision.js";

const mockCreateQuoteRevision = vi.mocked(createQuoteRevision);

beforeEach(() => {
	vi.clearAllMocks();
});

const revise = (id = "q1") =>
	callRoute(quotesRouter, "post", "/:id/revise", { params: { id } });

/**
 * Route-level coverage for POST /quotes/:id/revise. createQuoteRevision itself
 * is covered by quoteRevision.test.ts — this file's job is the parts only the
 * route owns: the permission gate, the 404-vs-422 split (422 was chosen over
 * the brief's 400 to match the sibling /reject and /cancel handlers), and
 * shaping a success through createSuccessResponse.
 */
describe("POST /quotes/:id/revise", () => {
	it("requires edit_quotes", () => {
		const permissions = getHandlers(quotesRouter, "post", "/:id/revise")
			.map(
				(h) => (h as unknown as { __permission?: string }).__permission,
			)
			.filter((p): p is string => typeof p === "string");

		expect(permissions).toEqual(["edit_quotes"]);
	});

	it("returns 404 when the quote is not found", async () => {
		mockCreateQuoteRevision.mockResolvedValue({
			err: "Quote not found",
			notFound: true,
		});

		const res = await revise("nope");

		expect(res.status).toBe(404);
		expect(res.body.success).toBe(false);
		expect(res.body.error.message).toBe("Quote not found");
	});

	it("returns 422 for a refusal that is not a not-found", async () => {
		mockCreateQuoteRevision.mockResolvedValue({
			err: "A Draft quote cannot be revised. Revisions may be created from: Issued, Approved, Rejected, Expired.",
		});

		const res = await revise();

		expect(res.status).toBe(422);
		expect(res.body.success).toBe(false);
		expect(res.body.error.message).toContain("Draft");
	});

	it("returns the created revision through createSuccessResponse on success", async () => {
		mockCreateQuoteRevision.mockResolvedValue({
			id: "q2",
			quote_number: "Q-1043",
		});

		const res = await revise();

		expect(mockCreateQuoteRevision).toHaveBeenCalledWith("q1", "org-1", {
			dispatcherId: "disp-1",
		});
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.data).toEqual({ id: "q2", quote_number: "Q-1043" });
	});
});
