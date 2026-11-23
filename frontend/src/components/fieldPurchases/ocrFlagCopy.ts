import i18n from "../../i18n";
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

export function ocrLineReason(confidence: number): string {
	return i18n.t("ocrChip.line", { pct: Math.round(confidence * 100) });
}

export function ocrFlagReason(field: OcrFieldKey, flag: OcrFieldFlag): string {
	const { t } = i18n;
	switch (flag.kind) {
		case "unsure":
			// Pen-written digits read confidently and wrong, so the percent would mislead.
			if (flag.rule === "handwritten") return t("ocrChip.handwritten");
			// First: a rule-picked field carries a fixed stand-in confidence, not a reading.
			if (flag.rule) return t("ocrChip.layout", { rule: flag.rule });
			if (flag.confidence != null)
				return t("ocrChip.sure", { pct: Math.round(flag.confidence * 100) });
			return t("ocrChip.notSure");
		case "calculated":
			if (field === "total") return t("ocrChip.calcTotal");
			if (field === "subtotal") return t("ocrChip.calcSubtotal");
			return t("ocrChip.calc");
		case "not_found":
			return t("ocrChip.notFound");
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
