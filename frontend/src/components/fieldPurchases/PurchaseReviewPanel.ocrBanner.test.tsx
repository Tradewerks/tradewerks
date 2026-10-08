import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OcrBanner } from "./PurchaseReviewPanel";
import type { FieldPurchase } from "../../types/fieldPurchases";

const skipped = (ocr_error: string | null) =>
	({ ocr_status: "skipped", ocr_error, ocr_provider: "mindee" }) as unknown as FieldPurchase;

describe("OcrBanner for a skipped read", () => {
	it("blames the missing reader when none is configured", () => {
		render(<OcrBanner purchase={skipped(null)} />);
		expect(screen.getByText(/no receipt reader is configured/)).toBeInTheDocument();
	});

	it("says the month's scans were used up when that is why", () => {
		render(<OcrBanner purchase={skipped("This month's receipt scans are used up.")} />);
		expect(
			screen.getByText(
				"Lines typed in by the technician — this month's receipt scans were used up."
			)
		).toBeInTheDocument();
		expect(screen.queryByText(/no receipt reader is configured/)).toBeNull();
	});
});
