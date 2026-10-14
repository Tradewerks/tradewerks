import { describe, it, expect } from "vitest";
import {
	invoiceAdapter,
	voidBlockedByAdjustmentReason,
	voidBlockedByPaymentReason,
	soldJobReason,
	type DocumentShape,
} from "../disputeAdapters.js";

function aDoc(overrides: Partial<DocumentShape> = {}): DocumentShape {
	return {
		id: "q1",
		status: "Approved",
		organization_id: "org1",
		line_items: [],
		job: null,
		request: null,
		...overrides,
	};
}

describe("voidBlockedByPaymentReason", () => {
	it("permits a void when nothing has been applied", () => {
		expect(voidBlockedByPaymentReason(0)).toBeNull();
	});

	it("refuses a void once money has been applied", () => {
		expect(voidBlockedByPaymentReason(120)).toBe(
			"This invoice has $120.00 applied. Issue an adjustment instead — voiding would strand the payment.",
		);
	});

	/**
	 * Ruling P11 pins this sentence byte-for-byte across the stack, and the
	 * file's own comment records why: toFixed(2) renders "$1000.00" where the
	 * frontend's Intl formatter renders "$1,000.00". A regression here is
	 * silent — the guard still works, the two copies just stop matching.
	 */
	it("groups thousands, matching the frontend formatter", () => {
		expect(voidBlockedByPaymentReason(1000)).toContain("$1,000.00");
	});

	it("treats a negative balance as nothing applied", () => {
		expect(voidBlockedByPaymentReason(-50)).toBeNull();
	});
});

/**
 * Both createQuoteRevision (the standalone revise door) and the dispute
 * path's availableOutcomes gate on this function, so its two non-null
 * branches and its null case are pinned directly here rather than only
 * indirectly through either caller.
 */
describe("soldJobReason", () => {
	it("refuses once a job has been created from the quote", () => {
		expect(soldJobReason(aDoc({ job: { id: "j1" } }))).toBe(
			"A job was created from this quote — the quote is no longer the live document. Repeal it, or correct the job's invoice.",
		);
	});

	it("refuses when a sibling quote on the request became a job", () => {
		expect(
			soldJobReason(
				aDoc({
					request: {
						id: "r1",
						status: "ConvertedToJob",
						jobs: [
							{
								id: "j9",
								job_number: "J-0009",
								quote_id: "q-sibling",
							},
						],
					},
				}),
			),
		).toBe(
			"Another quote on this request was already sold as a job — the work is spoken for. Repeal this quote, or correct that job's invoice.",
		);
	});

	/**
	 * The case that stranded Q-0007. The request was converted straight to a
	 * job — a technician's on-site fix, no quote in the path — so the request
	 * reads ConvertedToJob while nothing this quote offers has been sold. Gating
	 * on request.status alone left such a quote with no forward outcome at all:
	 * neither revisable nor convertible, and the refusal named a job the quote
	 * page had no way to show.
	 */
	it("permits revision when the request's only job came from no quote", () => {
		expect(
			soldJobReason(
				aDoc({
					request: {
						id: "r1",
						status: "ConvertedToJob",
						jobs: [],
					},
				}),
			),
		).toBeNull();
	});

	/**
	 * The load filters on `quote_id: { not: null }`, so this shape should never
	 * arrive — but the predicate reads the column itself rather than trusting
	 * the query, because a caller that forgets the filter must not turn every
	 * request-derived job into somebody's sale.
	 */
	it("ignores a request job that carries no quote", () => {
		expect(
			soldJobReason(
				aDoc({
					request: {
						id: "r1",
						status: "ConvertedToJob",
						jobs: [
							{
								id: "j1",
								job_number: "J-0001",
								quote_id: null,
							},
						],
					},
				}),
			),
		).toBeNull();
	});

	/**
	 * This quote's own job is in the request's quote-derived jobs as well. The
	 * sibling branch must exclude it, or a dispatcher reads that some other
	 * quote sold the work when it was this one — two different remedies.
	 */
	it("reports this quote's own job as its own, not as a sibling's", () => {
		expect(
			soldJobReason(
				aDoc({
					job: { id: "j1" },
					request: {
						id: "r1",
						status: "ConvertedToJob",
						jobs: [
							{
								id: "j1",
								job_number: "J-0001",
								quote_id: "q1",
							},
						],
					},
				}),
			),
		).toBe(
			"A job was created from this quote — the quote is no longer the live document. Repeal it, or correct the job's invoice.",
		);
	});

	it("permits revision when there is no job and the request holds none", () => {
		expect(
			soldJobReason(
				aDoc({ request: { id: "r1", status: "QuoteApproved" } }),
			),
		).toBeNull();
	});
});

/**
 * D1: an invoice with a live adjustment can't be voided by any door, and the
 * refusal names what to void first. Shared by Repeal and the kebab's Void.
 */
describe("voidBlockedByAdjustmentReason", () => {
	it("permits a void when no live adjustment exists", () => {
		expect(voidBlockedByAdjustmentReason([])).toBeNull();
	});

	it("names the adjustment to void first", () => {
		expect(voidBlockedByAdjustmentReason([{ invoice_number: "INV-1001" }])).toBe(
			"INV-1001 adjusts this invoice. Void INV-1001 first, then void this one.",
		);
	});

	it("names every live adjustment", () => {
		expect(
			voidBlockedByAdjustmentReason([
				{ invoice_number: "INV-1001" },
				{ invoice_number: "INV-1002" },
				{ invoice_number: "INV-1003" },
			]),
		).toBe(
			"INV-1001, INV-1002 and INV-1003 adjust this invoice. Void them first, then void this one.",
		);
	});
});

describe("invoiceAdapter with a live adjustment", () => {
	const adjusted = aDoc({
		id: "inv1",
		status: "Disputed",
		amount_paid: 0,
		adjustments: [{ id: "adj1", invoice_number: "INV-1001" }],
	});

	it("offers only Issue Adjustment", () => {
		expect(invoiceAdapter.availableOutcomes(adjusted)).toEqual(["IssueAdjustment"]);
	});

	it("explains Repeal with the adjustment's number", () => {
		expect(invoiceAdapter.unavailableReason(adjusted, "Repeal")).toBe(
			"INV-1001 adjusts this invoice. Void INV-1001 first, then void this one.",
		);
	});

	it("no longer suggests repealing an adjusted invoice", () => {
		expect(invoiceAdapter.unavailableReason(adjusted, "ReviseAndResend")).toBe(
			"This invoice has already been corrected by an adjustment. Issue a further adjustment against it instead.",
		);
	});
});
