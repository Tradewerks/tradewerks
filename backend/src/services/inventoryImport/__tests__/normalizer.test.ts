import { describe, expect, it } from "vitest";
import { normalizeInventoryRow } from "../normalizer.js";

function normalize(proposal: Record<string, unknown>, confidence: Record<string, number> = {}) {
	return normalizeInventoryRow({ proposal, fieldConfidence: confidence, fieldEvidence: {} });
}

describe("normalizeInventoryRow", () => {
	it("normalizes whitespace, identifiers, units, money, and list fields", () => {
		const result = normalize({
			name: "  Pleated   Filter ", location: " A-1 ", sku: " fil-20 ", barcode: " 12 34 ",
			unit: "EACH", quantity: "12.50", cost: "$1,234.50", tags: "Filters; Stock",
		});
		expect(result.proposal).toMatchObject({
			name: "Pleated Filter", location: "A-1", sku: "FIL-20", barcode: "1234",
			unit: "each", quantity: 12.5, cost: 1234.5, tags: ["Filters", "Stock"],
		});
		expect(result.financialFields).toEqual(["quantity", "cost"]);
		expect(result.issues).toEqual([]);
	});

	it("keeps invalid precision and negative financial values reviewable", () => {
		const result = normalize({ name: "Filter", location: "A1", quantity: "1.234", cost: "-2.00" });
		expect(result.proposal.quantity).toBe(1.234);
		expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["INVALID_PRECISION", "NEGATIVE"]));
	});

	it("requires tracking evidence for positive serialized and batch stock", () => {
		const serialized = normalize({ name: "Motor", location: "A1", quantity: 2, is_serialized: "yes", serial_numbers: "S1" });
		const batched = normalize({ name: "Refrigerant", location: "A1", quantity: 5, is_batch_tracked: true });
		expect(serialized.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACKING_REQUIRED", field: "serial_numbers" })]));
		expect(batched.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TRACKING_REQUIRED", field: "lot_number" })]));
	});

	it("marks mapped values below the threshold as low confidence without dropping them", () => {
		const result = normalize({ name: "Filter", location: "A1" }, { name: 0.72, location: 1 });
		expect(result.lowConfidence).toBe(true);
		expect(result.proposal.name).toBe("Filter");
	});

	it("keeps nullable clears reviewable without treating them as malformed numbers", () => {
		const result = normalize({
			name: "Filter",
			location: "A1",
			quantity: null,
			cost: null,
			unit_price: null,
			cost_at_receipt: null,
			low_stock_threshold: null,
		});
		expect(result.proposal).toMatchObject({
			cost: null,
			unit_price: null,
			cost_at_receipt: null,
			low_stock_threshold: null,
		});
		expect(result.proposal).not.toHaveProperty("quantity");
		expect(result.issues).toEqual([]);
		expect(result.financialFields).toEqual(["quantity", "cost", "unit_price", "cost_at_receipt"]);
	});
});
