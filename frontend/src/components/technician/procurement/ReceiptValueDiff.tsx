import { AlertTriangle, ScanLine } from "lucide-react";
import { OCR_LOW_CONFIDENCE } from "../../../types/fieldPurchases";

interface Props {
	/** The field's own name, for the button that takes the receipt's answer. */
	label: string;
	/** What is in the field now, formatted as the field shows it. */
	entered: string;
	/** What the receipt read, same formatting. Null where it read nothing. */
	receipt: string | null;
	onUse: (value: string) => void;
	/** The provider's score for this field, where it reported one. */
	confidence?: number | null;
	/** Compare as money rather than as text. See `differs` below. */
	numeric?: boolean;
	/** False past submit: the reading is still worth showing, taking it is not. */
	editable?: boolean;
	/** The input this fills, so focus lands there when the button unmounts itself. */
	controlId?: string;
}

/** A cent of slack, matching the tolerance the total-consistency check uses. */
const MONEY_EPSILON = 0.01;

/**
 * `24.9` and `24.90` are the same amount. Compared as strings they are a
 * disagreement, and a marker that nags about formatting is one technicians learn
 * to ignore. Text fields stay a string compare, where spelling is the point.
 */
function valuesDiffer(entered: string, receipt: string, numeric: boolean): boolean {
	if (!numeric) return receipt.trim() !== entered.trim();
	const a = Number(entered);
	const b = Number(receipt);
	if (entered.trim() === "" || Number.isNaN(a) || Number.isNaN(b)) return true;
	return Math.abs(a - b) > MONEY_EPSILON;
}

/**
 * What the receipt read for one header field, beside what the technician entered.
 *
 * The receipt is the source of truth and the technician is the verifier of record,
 * which only conflicts when the two disagree. Extraction resolves that in the
 * technician's favour — it never overwrites a value they entered — so without this
 * the receipt's own reading was decided against silently and then discarded. Shown,
 * never applied: taking it is a press.
 */
export default function ReceiptValueDiff({
	label,
	entered,
	receipt,
	onUse,
	confidence,
	numeric = false,
	editable = true,
	controlId,
}: Props) {
	const differs = receipt != null && valuesDiffer(entered, receipt, numeric);
	const unsure = confidence != null && confidence < OCR_LOW_CONFIDENCE;
	if (!differs && !unsure) return null;

	// Pressing it is what removes it, so focus would fall to <body> and drop a
	// keyboard user back at the top of the page.
	const use = (value: string) => {
		onUse(value);
		if (controlId) document.getElementById(controlId)?.focus();
	};

	return (
		<span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
			{unsure && (
				<span className="inline-flex items-center gap-1 text-warning-text">
					<AlertTriangle aria-hidden size={11} /> low confidence
				</span>
			)}
			{differs && (
				<span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
					<ScanLine aria-hidden size={11} className="flex-shrink-0 text-text-muted" />
					<span className="text-text-muted">
						receipt reads <span className="text-text-secondary">{receipt}</span>
					</span>
					{/* Past submit the reading is still a fact about the record, but
					    taking it would edit a disabled field and dirty a locked sheet. */}
					{editable && (
						<button
							type="button"
							aria-label={`Use the receipt's ${label.toLowerCase()}`}
							onClick={() => use(receipt)}
							className="font-medium text-primary underline-offset-2 hover:underline"
						>
							use it
						</button>
					)}
				</span>
			)}
		</span>
	);
}
