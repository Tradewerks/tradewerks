import { describe, it, expect } from "vitest";
import {
	calculateDocumentTax,
	floorTowardZero,
} from "../../../services/taxEngine.js";
import {
	adjustmentLineSchema,
	createInvoiceSchema,
	createInvoicePaymentSchema,
	createRefundSchema,
} from "../invoices.js";
import { resolveDisputeSchema } from "../disputes.js";

const CLIENT = "11111111-1111-4111-8111-111111111111";

const line = (over: Record<string, unknown> = {}) => ({
	name: "Credit: compressor",
	quantity: -1,
	unit_price: 500,
	total: -500,
	...over,
});

/**
 * `total` is what recomputeDocumentTotals taxes and what the invoice subtotal
 * sums; quantity and unit_price are what the client-facing document prints. The
 * two must agree or the document is internally inconsistent — a line reading
 * "1 × $10.00" on a $5,000 credit reconciles against nothing.
 */
describe("adjustmentLineSchema arithmetic", () => {
	it("accepts a credit line whose total matches quantity × unit price", () => {
		expect(adjustmentLineSchema.safeParse(line()).success).toBe(true);
	});

	it("accepts a net-positive correction line", () => {
		const parsed = adjustmentLineSchema.safeParse(
			line({
				name: "Additional labour",
				quantity: 2,
				unit_price: 75,
				total: 150,
			}),
		);
		expect(parsed.success).toBe(true);
	});

	it("rejects a total that does not equal quantity × unit price", () => {
		const parsed = adjustmentLineSchema.safeParse(
			line({ quantity: 1, unit_price: 10, total: -5000 }),
		);
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain("quantity");
	});

	// Cents, not floats: 3 × 0.1 is 0.30000000000000004 in IEEE 754, and an
	// exact comparison would refuse an honest line.
	it("accepts a line whose product is only float-exact in cents", () => {
		const parsed = adjustmentLineSchema.safeParse(
			line({ quantity: 3, unit_price: 0.1, total: 0.3 }),
		);
		expect(parsed.success).toBe(true);
	});

	it("rejects a zero quantity and a zero total", () => {
		expect(
			adjustmentLineSchema.safeParse(
				line({ quantity: 0, unit_price: 500, total: 0 }),
			).success,
		).toBe(false);
		expect(
			adjustmentLineSchema.safeParse(
				line({ quantity: -1, unit_price: 0, total: 0 }),
			).success,
		).toBe(false);
	});
});

/**
 * Spec §7.5 relaxes negatives on the adjustment path ONLY. This pins the other
 * half of that sentence: if someone ever "DRYs" the two schemas together, an
 * ordinary invoice for a negative amount becomes creatable through the normal
 * form, which is a data-entry error rather than a credit.
 */
describe("ordinary invoice schemas still reject negatives", () => {
	it("refuses a negative total on createInvoiceSchema", () => {
		const parsed = createInvoiceSchema.safeParse({
			client_id: CLIENT,
			total: -100,
		});
		expect(parsed.success).toBe(false);
	});

	it("refuses a negative subtotal and tax_amount on createInvoiceSchema", () => {
		expect(
			createInvoiceSchema.safeParse({ client_id: CLIENT, subtotal: -1 })
				.success,
		).toBe(false);
		expect(
			createInvoiceSchema.safeParse({ client_id: CLIENT, tax_amount: -1 })
				.success,
		).toBe(false);
	});

	// The refund path negates server-side, so the ordinary payment schema keeps
	// its .positive() rather than being loosened to "non-zero".
	it("refuses a negative or zero payment amount", () => {
		expect(
			createInvoicePaymentSchema.safeParse({ amount: -50 }).success,
		).toBe(false);
		expect(
			createInvoicePaymentSchema.safeParse({ amount: 0 }).success,
		).toBe(false);
	});
});

describe("createRefundSchema", () => {
	it("requires a positive amount and a reason", () => {
		expect(
			createRefundSchema.safeParse({
				amount: 50,
				reason: "Duplicate charge",
			}).success,
		).toBe(true);
		expect(
			createRefundSchema.safeParse({ amount: 0, reason: "x" }).success,
		).toBe(false);
		// Negative is rejected too: the API carries the size of the refund and
		// recordRefund applies the sign, so -50 would mean giving money back.
		expect(
			createRefundSchema.safeParse({ amount: -50, reason: "x" }).success,
		).toBe(false);
		expect(
			createRefundSchema.safeParse({ amount: 50, reason: "  " }).success,
		).toBe(false);
	});
});

/**
 * Math.floor rounds a positive amount toward zero but a negative one away from
 * it, so a bare floor made every credit line refund more tax than the matching
 * charge ever collected — a systematic bias, always in the client's favour.
 */
describe("tax rounding is sign-symmetric", () => {
	it("truncates toward zero for both signs", () => {
		expect(floorTowardZero(8.25)).toBe(8);
		expect(floorTowardZero(-8.25)).toBe(-8);
		expect(floorTowardZero(8)).toBe(8);
		expect(floorTowardZero(-8)).toBe(-8);
		expect(floorTowardZero(0)).toBe(0);
	});

	it("is identical to Math.floor for positive amounts", () => {
		// This is what makes the change safe: every quote, invoice, job and
		// visit that predates credits computes exactly the tax it always did.
		for (const cents of [0, 1, 7, 99, 100, 12345, 999999]) {
			expect(floorTowardZero(cents * 0.0825)).toBe(
				Math.floor(cents * 0.0825),
			);
		}
	});

	const group = {
		id: "tg1",
		name: "State",
		rates: [{ id: "r1", name: "State", rate: 0.0825 }],
	};

	const taxFor = (totalCents: number) =>
		calculateDocumentTax(
			{
				line_items: [
					{
						id: "li1",
						total_cents: totalCents,
						taxable: true,
						tax_group: group as never,
					},
				],
				discount_type: null,
				discount_value: null,
			},
			false,
		).line_item_tax_amounts["li1"];

	it("credits exactly the tax the matching charge collected", () => {
		// -100c x 8.25% = -8.25c. Math.floor gave -9 where +100c gives +8, so
		// a $1.00 credit used to refund a cent of tax that was never charged.
		expect(taxFor(100)).toBe(8);
		expect(taxFor(-100)).toBe(-8);
		expect(taxFor(-100)).toBe(-taxFor(100));
	});

	it("mirrors the charge at every magnitude, not just the awkward one", () => {
		// Asserted as a sum rather than a negation: at magnitudes where the tax
		// floors to zero the two sides are +0 and -0, which are numerically
		// equal but not Object.is-equal, and the invariant being pinned is that
		// a credit reverses its charge to the cent.
		for (const cents of [1, 50, 100, 1050, 99999]) {
			expect(taxFor(-cents) + taxFor(cents)).toBe(0);
		}
	});
});

describe("resolveDisputeSchema line gating", () => {
	it("rejects an adjustment whose lines net to zero", () => {
		const parsed = resolveDisputeSchema.safeParse({
			resolution: "IssueAdjustment",
			adjustment_lines: [
				line(),
				line({
					name: "Re-bill compressor",
					quantity: 1,
					unit_price: 500,
					total: 500,
				}),
			],
		});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain("net adjustment");
	});

	it("rejects adjustment lines sent with a non-adjustment outcome", () => {
		const parsed = resolveDisputeSchema.safeParse({
			resolution: "Repeal",
			note: "Client withdrew the job",
			adjustment_lines: [line()],
		});
		expect(parsed.success).toBe(false);
	});

	it("requires a note for Repeal but not for the other outcomes", () => {
		expect(
			resolveDisputeSchema.safeParse({ resolution: "Repeal" }).success,
		).toBe(false);
		expect(
			resolveDisputeSchema.safeParse({ resolution: "ReviseAndResend" })
				.success,
		).toBe(true);
	});

	it("requires at least one line for IssueAdjustment", () => {
		expect(
			resolveDisputeSchema.safeParse({ resolution: "IssueAdjustment" })
				.success,
		).toBe(false);
		expect(
			resolveDisputeSchema.safeParse({
				resolution: "IssueAdjustment",
				adjustment_lines: [],
			}).success,
		).toBe(false);
	});
});
