import {
	OCR_CUTOFFS,
	OCR_HEADER_FIELDS,
	type OcrCutoffs,
	type OcrFieldKey,
	type ReceiptExtraction,
} from "./normalize.js";

export type OcrFlagKind = "unsure" | "calculated" | "not_found";

export interface OcrFieldFlag {
	kind: OcrFlagKind;
	confidence: number | null;
	rule: string | null;
}

export interface OcrFlagSet {
	fields: Partial<Record<OcrFieldKey, OcrFieldFlag>>;
	line_cutoff: number;
}

/** Only fields the technician should look at appear; a clean read is absent. */
export function buildOcrFlags(
	x: ReceiptExtraction,
	cutoffs: OcrCutoffs = OCR_CUTOFFS,
): OcrFlagSet {
	const fields: OcrFlagSet["fields"] = {};
	for (const key of OCR_HEADER_FIELDS) {
		const confidence = x.field_confidence[key] ?? null;
		const src = x.field_source[key];
		if (x[key] == null) {
			fields[key] = { kind: "not_found", confidence: null, rule: null };
		} else if (src?.source === "derived") {
			fields[key] = { kind: "calculated", confidence, rule: null };
		} else if (src?.source === "rule") {
			fields[key] = { kind: "unsure", confidence, rule: src.rule ?? null };
		} else if (confidence != null && confidence < cutoffs.fields[key]) {
			fields[key] = { kind: "unsure", confidence, rule: null };
		}
	}
	return { fields, line_cutoff: cutoffs.line };
}
