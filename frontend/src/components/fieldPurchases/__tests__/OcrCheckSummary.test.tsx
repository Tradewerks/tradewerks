import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OcrCheckSummary } from "../OcrCheckSummary";
import { needsCheck } from "../ocrFlagCopy";
import type { OcrFlagSet } from "../../../types/fieldPurchases";

const flags: OcrFlagSet = {
	line_cutoff: 0.75,
	fields: {
		total: { kind: "calculated", confidence: null, rule: null },
		vendor_name: { kind: "unsure", confidence: 0.5, rule: null },
		tax_amount: { kind: "unsure", confidence: 0.4, rule: null },
		receipt_number: { kind: "not_found", confidence: null, rule: null },
	},
};

describe("OcrCheckSummary", () => {
	it("lists only unresolved unsure/calculated in field order", () => {
		render(
			<OcrCheckSummary
				flags={flags}
				review={{
					tax_amount: {
						state: "confirmed",
						at: "2026-11-06T00:00:00Z",
					},
				}}
			/>
		);
		expect(screen.getByText("Check against photo: Vendor, Total")).toBeInTheDocument();
	});

	it("is null when nothing to check or flags null", () => {
		const { container, rerender } = render(
			<OcrCheckSummary flags={null} review={{}} />
		);
		expect(container).toBeEmptyDOMElement();
		rerender(
			<OcrCheckSummary
				flags={{
					line_cutoff: 0.75,
					fields: { receipt_number: flags.fields.receipt_number! },
				}}
				review={{}}
			/>
		);
		expect(container).toBeEmptyDOMElement();
		expect(needsCheck(flags, {})).toEqual(["vendor_name", "tax_amount", "total"]);
	});
});
