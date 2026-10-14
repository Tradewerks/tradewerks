/**
 * A document's place in its revision chain, resolved server-side.
 *
 * Its own file rather than quotes.ts or invoices.ts: both documents carry it and
 * the shared lineage band reads it, so neither domain owns it. Mirrors
 * backend/src/lib/documentLineage.ts exactly.
 */
export interface LineageNode {
	id: string;
	number: string;
	version: number;
	status: string;
}

export interface DocumentLineage {
	self_id: string;
	self_version: number;
	/** The tail's version — the denominator, correct even across a deleted head. */
	latest_version: number;
	chain: LineageNode[];
	/** Earlier versions existed and were deleted; the band says so and links nothing. */
	truncated_before: boolean;
	successor: LineageNode | null;
	/** The tail. Equals the viewed document when it is the tail. */
	final: LineageNode;
	final_is_live: boolean;
	adjusts: LineageNode | null;
	adjustments: LineageNode[];
}
