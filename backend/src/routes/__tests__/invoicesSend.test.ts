import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks (must be before any import that resolves to them) ───────────────────

vi.mock("../../db.js", async () => ({
	db: (await import("./harness.js")).createFakeDb(),
	generateInvoiceNumber: vi.fn().mockResolvedValue("INV-0001"),
}));

vi.mock("../../lib/context.js", () => ({
	getScopedDb: vi.fn(),
	getUserContext: vi.fn().mockReturnValue({ dispatcherId: "disp-1" }),
}));

vi.mock("../../controllers/invoicesController.js", () => ({
	getAllInvoices: vi.fn(),
	getInvoiceById: vi.fn(),
	insertInvoice: vi.fn(),
	updateInvoice: vi.fn(),
	deleteInvoice: vi.fn(),
	recordPayment: vi.fn(),
	deletePayment: vi.fn(),
	recordRefund: vi.fn(),
}));

vi.mock("../../services/emailService.js", () => ({
	sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../services/invoiceService.js", () => ({
	createInvoiceRecord: vi.fn(),
}));

vi.mock("../../lib/pdf/pdfService.js", () => ({
	generateInvoicePdf: vi.fn(),
}));

vi.mock("../../services/followupTriggers.js", () => ({
	onInvoiceSent: vi.fn(),
}));

vi.mock("../../services/invoiceGenerator.js", () => ({
	buildVisitInvoicePayload: vi.fn(),
	buildRecurringPlanInvoicePayload: vi.fn(),
}));

vi.mock("../../controllers/logsController.js", () => ({
	getEntityHistory: vi.fn(),
	parseHistoryLimit: vi.fn().mockReturnValue(50),
	INVALID_HISTORY_LIMIT: Symbol("INVALID_HISTORY_LIMIT"),
}));

vi.mock("../../controllers/disputesController.js", () => ({
	disputeErrorResponse: vi.fn(),
	listDisputes: vi.fn(),
	postDispute: vi.fn(),
	postResolution: vi.fn(),
}));

vi.mock("../../services/logger.js", () => ({
	logActivity: vi.fn(),
	buildChanges: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import invoicesRouter from "../invoices.js";
import { callRoute } from "./harness.js";
import {
	getInvoiceById,
	updateInvoice,
} from "../../controllers/invoicesController.js";
import { sendInvoiceEmail } from "../../services/emailService.js";

const mockGetInvoiceById = vi.mocked(getInvoiceById);
const mockUpdateInvoice = vi.mocked(updateInvoice);
const mockSendInvoiceEmail = vi.mocked(sendInvoiceEmail);
import { logActivity } from "../../services/logger.js";
const mockLogActivity = vi.mocked(logActivity);

beforeEach(() => {
	vi.clearAllMocks();
});

const send = (body: unknown = { recipient_email: "client@example.com" }) =>
	callRoute(invoicesRouter, "post", "/:id/send", {
		params: { id: "i1" },
		body,
	});

/**
 * The status guard used to run AFTER the email, so a send the transition table
 * refuses mailed the invoice to the client and only then reported the failure —
 * leaving the client holding a document the system still calls a Draft. The
 * sibling route POST /quotes/:id/send already guards first; this is that fix.
 */
describe("POST /invoices/:id/send transition guard", () => {
	/**
	 * Draft -> Sent is legal: emailing is one of two delivery doors out of
	 * Draft, the other being Issued for manual delivery. updateInvoice
	 * finalizes on whichever one is used, so nothing reaches the client
	 * unfrozen or undated.
	 */
	it("emails straight from Draft, finalizing on the way", async () => {
		mockGetInvoiceById.mockResolvedValue({
			id: "i1",
			status: "Draft",
		} as never);
		mockUpdateInvoice.mockResolvedValue({
			err: "",
			item: { id: "i1" },
		} as never);

		const res = await send();

		expect(mockSendInvoiceEmail).toHaveBeenCalled();
		// The exact body, not just that it was called: a future edit that
		// changed this to {status: "Issued"} (marking it hand-delivered after
		// the system just emailed it) would still pass a bare toHaveBeenCalled.
		expect(mockUpdateInvoice.mock.calls[0][0].body).toEqual({
			status: "Sent",
		});
		expect(res.body.success).toBe(true);
	});

	// The email is already in the client's inbox by the time this write runs;
	// a failure here must not be swallowed into a false success.
	it("surfaces the status write's own refusal after the email already sent", async () => {
		mockGetInvoiceById.mockResolvedValue({
			id: "i1",
			status: "Draft",
		} as never);
		mockUpdateInvoice.mockResolvedValue({
			err: "Void invoices cannot be modified",
		} as never);

		const res = await send();

		expect(mockSendInvoiceEmail).toHaveBeenCalled();
		expect(res.status).toBe(400);
		expect(res.body.success).toBe(false);
		expect(res.body.error.message).toBe("Void invoices cannot be modified");
	});

	// Wider than Draft: a dispatcher re-sending a copy of an invoice that has
	// taken money is an ordinary action, and it failed the same way.
	it.each(["PartiallyPaid", "Paid", "Void"])(
		"does not email the client from %s",
		async (status) => {
			mockGetInvoiceById.mockResolvedValue({
				id: "i1",
				status,
			} as never);

			const res = await send();

			expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
			expect(res.status).toBe(422);
		},
	);

	it("emails and marks the invoice Sent when the transition is legal", async () => {
		mockGetInvoiceById.mockResolvedValue({
			id: "i1",
			status: "Issued",
		} as never);
		mockUpdateInvoice.mockResolvedValue({
			err: "",
			item: { id: "i1" },
		} as never);

		const res = await send();

		expect(mockSendInvoiceEmail).toHaveBeenCalledWith(
			"i1",
			"client@example.com",
			"org-1",
		);
		expect(res.body.success).toBe(true);
	});

	// Re-sending is a self-transition, which the table treats as a no-op.
	it("allows a re-send of an already Sent invoice", async () => {
		mockGetInvoiceById.mockResolvedValue({
			id: "i1",
			status: "Sent",
		} as never);
		mockUpdateInvoice.mockResolvedValue({
			err: "",
			item: { id: "i1" },
		} as never);

		await send();

		expect(mockSendInvoiceEmail).toHaveBeenCalled();
	});

	it("404s without emailing when the invoice does not exist", async () => {
		mockGetInvoiceById.mockResolvedValue(null as never);

		const res = await send();

		expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
		expect(res.status).toBe(404);
	});
});

// makeReq defaults role:"admin", which resolvePerms short-circuits past the
// permission array entirely — so every gate test has to name a real tier.
const sendAs = (permissions: string[]) =>
	callRoute(invoicesRouter, "post", "/:id/send", {
		params: { id: "i1" },
		body: { recipient_email: "client@example.com" },
		user: { role: "dispatcher", permissions },
	});

describe("POST /invoices/:id/send permission gate", () => {
	beforeEach(() => {
		mockGetInvoiceById.mockResolvedValue({ id: "i1", status: "Issued" } as never);
		mockUpdateInvoice.mockResolvedValue({ err: "", item: { id: "i1" } } as never);
	});

	// edit_invoices is what used to authorise this route. Sending an invoice is
	// not editing one: a billing clerk mails what accounting has already
	// approved, and must not be able to restate the amount on the way out.
	it("403s a role holding edit_invoices but not send_invoices", async () => {
		const res = await sendAs(["view_invoices", "edit_invoices"]);

		expect(res.status).toBe(403);
		expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
	});

	it("allows a role holding send_invoices but not edit_invoices", async () => {
		const res = await sendAs(["view_invoices", "send_invoices"]);

		expect(res.status).toBe(200);
		expect(mockSendInvoiceEmail).toHaveBeenCalled();
	});

	it("403s a role holding neither", async () => {
		const res = await sendAs(["view_invoices"]);

		expect(res.status).toBe(403);
		expect(mockSendInvoiceEmail).not.toHaveBeenCalled();
	});
});

/**
 * An invoice the client never received must not sit on the board as Sent: that
 * is the status the whole receivables view ages from, and a dunning reminder
 * chasing a document nobody was sent is worse than no reminder at all.
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

describe("POST /invoices/:id/send delivery failure", () => {
	beforeEach(() => {
		mockGetInvoiceById.mockResolvedValue({ id: "i1", status: "Issued" } as never);
		mockUpdateInvoice.mockResolvedValue({ err: "", item: { id: "i1" } } as never);
	});

	it("leaves the invoice in its prior status when delivery fails", async () => {
		mockSendInvoiceEmail.mockRejectedValueOnce(
			sendFailure("Postmark rejected the send."),
		);

		const res = await send();

		expect(mockUpdateInvoice).not.toHaveBeenCalled();
		expect(res.status).toBe(502);
		expect(res.body.error.code).toBe("EMAIL_SEND_FAILED");
	});

	it("does not leak the raw provider message to the caller", async () => {
		mockSendInvoiceEmail.mockRejectedValueOnce(
			sendFailure(
				"While your account is pending approval, all recipient addresses must share the same domain as the 'From' address. The domain of the 'From' address is 'epicitautomations.com'.",
			),
		);

		const res = await send();

		expect(res.body.error.message).not.toContain("pending approval");
		expect(res.body.error.message).not.toContain("epicitautomations.com");
	});

	it("records the failure so it is visible outside the server log", async () => {
		mockSendInvoiceEmail.mockRejectedValueOnce(
			sendFailure("Postmark rejected the send."),
		);

		await send();

		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "invoice.send_failed",
				entity_type: "invoice",
				entity_id: "i1",
			}),
		);
	});
});

/**
 * The invoice lookup and the PDF render run before the Postmark call is
 * wrapped, so their failures arrive here untranslated — carrying text written
 * for a stack trace rather than for the person who pressed Send.
 */
describe("POST /invoices/:id/send untranslated failure", () => {
	beforeEach(() => {
		mockGetInvoiceById.mockResolvedValue({ id: "i1", status: "Issued" } as never);
		mockUpdateInvoice.mockResolvedValue({ err: "", item: { id: "i1" } } as never);
	});

	it("answers generically instead of echoing an internal error message", async () => {
		mockSendInvoiceEmail.mockRejectedValueOnce(
			new Error("Invalid `db.organization.findUnique()` invocation"),
		);

		const res = await send();

		expect(res.status).toBe(502);
		expect(res.body.error.code).toBe("EMAIL_SEND_FAILED");
		expect(res.body.error.message).not.toContain("findUnique");
		expect(mockUpdateInvoice).not.toHaveBeenCalled();
	});

	it("still records what actually failed", async () => {
		mockSendInvoiceEmail.mockRejectedValueOnce(new Error("PDF render failed"));

		await send();

		expect(mockLogActivity).toHaveBeenCalledWith(
			expect.objectContaining({
				event_type: "invoice.send_failed",
				reason: "PDF render failed",
			}),
		);
	});

	it("lets a 404 from the loader stay a 404", async () => {
		mockSendInvoiceEmail.mockRejectedValueOnce(
			Object.assign(new Error("Invoice not found"), { status: 404 }),
		);

		const res = await send();

		expect(res.status).toBe(404);
		expect(res.body.error.code).toBe("NOT_FOUND");
	});
});
