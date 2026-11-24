import { describe, expect, it } from "vitest";
import { allocateQBPaymentCash } from "../qb/qbPaymentAllocation.js";

const invLine = (txnId: string, amount: number) => ({
	Amount: amount,
	LinkedTxn: [{ TxnId: txnId, TxnType: "Invoice" }],
});

describe("allocateQBPaymentCash", () => {
	it("one 900 payment across three 300 invoices gives 300 to each", () => {
		const result = allocateQBPaymentCash({
			totalAmt: 900,
			lines: [invLine("a", 300), invLine("b", 300), invLine("c", 300)],
			balanceCentsByQbInvoiceId: new Map([
				["a", 30000],
				["b", 30000],
				["c", 30000],
			]),
		});

		expect(result).toEqual({
			allocations: [
				{ qbInvoiceId: "a", cents: 30000 },
				{ qbInvoiceId: "b", cents: 30000 },
				{ qbInvoiceId: "c", cents: 30000 },
			],
			unplacedCents: 0,
			overappliedQbInvoiceIds: [],
		});
	});

	it("cash 50 with a 60 invoice line and a 10 credit memo line gives 50 to the invoice", () => {
		const result = allocateQBPaymentCash({
			totalAmt: 50,
			lines: [
				invLine("158", 60),
				{ Amount: 10, LinkedTxn: [{ TxnId: "cm-1", TxnType: "CreditMemo" }] },
			],
			balanceCentsByQbInvoiceId: new Map([["158", 10000]]),
		});

		expect(result).toEqual({
			allocations: [{ qbInvoiceId: "158", cents: 5000 }],
			unplacedCents: 0,
			overappliedQbInvoiceIds: [],
		});
	});

	it("caps each invoice at its remaining balance and reports the rest as unplaced", () => {
		const result = allocateQBPaymentCash({
			totalAmt: 900,
			lines: [invLine("a", 300), invLine("b", 300), invLine("c", 300)],
			balanceCentsByQbInvoiceId: new Map([
				["a", 30000],
				["b", 12550],
				["c", 0],
			]),
		});

		expect(result).toEqual({
			allocations: [
				{ qbInvoiceId: "a", cents: 30000 },
				{ qbInvoiceId: "b", cents: 12550 },
			],
			unplacedCents: 47450,
			overappliedQbInvoiceIds: ["b", "c"],
		});
	});

	it("ignores UnappliedAmt cash", () => {
		const result = allocateQBPaymentCash({
			totalAmt: 500,
			unappliedAmt: 200,
			lines: [invLine("a", 300)],
			balanceCentsByQbInvoiceId: new Map([["a", 100000]]),
		});

		expect(result).toEqual({
			allocations: [{ qbInvoiceId: "a", cents: 30000 }],
			unplacedCents: 0,
			overappliedQbInvoiceIds: [],
		});
	});

	it("ignores CreditMemo and other non-Invoice linked lines", () => {
		const result = allocateQBPaymentCash({
			totalAmt: 100,
			lines: [
				{ Amount: 40, LinkedTxn: [{ TxnId: "je-1", TxnType: "JournalEntry" }] },
				invLine("a", 60),
				{ Amount: 25, LinkedTxn: [{ TxnId: "cm-1", TxnType: "CreditMemo" }] },
			],
			balanceCentsByQbInvoiceId: new Map([
				["a", 100000],
				["je-1", 100000],
				["cm-1", 100000],
			]),
		});

		expect(result).toEqual({
			allocations: [{ qbInvoiceId: "a", cents: 6000 }],
			unplacedCents: 0,
			overappliedQbInvoiceIds: [],
		});
	});
});
