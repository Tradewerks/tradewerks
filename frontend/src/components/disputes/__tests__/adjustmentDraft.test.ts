import { describe, it, expect } from "vitest";
import {
	adjustmentInvalid,
	blankAdjustmentLine,
	draftFromLineItem,
	draftRowError,
	draftTotal,
	isPristineBlank,
	netAdjustment,
	seedAdjustmentLines,
	toAdjustmentLineInputs,
	type AdjustmentDraft,
	type DisputeLineItem,
} from "../adjustmentDraft";

const line = (over: Partial<DisputeLineItem> = {}): DisputeLineItem => ({
	id: "li1",
	name: "Compressor replacement",
	total: 450,
	unit_price: 450,
	quantity: 1,
	source_job_id: "job-1",
	source_visit_id: null,
	tax_group_id: "tg-1",
	tax_group: { name: "NY State" },
	inventory_item_id: "inv-item-1",
	taxable: true,
	...over,
});

const draft = (over: Partial<AdjustmentDraft> = {}): AdjustmentDraft => ({
	...blankAdjustmentLine(),
	name: "Credit: Compressor replacement",
	quantity: "1",
	unitPrice: "450",
	...over,
});

describe("draftTotal", () => {
	it("is negative for a credit and positive for a charge", () => {
		expect(draftTotal(draft({ kind: "credit" }))).toBe(-450);
		expect(draftTotal(draft({ kind: "charge" }))).toBe(450);
	});

	/**
	 * The toggle is the only thing that decides direction. A dispatcher who
	 * types a minus sign as well used to produce a charge from a credit row.
	 */
	it("ignores a minus sign typed into the amounts", () => {
		expect(draftTotal(draft({ kind: "credit", quantity: "-1" }))).toBe(-450);
		expect(draftTotal(draft({ kind: "credit", unitPrice: "-450" }))).toBe(-450);
	});

	it("rounds to cents", () => {
		expect(
			draftTotal(draft({ kind: "charge", quantity: "3", unitPrice: "0.333" }))
		).toBe(1);
	});

	/** Rounding the magnitude and negating is not the same as rounding the
	 *  negative — Math.round is half-up, so it is asymmetric about zero. */
	it("rounds a credit the way the server's own total check does", () => {
		expect(
			draftTotal(draft({ kind: "credit", quantity: "1.5", unitPrice: "19.99" }))
		).toBe(-29.98);
	});

	it("does not produce negative zero", () => {
		expect(draftTotal(draft({ kind: "credit", unitPrice: "0" }))).toBe(0);
	});
});

describe("netAdjustment", () => {
	it("sums signed row totals", () => {
		const rows = [
			draft({ kind: "credit", unitPrice: "100" }),
			draft({ kind: "charge", unitPrice: "30" }),
		];
		expect(netAdjustment(rows)).toBe(-70);
	});
});

describe("draftFromLineItem", () => {
	it("credits the whole line at its price and inherits its attribution", () => {
		const row = draftFromLineItem(line());
		expect(row.kind).toBe("credit");
		expect(row.name).toBe("Credit: Compressor replacement");
		expect(row.quantity).toBe("1");
		expect(row.unitPrice).toBe("450");
		expect(row.originLineId).toBe("li1");
		expect(row.originName).toBe("Compressor replacement");
		expect(row.originTaxGroupName).toBe("NY State");
		expect(row.sourceJobId).toBe("job-1");
		expect(row.taxGroupId).toBe("tg-1");
		expect(row.taxable).toBe(true);
	});

	it("falls back to the line total when no unit price is present", () => {
		expect(
			draftFromLineItem(line({ unit_price: undefined, total: 75 })).unitPrice
		).toBe("75");
	});

	it("seeds the line's own quantity, not one unit", () => {
		expect(
			draftFromLineItem(line({ quantity: 4, unit_price: 50, total: 200 }))
				.quantity
		).toBe("4");
	});

	it("falls back to one unit when the line has no quantity", () => {
		expect(draftFromLineItem(line({ quantity: undefined })).quantity).toBe("1");
	});
});

describe("seedAdjustmentLines", () => {
	it("seeds one credit per contested line", () => {
		const rows = seedAdjustmentLines(
			[line(), line({ id: "li2", name: "Travel", total: 50, unit_price: 50 })],
			[{ id: "li2", name: "Travel", total: 50 }]
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.originLineId).toBe("li2");
	});

	/** Never an empty box with a hidden "add" affordance. */
	it("returns one blank row when nothing was contested", () => {
		const rows = seedAdjustmentLines([line()], null);
		expect(rows).toHaveLength(1);
		expect(isPristineBlank(rows[0]!)).toBe(true);
	});
});

describe("draftRowError", () => {
	it("names one problem at a time, description first", () => {
		expect(draftRowError(draft({ name: "  " }))).toBe("Add a description");
		expect(draftRowError(draft({ quantity: "0" }))).toBe("Quantity can't be zero");
		expect(draftRowError(draft({ unitPrice: "0" }))).toBe("Amount can't be zero");
		expect(draftRowError(draft())).toBeNull();
	});
});

describe("adjustmentInvalid", () => {
	it("rejects an empty list, a zero net and a row with a problem", () => {
		expect(adjustmentInvalid([])).toBe(true);
		expect(
			adjustmentInvalid([
				draft({ kind: "credit", unitPrice: "100" }),
				draft({ kind: "charge", unitPrice: "100" }),
			])
		).toBe(true);
		expect(adjustmentInvalid([draft({ name: "" })])).toBe(true);
		expect(adjustmentInvalid([draft()])).toBe(false);
	});
});

describe("toAdjustmentLineInputs", () => {
	/**
	 * One convention on the wire — negative quantity, positive unit price —
	 * so two rows meaning the same credit cannot print differently on the
	 * client's document.
	 */
	it("emits a negative quantity and a positive unit price for a credit", () => {
		const [wire] = toAdjustmentLineInputs([
			draft({ kind: "credit", quantity: "2", unitPrice: "50" }),
		]);
		expect(wire).toMatchObject({ quantity: -2, unit_price: 50, total: -100 });
	});

	it("emits a positive quantity for a charge", () => {
		const [wire] = toAdjustmentLineInputs([
			draft({ kind: "charge", quantity: "2", unitPrice: "50" }),
		]);
		expect(wire).toMatchObject({ quantity: 2, unit_price: 50, total: 100 });
	});

	/** The server refuses a line whose total is not quantity × unit price. */
	it("satisfies the server's quantity × unit price === total invariant", () => {
		for (const row of [
			draft({ kind: "credit", quantity: "3", unitPrice: "19.99" }),
			draft({ kind: "charge", quantity: "1.5", unitPrice: "12.34" }),
			draft({ kind: "credit", quantity: "1.5", unitPrice: "19.99" }),
			draft({ kind: "credit", quantity: "0.25", unitPrice: "19.98" }),
		]) {
			const [wire] = toAdjustmentLineInputs([row]);
			expect(Math.round(wire!.quantity * wire!.unit_price * 100)).toBe(
				Math.round(wire!.total * 100)
			);
		}
	});

	it("carries attribution and trims the name", () => {
		const [wire] = toAdjustmentLineInputs([draftFromLineItem(line())]);
		expect(wire).toMatchObject({
			name: "Credit: Compressor replacement",
			source_job_id: "job-1",
			source_visit_id: null,
			tax_group_id: "tg-1",
			inventory_item_id: "inv-item-1",
			taxable: true,
		});
	});

	/** originLineId is a UI concern; the API has no field for it. */
	it("does not send the origin line id", () => {
		const [wire] = toAdjustmentLineInputs([draftFromLineItem(line())]);
		expect(wire).not.toHaveProperty("originLineId");
	});
});

describe("isPristineBlank", () => {
	it("is true only for an untouched blank row", () => {
		expect(isPristineBlank(blankAdjustmentLine())).toBe(true);
		expect(isPristineBlank(draft())).toBe(false);
		expect(isPristineBlank(draftFromLineItem(line()))).toBe(false);
	});
});
