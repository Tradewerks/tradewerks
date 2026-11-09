import type { OcrFieldKey, OcrFieldReview, OcrFlagSet } from "../../../types/fieldPurchases";

export type ReviewState = "confirmed" | "edited";
export type FieldStrings = Partial<Record<OcrFieldKey, string | null>>;

const MONEY: OcrFieldKey[] = ["subtotal", "tax_amount", "total"];

/** Money to the cent, the date by day, text trimmed: formatting is not an edit. */
export function sameReading(field: OcrFieldKey, entered: string, reading: string): boolean {
	if (MONEY.includes(field)) {
		const a = Number(entered);
		const b = Number(reading);
		if (entered.trim() === "" || Number.isNaN(a) || Number.isNaN(b)) return false;
		return Math.round(a * 100) === Math.round(b * 100);
	}
	// To the minute, as the input shows it: a corrected time on the right day is an edit.
	if (field === "purchased_at") return entered.slice(0, 16) === reading.slice(0, 16);
	return entered.trim() === reading.trim();
}

/**
 * "Edited" is derived, never stored on the screen: a value that differs from the scan's
 * reading is edited, and putting it back un-edits it. What survives that round trip is
 * only an earlier "Looks right". Where the scan's reading is unavailable the stored
 * review stands, since there is nothing to compare against.
 */
export function effectiveReviews({
	flags,
	readings,
	entered,
	confirmed,
	stored,
	locked,
}: {
	flags: OcrFlagSet | null;
	readings: FieldStrings;
	entered: FieldStrings;
	confirmed: ReadonlySet<OcrFieldKey>;
	stored: OcrFieldReview;
	/** Fields the technician cannot change: a difference there is not their edit. */
	locked?: ReadonlySet<OcrFieldKey>;
}): Partial<Record<OcrFieldKey, ReviewState>> {
	const out: Partial<Record<OcrFieldKey, ReviewState>> = {};
	if (!flags) return out;
	for (const key of Object.keys(flags.fields) as OcrFieldKey[]) {
		const reading = readings[key];
		if (locked?.has(key)) {
			if (confirmed.has(key)) out[key] = "confirmed";
		} else if (reading == null) {
			const was = stored[key]?.state;
			if (confirmed.has(key)) out[key] = "confirmed";
			else if (was) out[key] = was;
		} else if (!sameReading(key, entered[key] ?? "", reading)) {
			out[key] = "edited";
		} else if (confirmed.has(key)) {
			out[key] = "confirmed";
		}
	}
	return out;
}

/** The wire shape: a state to record, or null to withdraw one the server holds. */
export function reviewsToSend(
	flags: OcrFlagSet | null,
	effective: Partial<Record<OcrFieldKey, ReviewState>>,
	stored: OcrFieldReview
): Partial<Record<OcrFieldKey, ReviewState | null>> | undefined {
	if (!flags) return undefined;
	const out: Partial<Record<OcrFieldKey, ReviewState | null>> = {};
	for (const key of Object.keys(flags.fields) as OcrFieldKey[]) {
		if (flags.fields[key]?.kind === "not_found") continue;
		const eff = effective[key];
		if (eff) out[key] = eff;
		else if (stored[key]) out[key] = null;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
