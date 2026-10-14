import { describe, it, expect } from "vitest";
import { outcomesFor } from "../outcomes";
import type { DisputeOutcomeState } from "../../../types/disputes";

const states: DisputeOutcomeState[] = [
	{
		id: "ReviseAndResend",
		disabled: true,
		reason: "This invoice has $1,000.00 applied. Issue an adjustment instead — voiding would strand the payment.",
	},
	{ id: "IssueAdjustment", disabled: false, reason: null },
	{
		id: "Repeal",
		disabled: true,
		reason: "You opened this dispute, so you can't also resolve it. Hand it to a colleague.",
	},
];

/**
 * The rules — availability, grants, separation of duties and their order — are
 * the server's, pinned by disputeOutcomes.parity.test.ts in the backend. This
 * file only checks that the modal and the bar show that judgement unaltered.
 */
describe("outcomesFor", () => {
	it("keeps the server's order and its refusal sentences verbatim", () => {
		const options = outcomesFor("invoice", states);

		expect(options.map((o) => o.id)).toEqual(["ReviseAndResend", "IssueAdjustment", "Repeal"]);
		expect(options.map((o) => o.disabled)).toEqual([true, false, true]);
		expect(options[0].disabledReason).toBe(states[0].reason);
		expect(options[1].disabledReason).toBeUndefined();
		expect(options[2].disabledReason).toBe(states[2].reason);
	});

	it("labels, describes and marks the destructive outcome per document kind", () => {
		const invoice = outcomesFor("invoice", states);
		const quote = outcomesFor("quote", states);

		expect(invoice.map((o) => o.label)).toEqual(["Revise & Resend", "Issue Adjustment", "Repeal"]);
		expect(invoice.map((o) => o.destructive)).toEqual([false, false, true]);
		expect(invoice[2].blurb).toMatch(/void this invoice/i);
		expect(quote[2].blurb).toMatch(/cancel this quote/i);
	});

	it("renders nothing when the dispute carries no outcomes", () => {
		expect(outcomesFor("quote", [])).toEqual([]);
	});
});
