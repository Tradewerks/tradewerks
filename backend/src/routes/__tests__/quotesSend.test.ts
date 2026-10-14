import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateQuoteNumber: vi.fn().mockResolvedValue("Q-0001"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
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
	sendQuoteEmail: vi.fn().mockResolvedValue(undefined),
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
	listDisputes: vi.fn(),
	postDispute: vi.fn(),
	postResolution: vi.fn(),
}));

vi.mock("../../controllers/logsController.js", () => ({
	getEntityHistory: vi.fn(),
	parseHistoryLimit: vi.fn().mockReturnValue(50),
	INVALID_HISTORY_LIMIT: Symbol("INVALID_HISTORY_LIMIT"),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import quotesRouter from "../quotes.js";
import { callRoute } from "./harness.js";
import { getQuoteById, updateQuote } from "../../controllers/quotesController.js";
import { sendQuoteEmail } from "../../services/emailService.js";

const mockGetQuoteById = vi.mocked(getQuoteById);
const mockUpdateQuote = vi.mocked(updateQuote);
const mockSendQuoteEmail = vi.mocked(sendQuoteEmail);
import { logActivity } from "../../services/logger.js";
const mockLogActivity = vi.mocked(logActivity);

beforeEach(() => {
	vi.clearAllMocks();
});

const send = (body: unknown = { recipient_email: "client@example.com" }) =>
	callRoute(quotesRouter, "post", "/:id/send", { params: { id: "q1" }, body });

/**
 * The status guard used to run AFTER the email. A disputed quote is only kept
 * off the wire by the UI hiding the button, so a direct call or a stale tab
 * mailed the contested document to the client and THEN reported the error.
 */
describe("POST /quotes/:id/send transition guard", () => {
	it("does not email the client when the quote cannot move to Sent", async () => {
		mockGetQuoteById.mockResolvedValue({ id: "q1", status: "Disputed" } as never);

		const res = await send();

		expect(mockSendQuoteEmail).not.toHaveBeenCalled();
		expect(mockUpdateQuote).not.toHaveBeenCalled();
		expect(res.status).toBe(422);
		expect(res.body.error.message).toContain("Disputed");
	});

	it("emails and marks the quote Sent when the transition is legal", async () => {
		mockGetQuoteById.mockResolvedValue({ id: "q1", status: "Issued" } as never);
		mockUpdateQuote.mockResolvedValue({ err: "", item: { id: "q1" } } as never);

		const res = await send();

		expect(mockSendQuoteEmail).toHaveBeenCalledWith(
			"q1",
			"client@example.com",
			"org-1",
		);
		expect(res.body.success).toBe(true);
	});

	// Re-sending is a self-transition, which the table treats as a no-op.
	it("allows a re-send of an already Sent quote", async () => {
		mockGetQuoteById.mockResolvedValue({ id: "q1", status: "Sent" } as never);
		mockUpdateQuote.mockResolvedValue({ err: "", item: { id: "q1" } } as never);

		await send();

		expect(mockSendQuoteEmail).toHaveBeenCalled();
	});

	it("404s without emailing when the quote does not exist", async () => {
		mockGetQuoteById.mockResolvedValue(null as never);

		const res = await send();

		expect(mockSendQuoteEmail).not.toHaveBeenCalled();
		expect(res.status).toBe(404);
	});
});

// makeReq defaults role:"admin", which resolvePerms short-circuits past the
// permission array entirely — so every gate test has to name a real tier.
const sendAs = (permissions: string[]) =>
	callRoute(quotesRouter, "post", "/:id/send", {
		params: { id: "q1" },
		body: { recipient_email: "client@example.com" },
		user: { role: "dispatcher", permissions },
	});

describe("POST /quotes/:id/send permission gate", () => {
	beforeEach(() => {
		mockGetQuoteById.mockResolvedValue({ id: "q1", status: "Issued" } as never);
		mockUpdateQuote.mockResolvedValue({ err: "", item: { id: "q1" } } as never);
	});

	// The claim of the whole change: send is independent of edit. Holding
	// edit_quotes is what used to authorise this route, so if the gate were
	// still edit_quotes — or an OR of the two — this test would pass a send
	// through and fail.
	it("403s a role holding edit_quotes but not send_quotes", async () => {
		const res = await sendAs(["view_quotes", "edit_quotes"]);

		expect(res.status).toBe(403);
		expect(mockSendQuoteEmail).not.toHaveBeenCalled();
	});

	// The other half of independence: a clerk who mails finished quotes without
	// the rights to change what is in them.
	it("allows a role holding send_quotes but not edit_quotes", async () => {
		const res = await sendAs(["view_quotes", "send_quotes"]);

		expect(res.status).toBe(200);
		expect(mockSendQuoteEmail).toHaveBeenCalled();
	});

	it("403s a role holding neither", async () => {
		const res = await sendAs(["view_quotes"]);

		expect(res.status).toBe(403);
		expect(mockSendQuoteEmail).not.toHaveBeenCalled();
	});
});

/**
 * The transition guard runs before the send, so an illegal move never reaches
 * Postmark. The reverse was never covered: a send that Postmark REJECTS must
 * also leave the quote where it was, or the board shows a quote the client
 * never received as Sent.
 */
// The shape translateSendError actually produces: an operator-facing message,
// with the provider's own wording kept beside it for the log only.
const sendFailure = (providerMessage: string) =>
	Object.assign(
		new Error(
			"Email could not be sent. Email sending is not enabled for this account — contact your administrator.",
		),
		{ code: "EMAIL_SEND_FAILED", status: 502, providerMessage },
	);

describe("POST /quotes/:id/send delivery failure", () => {
	beforeEach(() => {
		mockGetQuoteById.mockResolvedValue({ id: "q1", status: "Issued" } as never);
		mockUpdateQuote.mockResolvedValue({ err: "", item: { id: "q1" } } as never);
	});

	it("leaves the quote in its prior status when delivery fails", async () => {
		mockSendQuoteEmail.mockRejectedValueOnce(
			sendFailure("Postmark rejected the send."),
		);

		const res = await send();

		expect(mockUpdateQuote).not.toHaveBeenCalled();
		expect(res.status).toBe(502);
		expect(res.body.error.code).toBe("EMAIL_SEND_FAILED");
	});

	// The raw Postmark string names the sending domain, the recipient domain and
	// the account's approval state. A dispatcher can act on none of it.
	it("does not leak the raw provider message to the caller", async () => {
		mockSendQuoteEmail.mockRejectedValueOnce(
			sendFailure(
				"While your account is pending approval, all recipient addresses must share the same domain as the 'From' address. The domain of the 'From' address is 'epicitautomations.com'.",
			),
		);

		const res = await send();

		expect(res.body.error.message).not.toContain("pending approval");
		expect(res.body.error.message).not.toContain("epicitautomations.com");
	});

	it("records the failure so it is visible outside the server log", async () => {
		mockSendQuoteEmail.mockRejectedValueOnce(
			sendFailure("Postmark rejected the send."),
		);

		await send();

		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "quote.send_failed",
				entity_type: "quote",
				entity_id: "q1",
			}),
		);
	});
});

/**
 * Not everything a send throws has been through translateSendError. The quote
 * lookup and the PDF render run before the Postmark call is wrapped, so a
 * @react-pdf render throw or a Prisma error arrives here as a plain Error whose
 * message was written for a stack trace, not for a dispatcher.
 */
describe("POST /quotes/:id/send untranslated failure", () => {
	beforeEach(() => {
		mockGetQuoteById.mockResolvedValue({ id: "q1", status: "Issued" } as never);
		mockUpdateQuote.mockResolvedValue({ err: "", item: { id: "q1" } } as never);
	});

	it("answers generically instead of echoing an internal error message", async () => {
		mockSendQuoteEmail.mockRejectedValueOnce(
			new Error("Cannot read properties of undefined (reading 'organization')"),
		);

		const res = await send();

		expect(res.status).toBe(502);
		expect(res.body.error.code).toBe("EMAIL_SEND_FAILED");
		expect(res.body.error.message).not.toContain("undefined");
		expect(res.body.error.message).not.toContain("organization");
		expect(mockUpdateQuote).not.toHaveBeenCalled();
	});

	// Kept out of the response, kept in the record: the whole point of the log
	// row is that someone can find out what actually broke.
	it("still records what actually failed", async () => {
		mockSendQuoteEmail.mockRejectedValueOnce(new Error("PDF render failed"));

		await send();

		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "quote.send_failed",
				reason: "PDF render failed",
			}),
		);
	});

	// A quote that vanished between the existence check and the send is a 404,
	// not a mail failure — restating it as one would send the dispatcher to an
	// administrator over a deleted document.
	it("lets a 404 from the loader stay a 404", async () => {
		mockSendQuoteEmail.mockRejectedValueOnce(
			Object.assign(new Error("Quote not found"), { status: 404 }),
		);

		const res = await send();

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});
});
