import { mapMindee } from "./mindee.js";
import type { OcrFile, ReceiptExtraction } from "./normalize.js";

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
 * The payload is deliberately Mindee-shaped and goes through the real adapter, so
 * what the fixture exercises is the same mapping a live provider would.
 */
const line = (description: string, quantity: number, unit_price: number, confidence: string) => ({
	confidence,
	fields: {
		description: { value: description },
		quantity: { value: quantity },
		unit_price: { value: unit_price },
		total_price: { value: Math.round(quantity * unit_price * 100) / 100 },
	},
});

/**
 * The merchant is fictional and its address is not a place - `ZZ` is not a state
 * code and `00000` is not a ZIP. A demo payload that names a real distributor at a
 * real street address reads as a business record rather than as sample data,
 * wherever this repo is read.
 *
 * `__fixtures__/mindeeV2Receipt.json` carries the same receipt inside a full V2
 * envelope. The numbers are shared deliberately: two payloads with two answers
 * mean a test passing against one proves nothing about the other.
 */
export const SAMPLE_RECEIPT = {
	inference: {
		result: {
			fields: {
				supplier_name: { value: "Northgate Trade Supply", confidence: "Certain" },
				supplier_address: {
					value: "1200 Example Industrial Way, Springfield, ZZ 00000",
					confidence: "High",
				},
				supplier_phone_number: { value: "(555) 555-0188", confidence: "High" },
				receipt_number: { value: "884213", confidence: "Certain" },
				document_type: { value: "expense_receipt", confidence: "Certain" },
				locale: {
					confidence: "Certain",
					fields: {
						language: { value: "en" },
						country: { value: "US" },
						currency: { value: "USD" },
					},
				},
				date: { value: "2026-08-21", confidence: "High" },
				time: { value: "14:32:00", confidence: "High" },
				total_net: { value: 287.83, confidence: "High" },
				// Under OCR_LOW_CONFIDENCE on purpose: a demo receipt that never
				// trips the low-confidence marker cannot show what it looks like.
				total_tax: { value: 22.39, confidence: "Medium" },
				total_amount: { value: 310.22, confidence: "Certain" },
				taxes: {
					confidence: "Medium",
					items: [
						{
							fields: {
								rate: { value: 0.0778 },
								base: { value: 287.83 },
								amount: { value: 22.39 },
							},
						},
					],
				},
				line_items: {
					confidence: "High",
					items: [
						line("Capacitor 45/5 MFD 440V", 2, 24.99, "Certain"),
						line("Contactor 2P 30A 24V coil", 1, 18.45, "High"),
						line("R-410A refrigerant 25 lb", 1, 189.0, "High"),
						// Smudged on the paper, as the cheapest line on a receipt usually is.
						line("Line set 3/8 x 3/4 copper", 1, 62.4, "Medium"),
						// A printed trade discount. Without one the demo receipt cannot
						// show a signed line at all, and that is the path most likely to
						// be got wrong: dropped, it makes the receipt disagree with its
						// own lines and flags every discounted purchase.
						line("Contractor discount", 1, -32.0, "High"),
					],
				},
			},
		},
	},
} as const;

/** The file is ignored: the point is a result that does not depend on the input. */
export async function extractFixture(_file: OcrFile): Promise<ReceiptExtraction> {
	return mapFixture(SAMPLE_RECEIPT);
}

export function mapFixture(raw: unknown): ReceiptExtraction {
	return mapMindee(raw);
}
