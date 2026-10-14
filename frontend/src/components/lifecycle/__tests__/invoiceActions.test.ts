import { describe, it, expect } from "vitest";
import { invoiceActions } from "../invoiceActions";
import type { InvoiceStatus } from "../../../types/invoices";

const noop = () => {};
const handlers = {
	send: noop,
	issue: noop,
	recordPayment: noop,
	refund: noop,
	dispute: noop,
	void: noop,
};

const ctx = (over: Record<string, unknown> = {}) => ({
	status: "Sent" as InvoiceStatus,
	amountPaid: 0,
	hasOpenDispute: false,
	disputeStateUnknown: false,
	// The server produces these now (disputeList.open_refusal / .void_refusal);
	// the builder only threads them onto Open Dispute and Void.
	openRefusal: null as string | null,
	voidRefusal: null as string | null,
	canEdit: true,
	canSend: true,
	canOpenDispute: true,
	canRefund: true,
	handlers,
	...over,
});

const byId = (actions: ReturnType<typeof invoiceActions>, id: string) =>
	actions.find((a) => a.id === id);

const PAYMENT_BLOCK =
	"This invoice has $120.00 applied. Issue an adjustment instead — voiding would strand the payment.";

describe("invoiceActions", () => {
	/**
	 * The two delivery doors are peers, both open on a Draft: email it through
	 * the system, or issue it and hand the PDF over yourself. Neither is a step
	 * before the other, and updateInvoice finalizes on whichever is used.
	 */
	it("offers both delivery doors on a draft", () => {
		const actions = invoiceActions(ctx({ status: "Draft" }));
		expect(byId(actions, "send")?.disabled).toBe(false);
		expect(byId(actions, "issue")?.disabled).toBe(false);
	});

	it("still offers email on an already-issued invoice", () => {
		expect(byId(invoiceActions(ctx({ status: "Issued" })), "send")?.disabled).toBe(
			false
		);
	});

	// Issuing twice would re-date the document and re-freeze a frozen basis.
	it("closes issue once the invoice has left Draft", () => {
		const action = byId(invoiceActions(ctx({ status: "Issued" })), "issue");
		expect(action?.disabled).toBe(true);
		expect(action?.disabledReason).toMatch(/already been created/i);
	});

	// The labels are the only thing telling a dispatcher who delivers.
	it("names the doors by who delivers", () => {
		const actions = invoiceActions(ctx({ status: "Draft" }));
		expect(byId(actions, "send")?.label).toBe("Email to Client");
		expect(byId(actions, "issue")?.label).toBe("Create Without Sending");
	});

	it("offers a void on an unpaid sent invoice", () => {
		expect(byId(invoiceActions(ctx()), "void")?.disabled).toBe(false);
	});

	/**
	 * The void's own refusal, carried as `void_refusal` and shown verbatim
	 * rather than rebuilt from `amountPaid`.
	 */
	it("closes the void with the server's void_refusal, verbatim", () => {
		const action = byId(
			invoiceActions(
				ctx({ status: "PartiallyPaid", amountPaid: 120, voidRefusal: PAYMENT_BLOCK })
			),
			"void"
		);
		expect(action?.disabled).toBe(true);
		expect(action?.disabledReason).toBe(PAYMENT_BLOCK);
	});

	/** A live adjustment blocks the void, carried by `void_refusal`. */
	it("closes the void while a live adjustment names this invoice", () => {
		const adj = "INV-1001 adjusts this invoice. Void INV-1001 first, then void this one.";
		const action = byId(invoiceActions(ctx({ voidRefusal: adj })), "void");
		expect(action?.disabled).toBe(true);
		expect(action?.disabledReason).toBe(adj);
	});

	/**
	 * Without this gate the kebab offers Void, the server refuses it, and the
	 * dispatcher types a reason and watches nothing happen.
	 */
	it("closes the void while a dispute is open, pointing at Repeal", () => {
		const action = byId(
			invoiceActions(ctx({ status: "Disputed", hasOpenDispute: true })),
			"void"
		);
		expect(action?.disabled).toBe(true);
		expect(action?.disabledReason).toMatch(/repeal/i);
	});

	it("closes the void when dispute state is unknown", () => {
		const action = byId(invoiceActions(ctx({ disputeStateUnknown: true })), "void");
		expect(action?.disabled).toBe(true);
		expect(action?.disabledReason).toMatch(/reload/i);
	});

	it("offers a dispute on a paid invoice", () => {
		expect(
			byId(invoiceActions(ctx({ status: "Paid", amountPaid: 500 })), "dispute")
				?.disabled
		).toBe(false);
	});

	it("offers a refund only once money has been applied", () => {
		expect(byId(invoiceActions(ctx()), "refund")?.disabled).toBe(true);
		expect(
			byId(
				invoiceActions(ctx({ status: "PartiallyPaid", amountPaid: 120 })),
				"refund"
			)?.disabled
		).toBe(false);
	});

	it("closes everything on a void invoice without omitting anything", () => {
		const actions = invoiceActions(ctx({ status: "Void" }));
		expect(actions.every((a) => a.disabled)).toBe(true);
		expect(actions.map((a) => a.id)).toEqual(invoiceActions(ctx()).map((a) => a.id));
	});

	it("offers a dispute when the server allows one (open_refusal null)", () => {
		const actions = invoiceActions(ctx({ status: "Issued", openRefusal: null }));
		expect(byId(actions, "dispute")?.disabled).toBe(false);
	});

	/**
	 * The "can't be disputed" sentence is the open door's own
	 * (disputeList.open_refusal), shown verbatim so it can't drift from the 422.
	 */
	it("shows the server's open_refusal verbatim on Open Dispute", () => {
		const refusal =
			"A Draft invoice can't be disputed. Disputes may be opened from: Created, Sent, Viewed, Partially Paid, Fully Paid.";
		const actions = invoiceActions(ctx({ status: "Draft", openRefusal: refusal }));
		expect(byId(actions, "dispute")?.disabled).toBe(true);
		expect(byId(actions, "dispute")?.disabledReason).toBe(refusal);
	});
});

describe("invoiceActions permission gates", () => {
	// Opening a dispute is not an edit: whoever takes the call records the
	// disagreement, and may hold no edit rights at all.
	it("offers Open Dispute to a caller with open_disputes but no edit rights", () => {
		const actions = invoiceActions(ctx({ canEdit: false }));
		expect(byId(actions, "dispute")?.disabled).toBe(false);
	});

	// A billing clerk mails what accounting approved, and must not be able to
	// restate the amount on the way out. Sending is its own grant.
	it("offers Email to Client to a caller with send_invoices but no edit rights", () => {
		const actions = invoiceActions(ctx({ canEdit: false, status: "Issued" }));
		expect(byId(actions, "send")?.disabled).toBe(false);
	});

	it("closes Email to Client without send_invoices, even with edit rights", () => {
		const actions = invoiceActions(ctx({ canSend: false, status: "Issued" }));
		expect(byId(actions, "send")?.disabled).toBe(true);
		expect(byId(actions, "send")?.disabledReason).toMatch(/permission/i);
	});

	it("closes Email to Client on a void invoice even with send_invoices", () => {
		const actions = invoiceActions(ctx({ canSend: true, status: "Void" }));
		expect(byId(actions, "send")?.disabled).toBe(true);
		expect(byId(actions, "send")?.disabledReason).not.toMatch(/permission/i);
	});

	it("closes Open Dispute without open_disputes, even with edit rights", () => {
		const actions = invoiceActions(ctx({ canOpenDispute: false }));
		expect(byId(actions, "dispute")?.disabled).toBe(true);
		expect(byId(actions, "dispute")?.disabledReason).toMatch(/permission/i);
	});

	// Cash out is its own grant. edit_invoices covers fixing a due date.
	it("closes Record Refund without refund_invoices", () => {
		const actions = invoiceActions(ctx({ amountPaid: 100, canRefund: false }));
		expect(byId(actions, "refund")?.disabled).toBe(true);
		expect(byId(actions, "refund")?.disabledReason).toMatch(/permission/i);
	});

	it("closes Void Invoice without refund_invoices", () => {
		const actions = invoiceActions(ctx({ canRefund: false }));
		expect(byId(actions, "void")?.disabled).toBe(true);
		expect(byId(actions, "void")?.disabledReason).toMatch(/permission/i);
	});

	it("still offers refund when both grants are held", () => {
		const actions = invoiceActions(ctx({ amountPaid: 100 }));
		expect(byId(actions, "refund")?.disabled).toBe(false);
	});
});
