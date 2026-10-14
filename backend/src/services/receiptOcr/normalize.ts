/**
 * The parsing contract every provider maps onto, and the helpers they share.
 */

export interface OcrFile {
	buffer: Buffer;
	mimetype: string;
	filename: string;
}

export interface ExtractedLine {
	description: string;
	quantity: number;
	unit_price: number;
	line_total: number;
	confidence: number | null;
}

export interface ReceiptExtraction {
	vendor_name: string | null;
	/** The vendor's own number for this ticket - the strongest reuse key a receipt carries. */
	receipt_number: string | null;
	/** The strongest reuse key for a supplier match: formatting varies, the digits don't. */
	vendor_phone: string | null;
	purchased_at: Date | null;
	subtotal: number | null;
	tax_amount: number | null;
	total: number | null;
	/** What the provider thinks it read. A statement or an invoice is not a purchase. */
	document_type: string | null;
	/** ISO code off the receipt. A foreign-currency total read as dollars is a mis-reimbursement. */
	currency: string | null;
	lines: ExtractedLine[];
	/** `{ field: 0..1 }` for the header fields the provider reported on. */
	field_confidence: Record<string, number>;
	raw: unknown;
}

export interface ReceiptOcrProvider {
	readonly name: string;
	extract(file: OcrFile): Promise<ReceiptExtraction>;
}

/** Below this, the technician's UI marks a field for attention. */
export const OCR_LOW_CONFIDENCE = 0.75;

/** A tech is waiting on the result, and a stalled vendor call is worse than none. */
export const OCR_TIMEOUT_MS = 20_000;

/**
 * The upload route (`receiptUpload`) already refuses anything over 5 MB before
 * `runReceiptOcr` ever sees it, and the client compresses well under that - so this
 * constant does no work there. It exists for `startOcrRead`, which replays the stored
 * image straight out of object storage with no multer in front of it; kept well under
 * Mindee's own 100 MB ceiling.
 */
export const OCR_MAX_BYTES = 15 * 1024 * 1024;

/** decimal(10,2) with room to spare: a parse this large is a misread, not a receipt. */
const MAX_MONEY = 9_999_999.99;

/** Number(null) and Number("") are both 0, which would read a missing field as free. */
function toNumber(v: unknown): number | null {
	if (v === null || v === undefined || typeof v === "boolean") return null;
	const text = typeof v === "string" ? v.replace(/[^0-9.-]/g, "") : v;
	if (text === "") return null;
	const n = Number(text);
	return Number.isFinite(n) ? n : null;
}

export function toMoney(v: unknown): number | null {
	const n = toNumber(v);
	if (n === null || n < 0 || n > MAX_MONEY) return null;
	return Math.round(n * 100) / 100;
}

/**
 * Line money, which a receipt genuinely prints below zero: a contractor discount,
 * a coupon, a returned item on the same ticket. Header money keeps `toMoney` — a
 * negative receipt total is a misread, and a credit is its own purchase kind.
 */
export function toSignedMoney(v: unknown): number | null {
	const n = toNumber(v);
	if (n === null || Math.abs(n) > MAX_MONEY) return null;
	return Math.round(n * 100) / 100;
}

export function toConfidence(v: unknown): number | null {
	const n = toNumber(v);
	if (n === null) return null;
	return Math.min(1, Math.max(0, Math.round(n * 1000) / 1000));
}

export function toDate(v: unknown): Date | null {
	if (typeof v !== "string" || v.trim() === "") return null;
	// Providers return "YYYY-MM-DD" or "YYYY-MM-DD HH:mm:ss", neither carrying a
	// zone. Both are read as UTC so the two shapes agree with each other; reading
	// the second as server-local would shift a receipt by the host's offset and
	// disagree with the first.
	const t = v.trim();
	const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(t);
	const iso = t.includes("T") ? t : t.replace(" ", "T");
	const d = new Date(hasZone ? iso : `${iso.includes("T") ? iso : `${iso}T00:00:00`}Z`);
	return Number.isNaN(d.getTime()) ? null : d;
}

export function toText(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	const trimmed = v.trim();
	return trimmed === "" ? null : trimmed.slice(0, max);
}

/**
 * Quantity and line total are the two fields receipts most often omit, so both
 * are derived rather than dropped: a line with a price and no quantity is one
 * unit, and a line with no total is quantity times price.
 */
export function normalizeLine(input: {
	description: unknown;
	quantity: unknown;
	unit_price: unknown;
	line_total: unknown;
	confidence: unknown;
}): ExtractedLine | null {
	const description = toText(input.description, 200);
	if (!description) return null;

	// Quantity stays unsigned: minus two of something is a misread, not a discount.
	const qty = toMoney(input.quantity);
	const quantity = qty && qty > 0 ? qty : 1;
	const total = toSignedMoney(input.line_total);
	const price = toSignedMoney(input.unit_price);

	const unit_price = price ?? (total != null ? Math.round((total / quantity) * 100) / 100 : 0);
	const line_total = total ?? Math.round(unit_price * quantity * 100) / 100;
	if (Math.abs(line_total) > MAX_MONEY) return null;

	return {
		description,
		quantity,
		unit_price,
		line_total,
		confidence: toConfidence(input.confidence),
	};
}
