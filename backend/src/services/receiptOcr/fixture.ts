import type { OcrFile, ReceiptExtraction } from "./normalize.js";
import { mapTextract, retainable } from "./textract.js";

/**
 * A keyless provider that always reads the same receipt. Auto-fill is otherwise
 * only demonstrable against a paid account over the network, which leaves the
 * whole extraction path untestable end to end and unreviewable on a machine with
 * no vendor key.
 *
 * Held as a TypeScript module rather than a .json file on purpose: `tsc` does not
 * copy JSON into `dist`, so a checked-in .json would resolve in tests and be
 * missing at runtime - exactly where the demo is needed.
 *
 * The payload is Textract-shaped and goes through the real adapter, so what the
 * fixture exercises is the same mapping the live provider runs.
 *
 * The merchant is fictional and its address is not a place. A demo payload that
 * names a real distributor reads as a business record rather than as sample data,
 * wherever this repo is read.
 *
 * The header states the review UI marks are here on purpose, because a demo
 * receipt that never trips a marker cannot show what one looks like: the date
 * reads poorly (unsure), the ticket number comes from a rule (unsure, by rule),
 * and there is no TOTAL line so the total is subtotal plus tax (calculated).
 */
const field = (type: string, text: string, confidence: number) => ({
	Type: { Text: type, Confidence: 99 },
	ValueDetection: { Text: text, Confidence: confidence },
	PageNumber: 1,
});

const line = (
	description: string,
	quantity: number,
	unitPrice: string,
	price: string,
	confidence = 96,
) => ({
	LineItemExpenseFields: [
		field("ITEM", description, confidence),
		field("QUANTITY", String(quantity), 99),
		field("UNIT_PRICE", unitPrice, 97),
		field("PRICE", price, 97),
	],
});

export const FIXTURE_RAW = {
	DocumentMetadata: { Pages: 1 },
	ExpenseDocuments: [
		{
			ExpenseIndex: 1,
			TextHints: { vendor: null, receipt_number: "884213", chain: null, document_kind: null },
			SummaryFields: [
				field("VENDOR_NAME", "Northgate Trade Supply", 99),
				field("VENDOR_PHONE", "(555) 555-0188", 98),
				// Under the OCR_CUTOFFS on purpose, as a smudged date is.
				field("INVOICE_RECEIPT_DATE", "08/21/2026", 60),
				field("SUBTOTAL", "$287.83", 96),
				field("TAX", "$22.39", 94),
			],
			LineItemGroups: [
				{
					LineItemGroupIndex: 1,
					LineItems: [
						line("Capacitor 45/5 MFD 440V", 2, "24.99", "49.98"),
						line("Contactor 2P 30A 24V coil", 1, "18.45", "18.45"),
						line("R-410A refrigerant 25 lb", 1, "189.00", "189.00"),
						// Smudged on the paper, as the cheapest line on a receipt usually is.
						line("Line set 3/8 x 3/4 copper", 1, "62.40", "62.40", 60),
						// A printed trade discount. Without one the demo receipt cannot
						// show a signed line at all, and that is the path most likely to
						// be got wrong: dropped, it makes the receipt disagree with its
						// own lines and flags every discounted purchase.
						line("Contractor discount", 1, "-32.00", "-32.00"),
					],
				},
			],
		},
	],
};

/** The file is ignored: the point is a result that does not depend on the input. */
export async function extractFixture(_file: OcrFile): Promise<ReceiptExtraction> {
	return mapTextract(retainable(FIXTURE_RAW));
}
