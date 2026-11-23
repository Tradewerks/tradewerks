import { useTranslation } from "react-i18next";
import type { OcrFieldReview, OcrFlagSet } from "../../types/fieldPurchases";
import { needsCheck } from "./ocrFlagCopy";

export function OcrCheckSummary({
	flags,
	review,
	against,
}: {
	flags: OcrFlagSet | null;
	review: OcrFieldReview;
	/** What the reader checks against: dispatch has the photo, the technician the paper. */
	against?: string;
}) {
	const { t } = useTranslation();
	const fields = needsCheck(flags, review);
	if (fields.length === 0) return null;
	return (
		<p className="text-xs text-warning-text">
			{t("ocrChip.checkAgainst", {
				against: against ?? t("ocrChip.photo"),
				fields: fields.map((f) => t(`ocrFields.${f}`)).join(", "),
			})}
		</p>
	);
}
