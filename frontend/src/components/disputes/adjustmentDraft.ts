import type { AdjustmentLineInput, ContestedLine } from "../../types/disputes";

/** The line-item shape both quotes and invoices already satisfy — only what the
 *  contested checklist and the credit picker need. It lives here rather than in
 *  DisputeModal so these helpers never import a component. */
export interface DisputeLineItem {
	id: string;
	name: string;
	total: number;
	/** Seeds a credit at the original's price. Optional so a caller with only a
	 *  total still satisfies the shape. */
	unit_price?: number;
	/** Seeds the credit at the line's own quantity, so "Credit this line"
	 *  credits the line rather than one unit of it. */
	quantity?: number;
	/** Carried onto a seeded row so the credit widens the same job/visit
	 *  billed-amount chain the original line fed. Invoice-only; quote line
	 *  items never have them. */
	source_job_id?: string | null;
	source_visit_id?: string | null;
	/** Carried onto a seeded row so relief is taxed exactly as the original
	 *  was, instead of falling back to the client/org default group. */
	tax_group_id?: string | null;
	/** Carried onto a seeded row so a credit against stock still links back to
	 *  the catalog item — otherwise a credited stock line loses that link. */
	inventory_item_id?: string | null;
	/** Display only — names the inherited group in the row's origin line. */
	tax_group?: { name: string } | null;
	taxable?: boolean;
}

/** Credit gives money back; charge bills more. Direction is a choice the
 *  dispatcher makes, never a minus sign they are expected to know about. */
export type AdjustmentKind = "credit" | "charge";

/** One job or visit the root invoice bills — a place a credit can land (D4).
 *  The editor shows a picker over these only when there is more than one. */
export interface AttributionTarget {
	kind: "job" | "visit";
	/** job_id for a job, visit_id for a visit — the id the API field wants. */
	id: string;
	label: string;
	/** For a visit target, the parent job_id: the API stores both. */
	jobId?: string;
}

export interface AdjustmentDraft {
	key: string;
	kind: AdjustmentKind;
	name: string;
	/** Magnitudes as typed. Strings so a half-entered "1." survives the
	 *  keystroke that produces it. */
	quantity: string;
	unitPrice: string;
	/** The invoice line this row answers, when it came from the picker. Held
	 *  for display only — the API has no field for it, and the attribution the
	 *  server needs travels in the four fields below. */
	originLineId: string | null;
	originName: string | null;
	originTaxGroupName: string | null;
	sourceJobId: string | null;
	sourceVisitId: string | null;
	taxGroupId: string | null;
	inventoryItemId: string | null;
	/** `undefined` (not `false`) on a manual row so the backend's
	 *  `taxable ?? true` default still applies. */
	taxable: boolean | undefined;
}

let keySeq = 0;
/** Unique within a session; nothing reads meaning from it. */
const nextDraftKey = (): string => `adj-${keySeq++}`;

const toNumber = (value: string): number => {
	const parsed = parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
};

const roundCents = (value: number): number => Math.round(value * 100) / 100;

/** `kind` is the only thing that decides direction, so a minus sign typed into
 *  an amount cannot flip a credit into a charge behind the toggle's back. */
const magnitude = (value: string): number => Math.abs(toNumber(value));

export const draftTotal = (row: AdjustmentDraft): number => {
	const size = magnitude(row.quantity) * magnitude(row.unitPrice);
	// Sign before rounding, not after: Math.round is half-up, so rounding an
	// already-negative amount gives a different cent than negating a rounded
	// positive one, and the server validates the two against each other.
	return roundCents(size !== 0 && row.kind === "credit" ? -size : size);
};

export const netAdjustment = (rows: AdjustmentDraft[]): number =>
	roundCents(rows.reduce((sum, row) => sum + draftTotal(row), 0));

export const blankAdjustmentLine = (): AdjustmentDraft => ({
	key: nextDraftKey(),
	kind: "credit",
	name: "",
	quantity: "1",
	unitPrice: "0",
	originLineId: null,
	originName: null,
	originTaxGroupName: null,
	sourceJobId: null,
	sourceVisitId: null,
	taxGroupId: null,
	inventoryItemId: null,
	taxable: undefined,
});

/** A credit for the whole invoice line, at that line's price, inheriting
 *  its tax treatment and its job/visit attribution — without those the credit
 *  is mis-taxed and the billed-amount chain never moves. */
export const draftFromLineItem = (line: DisputeLineItem): AdjustmentDraft => ({
	key: nextDraftKey(),
	kind: "credit",
	name: `Credit: ${line.name}`,
	quantity: String(line.quantity ?? 1),
	unitPrice: String(line.unit_price ?? line.total),
	originLineId: line.id,
	originName: line.name,
	originTaxGroupName: line.tax_group?.name ?? null,
	sourceJobId: line.source_job_id ?? null,
	sourceVisitId: line.source_visit_id ?? null,
	taxGroupId: line.tax_group_id ?? null,
	inventoryItemId: line.inventory_item_id ?? null,
	taxable: line.taxable,
});

/** One pre-filled credit per contested line makes the common case a single
 *  click. Nothing contested still gets a row, so the editor is never an empty
 *  box with a hidden "add" affordance. */
export const seedAdjustmentLines = (
	lineItems: DisputeLineItem[],
	contestedLines: ContestedLine[] | null | undefined
): AdjustmentDraft[] => {
	// The dispute stores a snapshot (DW-69), not a live id, so a line named
	// there may no longer be among lineItems at all — that seeds nothing for
	// it, same as before, rather than a stale row nobody can edit.
	const contested = new Set((contestedLines ?? []).map((c) => c.id));
	const seeded = lineItems.filter((line) => contested.has(line.id)).map(draftFromLineItem);
	return seeded.length > 0 ? seeded : [blankAdjustmentLine()];
};

/** An untouched starter row. Picking a line replaces one of these rather than
 *  leaving an empty row below the credit the dispatcher just added. */
export const isPristineBlank = (row: AdjustmentDraft): boolean =>
	row.originLineId === null && row.name.trim().length === 0 && toNumber(row.unitPrice) === 0;

/** The first thing wrong with a row, or null. One reason at a time: a row
 *  showing three complaints at once teaches nothing about which to fix.
 *  `requireAttribution` is true when the root invoice bills more than one job
 *  or visit, so every credit has to name the one it lands on (D4) — otherwise
 *  attributeAdjustmentLines 422s the whole submit. */
export const draftRowError = (
	row: AdjustmentDraft,
	requireAttribution = false
): string | null => {
	if (row.name.trim().length === 0) return "Add a description";
	if (magnitude(row.quantity) === 0) return "Quantity can't be zero";
	if (draftTotal(row) === 0) return "Amount can't be zero";
	if (requireAttribution && row.sourceJobId === null && row.sourceVisitId === null)
		return "Pick which job or visit this credits";
	return null;
};

/** The backend rejects a zero quantity, a zero line total and an empty line
 *  list; a zero net would write a document that changes nothing. */
export const adjustmentInvalid = (
	rows: AdjustmentDraft[],
	requireAttribution = false
): boolean =>
	rows.length === 0 ||
	netAdjustment(rows) === 0 ||
	rows.some((row) => draftRowError(row, requireAttribution) !== null);

/** The wire shape. Quantity carries the sign (negative for a credit); unit
 *  price stays positive — so two rows meaning the same credit cannot print
 *  differently on the client's document. `total` (draftTotal) carries the
 *  same sign, computed the same way, so the two never disagree. */
export const toAdjustmentLineInputs = (rows: AdjustmentDraft[]): AdjustmentLineInput[] =>
	rows.map((row) => {
		const quantity = magnitude(row.quantity);
		return {
			name: row.name.trim(),
			quantity: row.kind === "credit" ? -quantity : quantity,
			unit_price: magnitude(row.unitPrice),
			total: draftTotal(row),
			source_job_id: row.sourceJobId,
			source_visit_id: row.sourceVisitId,
			tax_group_id: row.taxGroupId,
			inventory_item_id: row.inventoryItemId,
			taxable: row.taxable,
		};
	});
