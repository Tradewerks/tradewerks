import { describe, it, expect } from "vitest";
import { quoteActions, QUOTE_STEPS, isQuoteOffRamp } from "../quoteActions";
import type { QuoteStatus } from "../../../types/quotes";

const noop = () => {};
const handlers = {
	issue: noop,
	send: noop,
	approve: noop,
	convert: noop,
	dispute: noop,
	reject: noop,
	withdraw: noop,
	revise: noop,
};

const ctx = (over: Record<string, unknown> = {}) => ({
	status: "Sent" as QuoteStatus,
	hasJob: false,
	hasOpenDispute: false,
	disputeStateUnknown: false,
	// The server produces these now (disputeList.open_refusal / .sold_refusal);
	// the builder only threads them into the right action.
	openRefusal: null as string | null,
	soldRefusal: null as string | null,
	canEdit: true,
	canSend: true,
	canCreateJob: true,
	canOpenDispute: true,
	handlers,
	...over,
});

const byId = (actions: ReturnType<typeof quoteActions>, id: string) =>
	actions.find((a) => a.id === id);

describe("quoteActions", () => {
	it("offers approve, reject, dispute and withdraw on a sent quote", () => {
		const actions = quoteActions(ctx());
		for (const id of ["approve", "reject", "dispute", "withdraw"]) {
			expect(byId(actions, id)?.disabled).toBe(false);
		}
	});

	/**
	 * A rejected quote must keep its exits: otherwise "the client said no" is a
	 * dead end and the next quote is hand-built with no lineage.
	 */
	it("offers a revision on a rejected quote", () => {
		expect(byId(quoteActions(ctx({ status: "Rejected" })), "revise")?.disabled).toBe(
			false
		);
	});

	it("offers a revision on an expired quote", () => {
		expect(byId(quoteActions(ctx({ status: "Expired" })), "revise")?.disabled).toBe(
			false
		);
	});

	it("closes revision on a cancelled quote with a reason", () => {
		const revise = byId(quoteActions(ctx({ status: "Cancelled" })), "revise");
		expect(revise?.disabled).toBe(true);
		expect(revise?.disabledReason).toBeTruthy();
	});

	/**
	 * A disputed quote has its own revision door — the dispute outcome, which
	 * also closes the dispute row. The standalone one would strand it.
	 */
	it("sends a disputed quote's revision back to the dispute", () => {
		const actions = quoteActions(ctx({ status: "Disputed", hasOpenDispute: true }));
		expect(byId(actions, "revise")?.disabledReason).toMatch(/dispute/i);
	});

	/** revisePending is checked ahead of the status gates so an in-flight
	 *  revise reads as in flight rather than as not allowed. */
	it("closes revision while one is already in flight", () => {
		const revise = byId(
			quoteActions(ctx({ status: "Rejected", revisePending: true })),
			"revise"
		);
		expect(revise?.disabled).toBe(true);
		expect(revise?.disabledReason).toMatch(/creating a revision/i);
	});

	/**
	 * The sold-work sentence is the server's `sold_refusal`, threaded verbatim
	 * onto Convert, Reject and Withdraw and never re-derived.
	 */
	it("carries the server's sold_refusal onto conversion", () => {
		const sold =
			"Another quote on this request was already sold as a job — the work is spoken for. Repeal this quote, or correct that job's invoice.";
		const convert = byId(
			quoteActions(ctx({ status: "Approved", soldRefusal: sold })),
			"convert"
		);
		expect(convert?.disabled).toBe(true);
		expect(convert?.disabledReason).toBe(sold);
	});

	it("closes Reject and Withdraw with the same sold_refusal", () => {
		const sold = "A job was created from this quote — the quote is no longer the live document.";
		// Sent, so the Rejected/Cancelled transitions are legal and it is the
		// sold_refusal (not a transition message) that closes the two.
		const actions = quoteActions(ctx({ status: "Sent", soldRefusal: sold }));
		expect(byId(actions, "reject")?.disabledReason).toBe(sold);
		expect(byId(actions, "withdraw")?.disabledReason).toBe(sold);
	});

	/**
	 * A request converted straight to a job leaves no quote in the path, so
	 * nothing this quote offers was sold and both exits stay open.
	 */
	it("leaves conversion and revision open when nothing was sold", () => {
		const actions = quoteActions(ctx({ status: "Approved", soldRefusal: null }));
		expect(byId(actions, "convert")?.disabled).toBe(false);
		expect(byId(actions, "revise")?.disabled).toBe(false);
	});

	it("never omits an unavailable action", () => {
		const open = quoteActions(ctx({ status: "Sent" })).map((a) => a.id);
		const dead = quoteActions(ctx({ status: "Cancelled" })).map((a) => a.id);
		expect(dead).toEqual(open);
	});

	it("disables dispute-related and destructive actions when dispute state is unknown", () => {
		const actions = quoteActions(ctx({ disputeStateUnknown: true }));
		for (const id of ["dispute", "withdraw", "reject", "convert"]) {
			expect(byId(actions, id)?.disabled).toBe(true);
			expect(byId(actions, id)?.disabledReason).toMatch(/reload/i);
		}
	});

	it("disables writes without the edit permission", () => {
		expect(
			byId(quoteActions(ctx({ canEdit: false })), "approve")?.disabledReason
		).toMatch(/permission/i);
	});

	// canTransitionQuote calls a self-transition legal, so without its own gate
	// Issue stays live as a no-op that re-dates an already-issued quote.
	it("closes issue once the quote has left Draft", () => {
		const action = byId(quoteActions(ctx({ status: "Issued" })), "issue");
		expect(action?.disabled).toBe(true);
		expect(action?.disabledReason).toMatch(/already been created/i);
		expect(byId(quoteActions(ctx({ status: "Draft" })), "issue")?.disabled).toBe(
			false
		);
	});

	// Same self-transition hole as Issue: a Rejected quote would offer a live
	// Reject beside its rejection reason. Send is excluded — re-emailing a sent
	// quote is a real act, not a status write.
	it.each([
		["Approved", "approve"],
		["Rejected", "reject"],
		["Cancelled", "withdraw"],
	] as const)("hides the move a %s quote has already made", (status, id) => {
		const action = byId(quoteActions(ctx({ status })), id);
		expect(action?.disabled).toBe(true);
		expect(action?.hidden).toBe(true);
	});

	it("keeps Email to Client live on a sent quote, as a re-send", () => {
		expect(byId(quoteActions(ctx({ status: "Sent" })), "send")?.disabled).toBe(false);
	});

	it("marks intents so the bar can place them", () => {
		const actions = quoteActions(ctx());
		expect(byId(actions, "withdraw")?.intent).toBe("destructive");
		expect(byId(actions, "reject")?.intent).toBe("destructive");
		expect(byId(actions, "dispute")?.intent).toBe("warning");
	});

	it("returns actions in a stable order regardless of status", () => {
		const a = quoteActions(ctx({ status: "Sent" })).map((x) => x.id);
		const b = quoteActions(ctx({ status: "Rejected" })).map((x) => x.id);
		expect(a).toEqual(b);
	});

	it("offers a dispute when the server allows one (open_refusal null)", () => {
		const actions = quoteActions(ctx({ status: "Issued", openRefusal: null }));
		expect(byId(actions, "dispute")?.disabled).toBe(false);
	});

	/**
	 * The "can't be disputed" sentence is the open door's own
	 * (disputeList.open_refusal), shown verbatim so it can't drift from the 422.
	 */
	it("shows the server's open_refusal verbatim on Open Dispute", () => {
		const refusal =
			"A Draft quote can't be disputed. Disputes may be opened from: Created, Sent, Viewed, Approved.";
		const actions = quoteActions(ctx({ status: "Draft", openRefusal: refusal }));
		expect(byId(actions, "dispute")?.disabled).toBe(true);
		expect(byId(actions, "dispute")?.disabledReason).toBe(refusal);
	});
});

describe("quoteActions permission gates", () => {
	it("offers Open Dispute to a caller with open_disputes but no edit rights", () => {
		expect(byId(quoteActions(ctx({ canEdit: false })), "dispute")?.disabled).toBe(
			false
		);
	});

	it("closes Open Dispute without open_disputes, even with edit rights", () => {
		const action = byId(quoteActions(ctx({ canOpenDispute: false })), "dispute");
		expect(action?.disabled).toBe(true);
		expect(action?.disabledReason).toMatch(/permission/i);
	});

	// The other actions keep reading edit_quotes: they are document edits.
	// send is absent — it moved to send_quotes, covered below.
	it("leaves the non-dispute actions on edit_quotes", () => {
		const actions = quoteActions(ctx({ canEdit: false }));
		for (const id of ["approve", "reject", "withdraw"]) {
			expect(byId(actions, id)?.disabled).toBe(true);
		}
	});

	// Mailing a finished quote is not a change to what it says. A clerk holds
	// send_quotes without edit_quotes; an estimator holds edit_quotes and never
	// contacts the client. Both were impossible while send rode on canEdit.
	it("offers Email to Client to a caller with send_quotes but no edit rights", () => {
		const actions = quoteActions(ctx({ canEdit: false, status: "Issued" }));
		expect(byId(actions, "send")?.disabled).toBe(false);
	});

	it("closes Email to Client without send_quotes, even with edit rights", () => {
		const actions = quoteActions(ctx({ canSend: false, status: "Issued" }));
		expect(byId(actions, "send")?.disabled).toBe(true);
		expect(byId(actions, "send")?.disabledReason).toMatch(/permission/i);
	});

	// send_quotes authorises the door, not the document's state: a quote the
	// transition table refuses must stay shut for a sender who holds it.
	it("still refuses a send the transition table does not allow", () => {
		const actions = quoteActions(ctx({ canSend: true, hasOpenDispute: true }));
		expect(byId(actions, "send")?.disabled).toBe(true);
		expect(byId(actions, "send")?.disabledReason).not.toMatch(/permission/i);
	});
});

describe("quote path", () => {
	it("keeps the four happy-path steps in order", () => {
		expect(QUOTE_STEPS).toEqual(["Draft", "Issued", "Sent", "Approved"]);
	});

	it("treats every non-path status as an off-ramp", () => {
		expect(isQuoteOffRamp("Rejected")).toBe(true);
		expect(isQuoteOffRamp("Expired")).toBe(true);
		expect(isQuoteOffRamp("Sent")).toBe(false);
	});
});
