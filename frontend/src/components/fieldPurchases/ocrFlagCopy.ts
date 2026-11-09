import type {
	OcrFieldFlag,
	OcrFieldKey,
	OcrFieldReview,
	OcrFlagSet,
} from "../../types/fieldPurchases";

export const OCR_FIELD_ORDER: OcrFieldKey[] = [
	"vendor_name",
	"receipt_number",
	"purchased_at",
	"subtotal",
	"tax_amount",
	"total",
];

export const OCR_FIELD_LABEL: Record<OcrFieldKey, string> = {
	vendor_name: "Vendor",
	receipt_number: "Receipt #",
	purchased_at: "Date",
	subtotal: "Subtotal",
	tax_amount: "Tax",
	total: "Total",
};

export function ocrLineReason(confidence: number): string {
	return `Reader was ${Math.round(confidence * 100)}% sure of this line. Check it against the photo.`;
}

export function ocrFlagReason(field: OcrFieldKey, flag: OcrFieldFlag): string {
	switch (flag.kind) {
		case "unsure":
			// Pen-written digits read confidently and wrong, so the percent would mislead.
			if (flag.rule === "handwritten") {
				return "Handwritten on the receipt. Check it against the photo.";
			}
			// First: a rule-picked field carries a fixed stand-in confidence, not a reading.
			if (flag.rule) {
				return `Picked using the ${flag.rule} receipt layout. Check it against the photo.`;
			}
			if (flag.confidence != null) {
				return `Reader was ${Math.round(flag.confidence * 100)}% sure. Check it against the photo.`;
			}
			return "Reader wasn't sure. Check it against the photo.";
		case "calculated":
			if (field === "total") return "No total read — subtotal + tax";
			if (field === "subtotal")
				return "Didn't add up with the total — total minus tax";
			return "Calculated, not read — check against the photo";
		case "not_found":
			return "Not on the receipt, or unreadable";
	}
}

/** Only unsure and calculated ask for a look; not_found is a fact, not a doubt. */
export function needsCheck(flags: OcrFlagSet | null, review: OcrFieldReview): OcrFieldKey[] {
	if (!flags) return [];
	return OCR_FIELD_ORDER.filter((k) => {
		const f = flags.fields[k];
		return f && (f.kind === "unsure" || f.kind === "calculated") && !review[k];
	});
}
