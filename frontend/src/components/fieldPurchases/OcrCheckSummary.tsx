import type { OcrFieldReview, OcrFlagSet } from "../../types/fieldPurchases";
import { OCR_FIELD_LABEL, needsCheck } from "./ocrFlagCopy";

export function OcrCheckSummary({
	flags,
	review,
	against = "photo",
}: {
	flags: OcrFlagSet | null;
	review: OcrFieldReview;
	/** What the reader checks against: dispatch has the photo, the technician the paper. */
	against?: string;
}) {
	const fields = needsCheck(flags, review);
	if (fields.length === 0) return null;
	return (
		<p className="text-xs text-warning-text">
			Check against {against}: {fields.map((f) => OCR_FIELD_LABEL[f]).join(", ")}
		</p>
	);
}
