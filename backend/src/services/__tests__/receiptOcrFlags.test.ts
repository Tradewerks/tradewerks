import { describe, it, expect } from "vitest";
import { buildOcrFlags } from "../receiptOcr/flags.js";
import type { ReceiptExtraction } from "../receiptOcr/normalize.js";

const base: ReceiptExtraction = {
	vendor_name: "Johnstone Supply",
	receipt_number: "884213",
	vendor_phone: null,
	purchased_at: new Date("2026-10-14T13:42:00Z"),
	subtotal: 52.5,
	tax_amount: 4.2,
	total: 56.7,
	document_type: null,
	currency: "USD",
	lines: [],
	field_confidence: {
		vendor_name: 0.95,
		receipt_number: 0.95,
		purchased_at: 0.95,
		subtotal: 0.95,
		tax_amount: 0.95,
		total: 0.95,
	},
	field_source: {},
	raw: null,
};

describe("buildOcrFlags", () => {
	it("null value is not_found", () => {
		const out = buildOcrFlags({ ...base, receipt_number: null });
		expect(out.fields.receipt_number).toEqual({
			kind: "not_found",
			confidence: null,
			rule: null,
		});
	});

	it("derived total is calculated regardless of confidence", () => {
		const out = buildOcrFlags({
			...base,
			field_confidence: { ...base.field_confidence, total: 0.99 },
			field_source: { total: { source: "derived" } },
		});
		expect(out.fields.total?.kind).toBe("calculated");
	});

	it("rule-picked value is unsure with rule name", () => {
		const out = buildOcrFlags({
			...base,
			field_confidence: { ...base.field_confidence, vendor_name: 0.8 },
			field_source: {
				vendor_name: { source: "rule", rule: "The Home Depot" },
			},
		});
		expect(out.fields.vendor_name).toEqual({
			kind: "unsure",
			confidence: 0.8,
			rule: "The Home Depot",
		});
	});

	it("handwritten rule stays unsure even at high confidence", () => {
		const out = buildOcrFlags({
			...base,
			field_confidence: { ...base.field_confidence, total: 0.99 },
			field_source: { total: { source: "rule", rule: "handwritten" } },
		});
		expect(out.fields.total).toEqual({
			kind: "unsure",
			confidence: 0.99,
			rule: "handwritten",
		});
	});

	it("read below cutoff is unsure, at/above is omitted", () => {
		const at = (c: number) =>
			buildOcrFlags({
				...base,
				field_confidence: { ...base.field_confidence, tax_amount: c },
			});
		expect(at(0.74).fields.tax_amount).toEqual({
			kind: "unsure",
			confidence: 0.74,
			rule: null,
		});
		expect(at(0.75).fields.tax_amount).toBeUndefined();
	});

	it("receipt_number cutoff is 0.85", () => {
		const at = (c: number) =>
			buildOcrFlags({
				...base,
				field_confidence: {
					...base.field_confidence,
					receipt_number: c,
				},
			});
		expect(at(0.84).fields.receipt_number?.kind).toBe("unsure");
		expect(at(0.85).fields.receipt_number).toBeUndefined();
	});

	it("a read value with no confidence is not flagged", () => {
		const { subtotal: _s, ...rest } = base.field_confidence;
		expect(
			buildOcrFlags({ ...base, field_confidence: rest }).fields.subtotal,
		).toBeUndefined();
	});

	it("custom cutoffs override defaults", () => {
		const cutoffs = {
			fields: {
				vendor_name: 0.9,
				receipt_number: 0.9,
				purchased_at: 0.9,
				subtotal: 0.9,
				tax_amount: 0.9,
				total: 0.9,
			},
			line: 0.5,
		};
		const out = buildOcrFlags(
			{
				...base,
				field_confidence: { ...base.field_confidence, total: 0.85 },
			},
			cutoffs,
		);
		expect(out.line_cutoff).toBe(0.5);
		expect(out.fields.total?.kind).toBe("unsure");
	});
});
