/**
 * The tables are restated here on purpose. A test that imported the source
 * table would agree with any edit to it, including a wrong one.
 */
import { describe, it, expect } from "vitest";
import {
	assertValidQuoteTransition,
	assertValidInvoiceTransition,
	assertValidRequestTransition,
	isInvoiceFinalizingTransition,
	InvalidTransitionError,
} from "../statusTransitions.js";

const QUOTE_STATUSES = [
	"Draft", "Issued", "Sent", "Viewed", "Approved",
	"Disputed", "Rejected", "Revised", "Expired", "Cancelled",
] as const;

const EXPECTED_QUOTE: Record<string, readonly string[]> = {
	Draft:     ["Issued", "Sent", "Cancelled"],
	Issued:    ["Sent", "Approved", "Rejected", "Revised", "Expired", "Cancelled", "Disputed"],
	Sent:      ["Viewed", "Approved", "Rejected", "Expired", "Cancelled", "Disputed"],
	Viewed:    ["Approved", "Rejected", "Expired", "Cancelled", "Disputed"],
	Approved:  ["Revised", "Disputed"],
	Disputed:  ["Revised", "Cancelled"],
	Rejected:  ["Revised"],
	Revised:   [],
	Expired:   ["Revised"],
	Cancelled: [],
};

const REQUEST_STATUSES = [
	"New", "Reviewing", "Quoted", "QuoteApproved",
	"QuoteRejected", "ConvertedToJob", "Cancelled",
] as const;

const EXPECTED_REQUEST: Record<string, readonly string[]> = {
	New:            ["Reviewing", "Cancelled"],
	Reviewing:      ["Quoted", "New", "Cancelled"],
	Quoted:         ["QuoteApproved", "QuoteRejected", "Reviewing"],
	QuoteApproved:  ["ConvertedToJob", "Cancelled", "Quoted"],
	QuoteRejected:  ["Reviewing", "Quoted"],
	ConvertedToJob: [],
	Cancelled:      [],
};

const INVOICE_STATUSES = [
	"Draft", "Issued", "Sent", "Viewed",
	"PartiallyPaid", "Paid", "Disputed", "Void",
] as const;

const EXPECTED_INVOICE: Record<string, readonly string[]> = {
	// Sent is a peer of Issued, not a step after it: a business either has the
	// system email the invoice, or marks it issued and delivers the PDF itself.
	Draft:         ["Issued", "Sent", "Void"],
	Issued:        ["Sent", "Void", "Disputed"],
	Sent:          ["Viewed", "Disputed", "Void"],
	Viewed:        ["Disputed", "Void"],
	PartiallyPaid: ["Disputed", "Void"],
	// Deliberately no longer terminal: disputing an invoice you already paid
	// is the most common real dispute, and Issue Adjustment is additive.
	Paid:          ["Disputed"],
	Disputed:      ["Sent", "Viewed", "Void", "Issued"],
	Void:          [],
};

type Assert = (from: string, to: string) => void;

function exerciseTable(
	name: string,
	statuses: readonly string[],
	expected: Record<string, readonly string[]>,
	assertFn: Assert,
) {
	describe(name, () => {
		it("accepts every allowed transition", () => {
			for (const from of statuses) {
				for (const to of expected[from]) {
					expect(() => assertFn(from, to)).not.toThrow();
				}
			}
		});

		it("rejects every transition not in the table", () => {
			for (const from of statuses) {
				for (const to of statuses) {
					if (from === to) continue;
					if (expected[from].includes(to)) continue;
					expect(() => assertFn(from, to)).toThrow(InvalidTransitionError);
				}
			}
		});

		it("treats a self-transition as a no-op", () => {
			for (const from of statuses) {
				expect(() => assertFn(from, from)).not.toThrow();
			}
		});

		it("rejects an unknown source status", () => {
			expect(() => assertFn("NotAStatus", statuses[0])).toThrow(InvalidTransitionError);
		});
	});
}

exerciseTable("quote transitions", QUOTE_STATUSES, EXPECTED_QUOTE, assertValidQuoteTransition);
exerciseTable("request transitions", REQUEST_STATUSES, EXPECTED_REQUEST, assertValidRequestTransition);
exerciseTable("invoice transitions", INVOICE_STATUSES, EXPECTED_INVOICE, assertValidInvoiceTransition);

/**
 * Rejected was terminal, which made "the client said no" unrecoverable:
 * reviseQuote existed but only a dispute could reach it, and a rejected
 * quote could not be disputed. Revised is now its one exit — every other
 * move out of Rejected stays refused.
 */
it("lets a rejected quote be superseded by a revision", () => {
	expect(() =>
		assertValidQuoteTransition("Rejected", "Revised"),
	).not.toThrow();
});

it("keeps every other exit from Rejected closed", () => {
	for (const to of [
		"Draft",
		"Issued",
		"Sent",
		"Viewed",
		"Approved",
		"Disputed",
		"Expired",
		"Cancelled",
	]) {
		expect(() =>
			assertValidQuoteTransition("Rejected", to),
		).toThrow(InvalidTransitionError);
	}
});

/**
 * Emailing is one of two delivery doors out of Draft — the other being Issued,
 * for a business that downloads the PDF and delivers it itself. Before this,
 * reaching a client by email meant first declaring "I will deliver this
 * myself", and POST /invoices/:id/send mailed the document and then 422'd.
 */
it("lets an invoice be emailed straight out of Draft", () => {
	expect(() => assertValidInvoiceTransition("Draft", "Sent")).not.toThrow();
	expect(() => assertValidInvoiceTransition("Draft", "Issued")).not.toThrow();
});

describe("isInvoiceFinalizingTransition", () => {
	// Both doors freeze the tax basis and date the document. Keying this on
	// "Issued" alone left an emailed invoice unfrozen: the client held a
	// document whose line items the server still accepted a rewrite of.
	it("finalizes on either door out of Draft", () => {
		expect(isInvoiceFinalizingTransition("Draft", "Issued")).toBe(true);
		expect(isInvoiceFinalizingTransition("Draft", "Sent")).toBe(true);
	});

	it("does not finalize when a draft is voided", () => {
		// Killing a draft commits to nothing, so there is nothing to freeze.
		expect(isInvoiceFinalizingTransition("Draft", "Void")).toBe(false);
	});

	it("does not re-finalize a document that already left Draft", () => {
		// Idempotence: Issued -> Sent must not re-stamp or re-lock, or a
		// manually delivered invoice would be re-dated when it is later emailed.
		expect(isInvoiceFinalizingTransition("Issued", "Sent")).toBe(false);
		expect(isInvoiceFinalizingTransition("Sent", "Disputed")).toBe(false);
		expect(isInvoiceFinalizingTransition("Disputed", "Sent")).toBe(false);
	});

	it("does not finalize a no-op or an absent status change", () => {
		expect(isInvoiceFinalizingTransition("Draft", "Draft")).toBe(false);
		expect(isInvoiceFinalizingTransition("Draft", undefined)).toBe(false);
	});
});

/**
 * Issued is a delivery door, not a pre-delivery state (see the header on
 * INVOICE_TRANSITIONS): the dispatcher handed the document over themselves, so
 * the client can contest it. The invoice's return edge carries an adjusted
 * original back to Issued; the quote has no restore outcome and keeps refusing it.
 */
it("lets a hand-delivered document be disputed", () => {
	expect(() => assertValidQuoteTransition("Issued", "Disputed")).not.toThrow();
	expect(() => assertValidInvoiceTransition("Issued", "Disputed")).not.toThrow();
});

it("restores an adjusted invoice to Issued but never a quote", () => {
	expect(() => assertValidInvoiceTransition("Disputed", "Issued")).not.toThrow();
	expect(() => assertValidQuoteTransition("Disputed", "Issued")).toThrow(
		InvalidTransitionError,
	);
});
