import { Check, ScanLine } from "lucide-react";
import type { OcrFieldFlag, OcrFieldKey } from "../../../types/fieldPurchases";
import { OcrFieldChip } from "../../fieldPurchases/OcrFieldChip";

interface Props {
	/** The field's own name, for the button that takes the receipt's answer. */
	label: string;
	/** What is in the field now, formatted as the field shows it. */
	entered: string;
	/** What the receipt read, same formatting. Null where it read nothing. */
	receipt: string | null;
	/** Absent where there is nothing to take, such as a field with no input. */
	onUse?: (value: string) => void;
	/** Which header field this is, for the chip's wording. */
	field?: OcrFieldKey;
	/** What the scan thought of this field, where it had a doubt. */
	flag?: OcrFieldFlag;
	review?: "confirmed" | "edited" | null;
	/** "Looks right": the tech checked the photo and the value stands. */
	onConfirm?: () => void;
	/** Compare as money rather than as text. See `differs` below. */
	numeric?: boolean;
	/** False past submit: the reading is still worth showing, taking it is not. */
	editable?: boolean;
	/**
	 * Whether "Looks right" is offered; defaults to `editable`. Apart from it for a
	 * field locked on an open sheet, such as a refund's vendor: it cannot be changed,
	 * but a flag on it still has to be answered before submit.
	 */
	confirmable?: boolean;
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
	field,
	flag,
	review,
	onConfirm,
	numeric = false,
	editable = true,
	confirmable = editable,
	controlId,
}: Props) {
	const differs = receipt != null && valuesDiffer(entered, receipt, numeric);
	const chip = flag && field ? { field, flag } : null;
	// not_found is a fact, not a doubt, so it never asks for a press.
	const canConfirm =
		chip != null &&
		confirmable &&
		!review &&
		onConfirm != null &&
		(chip.flag.kind === "unsure" || chip.flag.kind === "calculated");
	if (!differs && !chip) return null;

	// Pressing it is what removes it, so focus would fall to <body> and drop a
	// keyboard user back at the top of the page.
	const use = (value: string) => {
		onUse?.(value);
		if (controlId) document.getElementById(controlId)?.focus();
	};

	return (
		<span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
			{chip && (
				<OcrFieldChip
					field={chip.field}
					flag={chip.flag}
					review={review}
					audience="technician"
				/>
			)}
			{canConfirm && (
				<button
					type="button"
					aria-label={`Looks right: ${label.toLowerCase()}`}
					onClick={onConfirm}
					// 40px of tap target without growing the label row: the padding is
					// the target, the negative margin gives the height back. The pill
					// inside is what reads as the button.
					className="group -my-2 inline-flex min-h-10 items-center rounded-md focus-visible:outline-none"
				>
					<span className="inline-flex h-6 items-center gap-1 rounded-md border border-primary/50 bg-primary/10 px-2 text-xs font-medium text-primary shadow-sm transition-colors duration-150 ease-out group-hover:border-primary group-hover:bg-primary/20 group-active:bg-primary/30 group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-primary">
						<Check aria-hidden size={12} strokeWidth={2.5} />
						Looks right
					</span>
				</button>
			)}
			{differs && (
				<span className="inline-flex flex-wrap items-center gap-x-1 gap-y-0.5">
					<ScanLine
						aria-hidden
						size={11}
						className="flex-shrink-0 text-text-muted"
					/>
					<span className="text-text-muted">
						receipt reads{" "}
						<span className="text-text-secondary">
							{receipt}
						</span>
					</span>
					{/* Past submit the reading is still a fact about the record, but
					    taking it would edit a disabled field and dirty a locked sheet. */}
					{editable && onUse && (
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
