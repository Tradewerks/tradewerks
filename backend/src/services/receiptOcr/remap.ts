import { mapFixture } from "./fixture.js";
import { mapMindee } from "./mindee.js";
import type { ReceiptExtraction } from "./normalize.js";

/**
 * The header as the receipt read, recovered from the stored provider payload.
 *
 * The header columns hold what the TECHNICIAN decided — extraction never
 * overwrites a value they entered — so they are not where the receipt's own
 * reading survives. `ocr_raw` is kept as evidence anyway, and the adapters'
 * mapping is pure, so replaying it is deterministic and costs no network.
 *
 * Its own module rather than `index.ts` so a caller can reach it without pulling
 * in provider selection, which reads the environment.
 */
/**
 * Null-prototype: `provider` is a plain string column, and a bare object literal
 * answers to every Object.prototype key - `"toString"` would resolve to a function
 * and yield a header of undefineds instead of the honest null.
 */
const MAPPERS: Record<string, (raw: unknown) => ReceiptExtraction> = Object.assign(
	Object.create(null) as Record<string, (raw: unknown) => ReceiptExtraction>,
	{ fixture: mapFixture, mindee: mapMindee },
);

export interface ExtractedHeader {
	vendor_name: string | null;
	purchased_at: Date | null;
	subtotal: number | null;
	tax_amount: number | null;
	total: number | null;
}

/** Null rather than a guess: a payload from a provider we cannot map says nothing. */
export function remapHeader(provider: string | null, raw: unknown): ExtractedHeader | null {
	const map = provider ? MAPPERS[provider] : undefined;
	if (!map || raw == null) return null;
	try {
		const { vendor_name, purchased_at, subtotal, tax_amount, total } = map(raw);
		return { vendor_name, purchased_at, subtotal, tax_amount, total };
	} catch {
		// Evidence that no longer parses is not worth failing a page read over.
		return null;
	}
}
