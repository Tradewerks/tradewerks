import type { ReconcileTarget } from "../../../api/inventory";
import type { FieldPurchase, FieldPurchaseDisposition } from "../../../types/fieldPurchases";

/** A receipt line as the sheet holds it, before it is sent with the submit. */
export interface LineDraft {
	/**
	 * React key. Index keys re-keyed every row below a deletion, so focus and
	 * uncommitted input bled one row upward. Server id where there is one, so an
	 * OCR re-seed does not re-key rows that did not change.
	 */
	key: string;
	/**
	 * Which job on the roster this line served, by the roster row's own key. Not
	 * the allocation id: a job added at the counter has no server id until the
	 * submit that creates it, and this has to hold a line to it before then.
	 */
	allocationKey: string;
	description: string;
	quantity: string;
	unit_price: string;
	inventory_item_id: string;
	/** The picked row itself, so the picker can show a name rather than an id. */
	item: ReconcileTarget | null;
	disposition: FieldPurchaseDisposition | "";
	disposition_vehicle_id: string;
	/** The technician has confirmed this line. Submit refuses while any is false. */
	acknowledged: boolean;
	/** Null on anything the technician typed; a score on anything OCR read. */
	ocrConfidence: number | null;
}

const EMPTY: Omit<LineDraft, "key" | "allocationKey"> = {
	description: "",
	quantity: "1",
	unit_price: "",
	inventory_item_id: "",
	item: null,
	// The common case by a distance: a part bought mid-job goes onto that job.
	disposition: "non_stock",
	disposition_vehicle_id: "",
	// Typed by hand, so already confirmed. Re-confirming your own typing is
	// ceremony; what the spec asks to be checked is what a machine read.
	acknowledged: true,
	ocrConfidence: null,
};

export const blankLine = (allocationKey = ""): LineDraft => ({
	...EMPTY,
	key: crypto.randomUUID(),
	allocationKey,
});

/**
 * Halves a line in two, both tagged and both editable. One counter item genuinely
 * serving two jobs is a line that has to become two — one nullable job per line,
 * no join table, and each half bills its own customer.
 */
export function splitLine(line: LineDraft, allocationKey: string): [LineDraft, LineDraft] {
	// Halved rather than copied whole, which would bill twice what was paid. The
	// remainder leans on the original, so the two always sum back to what was on
	// the receipt — a starting point the technician then edits.
	const quantity = Number(line.quantity) || 0;
	const moved = Math.floor((quantity / 2) * 100) / 100;
	const keep = Math.round((quantity - moved) * 100) / 100;
	return [
		{ ...line, quantity: String(keep) },
		{ ...line, key: crypto.randomUUID(), quantity: String(moved), allocationKey },
	];
}

export function toDrafts(
	purchase: FieldPurchase,
	/** Roster key by allocation id, for a sheet that has already been opened. */
	allocationKeys?: Map<string, string>
): LineDraft[] {
	return purchase.lines.map((l) => {
		const ocrConfidence = l.ocr_confidence == null ? null : Number(l.ocr_confidence);
		return {
			key: l.id,
			// Falls back to the allocation's own id, which is what the roster keys a
			// job the server already knows about by.
			allocationKey: l.allocation_id
				? (allocationKeys?.get(l.allocation_id) ?? l.allocation_id)
				: "",
			description: l.description,
			quantity: l.quantity,
			unit_price: l.unit_price,
			inventory_item_id: l.inventory_item_id ?? "",
			// Cost and provisional are not on the purchase's own projection of the
			// item; the picker only needs them to describe a row it just fetched.
			item: l.inventory_item
				? { ...l.inventory_item, cost: null, provisional: false }
				: null,
			disposition: l.disposition ?? "",
			disposition_vehicle_id: l.disposition_vehicle_id ?? "",
			// A line already confirmed stays confirmed; an extracted one starts
			// unconfirmed however well the provider scored it.
			acknowledged: !!l.verified_at || ocrConfidence == null,
			ocrConfidence,
		};
	});
}

/**
 * Rewrites any destination the technician can no longer stock. A draft saved from
 * one truck and reopened from another - a swap, a handover, a URL from last week -
 * holds a vehicle the server now refuses, and a control offering two answers cannot
 * show a third: the row would render with nothing selected and submit would fail on
 * a line nobody could see was wrong. Their own truck is the honest correction, and
 * the warehouse when they have none.
 *
 * Returns the same array when nothing needed rewriting, so a caller can use identity
 * to decide whether to re-set state.
 */
export function clampDestinations(drafts: LineDraft[], myVehicleId: string | null): LineDraft[] {
	const foreign = (d: LineDraft) =>
		!!d.disposition_vehicle_id && d.disposition_vehicle_id !== myVehicleId;
	if (!drafts.some(foreign)) return drafts;
	return drafts.map((d) =>
		foreign(d) ? { ...d, disposition_vehicle_id: myVehicleId ?? "" } : d
	);
}

/** One line as the receipt read it, plus whether the server wrote it onto the purchase. */
export interface ExtractedReceiptLine {
	description: string;
	quantity: number;
	unit_price: number;
	line_total: number;
	confidence: number | null;
	applied: boolean;
}

const normDescription = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The extracted lines the sheet is not already showing.
 *
 * Extraction runs while the technician types at the counter, and the server will
 * not overwrite lines they entered — so an extraction can be complete, correct and
 * nowhere on screen. These are what the sheet offers them.
 *
 * Suppressed by description rather than by id: a seeded line has no server id until
 * the submit that creates it. Editing a seeded line's description offers it again,
 * which is the safe direction to fail — the alternative loses it.
 */
export function pendingOcrLines(
	extracted: ExtractedReceiptLine[],
	drafts: LineDraft[],
): ExtractedReceiptLine[] {
	// Counted, not a set of names. Receipts repeat a description - the same part
	// bought twice, two boxes of wire nuts at different prices - and asking only
	// "is this description on the sheet" hid every repeat behind the first one.
	const onSheet = new Map<string, number>();
	for (const d of drafts) {
		if (d.ocrConfidence == null) continue;
		const key = normDescription(d.description);
		onSheet.set(key, (onSheet.get(key) ?? 0) + 1);
	}

	return extracted.filter((l) => {
		if (l.applied) return false;
		const key = normDescription(l.description);
		const left = onSheet.get(key) ?? 0;
		if (left === 0) return true;
		onSheet.set(key, left - 1);
		return false;
	});
}

/** Seeds beside what the technician typed — never over it, and never pre-confirmed. */
export function draftsFromOcr(
	extracted: ExtractedReceiptLine[],
	allocationKey = "",
): LineDraft[] {
	return extracted.map((l) => ({
		...blankLine(allocationKey),
		description: l.description,
		quantity: String(l.quantity),
		unit_price: String(l.unit_price),
		// False whatever the provider scored, including not at all: verification is
		// mandatory per line, and a null score is absence of evidence.
		acknowledged: false,
		ocrConfidence: l.confidence,
	}));
}
