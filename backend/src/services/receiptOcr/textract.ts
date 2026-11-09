import {
	AnalyzeExpenseCommand,
	TextractClient,
} from "@aws-sdk/client-textract";
import {
	OCR_TIMEOUT_MS,
	OcrProviderError,
	normalizeLine,
	readSources,
	toConfidence,
	toDate,
	toMoney,
	toSignedMoney,
	toText,
	type ExtractedLine,
	type OcrFailureKind,
	type OcrFile,
	type ReceiptExtraction,
} from "./normalize.js";
import { Slots } from "./slots.js";
import { normalizeVendor, vendorsNear } from "../../lib/fieldPurchase.js";
import { log } from "../appLogger.js";

/**
 * AWS Textract `AnalyzeExpense`, synchronous. Verified against live calls (Nov 2026
 * eval sets). It returns values as
 * printed - "10/14/26", "$12.34" - with 0..100 confidence, and it names fields by a
 * fixed type vocabulary rather than a schema, so a type can repeat and the mapping
 * picks among them.
 */

export interface TextractReceiptConfig {
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}

let cached: { key: string; client: TextractClient } | null = null;

/** One client per credential set, so a rotated key is picked up on the next receipt. */
export function clientFor(cfg: TextractReceiptConfig): TextractClient {
	const key = `${cfg.region}|${cfg.accessKeyId}|${cfg.secretAccessKey}`;
	if (cached?.key !== key) {
		cached = {
			key,
			client: new TextractClient({
				region: cfg.region,
				credentials: {
					accessKeyId: cfg.accessKeyId,
					secretAccessKey: cfg.secretAccessKey,
				},
				// Adaptive backs off client-side once AWS starts throttling. The
				// caller's abort signal bounds every attempt together, so extra
				// attempts never stretch a read past OCR_TIMEOUT_MS.
				retryMode: "adaptive",
				maxAttempts: 3,
			}),
		};
	}
	return cached.client;
}

/**
 * Textract reads JPEG, PNG, TIFF and PDF only. The capture flow re-encodes to JPEG
 * whatever the upload is tagged, so the bytes are checked rather than the mimetype:
 * an iOS "image/heic" upload is usually a JPEG, and a real WebP is not.
 */
function isWebp(buffer: Buffer): boolean {
	return (
		buffer.length >= 12 &&
		buffer.toString("ascii", 0, 4) === "RIFF" &&
		buffer.toString("ascii", 8, 12) === "WEBP"
	);
}

/**
 * Reaches the technician verbatim through `ocr_error`, so AWS's own wording stays in
 * the server log: an access-denied message names the account id and IAM user.
 */
export function describeFailure(err: unknown): {
	message: string;
	kind: OcrFailureKind;
} {
	const name = (err as { name?: unknown })?.name;
	const message = (err as { message?: unknown })?.message;
	log.warn({ provider: "textract", name, message }, "Textract call failed");
	switch (name) {
		case "TimeoutError":
		case "AbortError":
			return {
				message: "Textract did not answer in time - enter the receipt by hand",
				kind: "timeout",
			};
		case "AccessDeniedException":
		case "UnrecognizedClientException":
		case "InvalidSignatureException":
			return {
				message:
					"Receipt reading isn't set up correctly - enter the receipt by hand",
				kind: "final",
			};
		case "ThrottlingException":
		case "ProvisionedThroughputExceededException":
		case "LimitExceededException":
			return {
				message: "Textract is rate limiting - retry the receipt shortly",
				kind: "throttled",
			};
		case "DocumentTooLargeException":
			return {
				message:
					"The receipt image is too large for Textract - enter the receipt by hand",
				kind: "final",
			};
		case "UnsupportedDocumentException":
		case "BadDocumentException":
		case "InvalidParameterException":
			return {
				message: "Textract would not accept this receipt - enter it by hand",
				kind: "final",
			};
	}
	return {
		message: "Textract could not read this receipt - enter it by hand",
		kind: isTransient(err) ? "unavailable" : "final",
	};
}

const NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"EPIPE",
]);

/** AWS's side (5xx) or the wire, not the receipt. */
function isTransient(err: unknown): boolean {
	const e = err as {
		$fault?: unknown;
		$metadata?: { httpStatusCode?: unknown };
		code?: unknown;
	};
	const status = e?.$metadata?.httpStatusCode;
	if (e?.$fault === "server") return true;
	if (typeof status === "number" && status >= 500) return true;
	return typeof e?.code === "string" && NETWORK_CODES.has(e.code);
}

/**
 * Past the account's AnalyzeExpense TPS quota AWS throttles, so excess reads queue
 * here instead. Default 2 until the real prod quota is known.
 */
function maxConcurrency(): number {
	const n = Number(process.env.TEXTRACT_MAX_CONCURRENCY);
	return Number.isInteger(n) && n > 0 ? n : 2;
}

// Long enough for a burst of ~10 uploads to drain at ~4s a read, short enough that a
// queued read finishes well inside OCR_STALE_MS.
const SLOT_WAIT_MS = 60_000;
export const textractSlots = new Slots(maxConcurrency());

export async function extractWithTextract(
	file: OcrFile,
	cfg: TextractReceiptConfig,
): Promise<ReceiptExtraction> {
	if (isWebp(file.buffer)) {
		throw new OcrProviderError(
			"Textract cannot read WebP images - enter the receipt by hand",
			"final",
		);
	}
	textractSlots.max = maxConcurrency();
	if (!(await textractSlots.acquire(SLOT_WAIT_MS))) {
		throw new OcrProviderError(
			"Receipt reading is busy - it will be retried shortly",
			"throttled",
		);
	}
	let res: unknown;
	try {
		// Created after the slot is held: queueing is not the provider being slow.
		res = await clientFor(cfg).send(
			new AnalyzeExpenseCommand({ Document: { Bytes: file.buffer } }),
			{ abortSignal: AbortSignal.timeout(OCR_TIMEOUT_MS) },
		);
	} catch (err) {
		const failure = describeFailure(err);
		throw new OcrProviderError(failure.message, failure.kind);
	} finally {
		textractSlots.release();
	}
	return mapTextract(retainable(res));
}

type Box = { Left: number; Top: number; Width: number; Height: number };

interface TextractDetection {
	Text?: unknown;
	Confidence?: unknown;
	Geometry?: { BoundingBox?: Box };
}

interface TextractField {
	Type?: { Text?: unknown; Confidence?: unknown };
	LabelDetection?: TextractDetection;
	ValueDetection?: TextractDetection;
	Currency?: { Code?: unknown; Confidence?: unknown };
	GroupProperties?: { Types?: unknown; Id?: unknown }[];
	PageNumber?: unknown;
	/** Share (0..1) of the value's words Textract tagged HANDWRITING; absent on payloads stored before it. */
	Handwritten?: number | null;
}

interface TextractLineItem {
	LineItemExpenseFields?: TextractField[];
}

/**
 * What `deriveTextHints` pulled out of the printed text. The text itself is not
 * stored - it carries the tender lines - so these two values are kept in its place.
 */
interface TextHints {
	vendor: string | null;
	receipt_number: string | null;
	/** Name of the chain rule that produced the hints. Payloads stored before it existed lack it. */
	chain?: string | null;
	/** A non-receipt the printed text announces; payloads stored before it existed lack it. */
	document_kind?: DocumentKind | null;
}

type DocumentKind =
	"statement" | "invoice" | "estimate" | "quote" | "credit_memo";

interface TextractBlock {
	Id?: string;
	BlockType?: unknown;
	Text?: unknown;
	TextType?: unknown;
	Page?: unknown;
	Geometry?: { BoundingBox?: Box };
	Relationships?: { Type?: string; Ids?: string[] }[];
}

interface TextractDocument {
	ExpenseIndex?: unknown;
	SummaryFields?: TextractField[];
	LineItemGroups?: {
		LineItemGroupIndex?: unknown;
		LineItems?: TextractLineItem[];
	}[];
	Blocks?: TextractBlock[];
	TextHints?: TextHints;
}

/**
 * Kept by allowlist. `OTHER` is Textract's catch-all for every label/value pair it
 * found but could not name, which on a receipt includes the tender line - the
 * masked card number and approval code. `Blocks` is the full printed text. Neither
 * is read.
 */
const SUMMARY_TYPES = new Set([
	"VENDOR_NAME",
	"NAME",
	"VENDOR_PHONE",
	"INVOICE_RECEIPT_ID",
	"INVOICE_RECEIPT_DATE",
	"SUBTOTAL",
	"TAX",
	"TOTAL",
	"AMOUNT_PAID",
]);

/** `EXPENSE_ROW` is the whole printed row - a mis-grouped tender line would land there. */
const LINE_TYPES = new Set([
	"ITEM",
	"QUANTITY",
	"PRICE",
	"UNIT_PRICE",
	"PRODUCT_CODE",
]);

const typeOf = (f: TextractField): string =>
	typeof f.Type?.Text === "string" ? f.Type.Text : "";

const MAX_RETAINED_TEXT = 200;

const groupTypes = (f: TextractField): unknown[] =>
	(Array.isArray(f.GroupProperties) ? f.GroupProperties : []).flatMap((g) =>
		Array.isArray(g.Types) ? g.Types : [],
	);

/** Luhn, so a long ticket number is not mistaken for a card and lost from the read. */
function luhn(digits: string): boolean {
	let sum = 0;
	for (let i = 0; i < digits.length; i++) {
		let d = Number(digits[digits.length - 1 - i]);
		if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
		sum += d;
	}
	return sum % 10 === 0;
}

const MASKED_CARD = /[X*]{4,}\s?\d{4}/i;

/** A tender line Textract mis-typed as an item or an id would carry the card with it. */
function looksLikeCard(text: unknown): boolean {
	if (typeof text !== "string") return false;
	if (MASKED_CARD.test(text)) return true;
	return (text.match(/\b\d{13,19}\b/g) ?? []).some(luhn);
}

/**
 * Only `VENDOR` names: the others are the bill-to and ship-to customer. A label is
 * kept only where `receiptLabelRank` reads it.
 */
function retainField(f: TextractField): boolean {
	if (typeOf(f) === "NAME" && !groupTypes(f).includes("VENDOR")) return false;
	return (
		!looksLikeCard(f.ValueDetection?.Text) &&
		!looksLikeCard(f.LabelDetection?.Text)
	);
}

/**
 * Every wrong handwritten money/date value in the Nov 6 eval had a share of 0.5 or
 * more; a printed receipt with pen notes on it scored 0 on every field.
 */
const HANDWRITTEN_AT = 0.5;

const isHandwritten = (f: TextractField | undefined): boolean =>
	(f?.Handwritten ?? 0) >= HANDWRITTEN_AT;

function boxOf(g: { BoundingBox?: Box } | undefined): Box | null {
	const b = g?.BoundingBox;
	if (
		!b ||
		![b.Left, b.Top, b.Width, b.Height].every((n) => typeof n === "number")
	)
		return null;
	return b;
}

/** Fraction of `inner`'s area that lies inside `outer`. */
function insideShare(inner: Box, outer: Box): number {
	const w =
		Math.min(inner.Left + inner.Width, outer.Left + outer.Width) -
		Math.max(inner.Left, outer.Left);
	const h =
		Math.min(inner.Top + inner.Height, outer.Top + outer.Height) -
		Math.max(inner.Top, outer.Top);
	const area = inner.Width * inner.Height;
	return w > 0 && h > 0 && area > 0 ? (w * h) / area : 0;
}

const pageOf = (p: unknown): unknown => p ?? 1;

/**
 * Share of the words inside a value box that Textract tagged HANDWRITING. Computed at
 * retain time because Blocks and Geometry are dropped before storage. Null when the
 * value has no box or no word sits in it - treated as printed.
 */
export function handwrittenShare(
	value: TextractDetection | undefined,
	page: unknown,
	blocks: TextractBlock[],
): number | null {
	const outer = boxOf(value?.Geometry);
	if (!outer) return null;
	let words = 0;
	let pen = 0;
	for (const b of blocks) {
		if (b.BlockType !== "WORD" || pageOf(b.Page) !== pageOf(page)) continue;
		const inner = boxOf(b.Geometry);
		if (!inner || insideShare(inner, outer) < 0.5) continue;
		words++;
		if (b.TextType === "HANDWRITING") pen++;
	}
	return words > 0 ? Math.round((pen / words) * 100) / 100 : null;
}

/** Geometry is layout, not evidence of what was read. */
function keepField(f: TextractField, blocks: TextractBlock[]): TextractField {
	const detection = (d: TextractDetection | undefined) =>
		d
			? {
					Text:
						typeof d.Text === "string"
							? d.Text.slice(0, MAX_RETAINED_TEXT)
							: d.Text,
					Confidence: d.Confidence,
				}
			: undefined;
	return {
		Type: f.Type,
		LabelDetection:
			typeOf(f) === "INVOICE_RECEIPT_ID"
				? detection(f.LabelDetection)
				: undefined,
		ValueDetection: detection(f.ValueDetection),
		Currency: f.Currency,
		GroupProperties: f.GroupProperties,
		PageNumber: f.PageNumber,
		// A stored payload has no Blocks left; its share must survive a second retain.
		Handwritten:
			handwrittenShare(f.ValueDetection, f.PageNumber, blocks) ??
			f.Handwritten ??
			undefined,
	};
}

/** What lands in `ocr_raw`. */
export function retainable(raw: unknown): unknown {
	const r = raw as { DocumentMetadata?: unknown; ExpenseDocuments?: unknown };
	const docs = Array.isArray(r?.ExpenseDocuments)
		? (r.ExpenseDocuments as TextractDocument[])
		: [];
	return {
		DocumentMetadata: r?.DocumentMetadata,
		ExpenseDocuments: docs.map((d) => {
			const blocks = Array.isArray(d.Blocks) ? d.Blocks : [];
			const keep = (f: TextractField) => keepField(f, blocks);
			return {
				ExpenseIndex: d.ExpenseIndex,
				TextHints: textHintsOf(d),
				SummaryFields: (d.SummaryFields ?? [])
					.filter(
						(f) => SUMMARY_TYPES.has(typeOf(f)) && retainField(f),
					)
					.map(keep),
				LineItemGroups: (d.LineItemGroups ?? []).map((g) => ({
					LineItemGroupIndex: g.LineItemGroupIndex,
					LineItems: (g.LineItems ?? []).map((item) => ({
						LineItemExpenseFields: (
							item.LineItemExpenseFields ?? []
						)
							.filter(
								(f) =>
									LINE_TYPES.has(typeOf(f)) && retainField(f),
							)
							.map(keep),
					})),
				})),
			};
		}),
	};
}

const valueOf = (f: TextractField | undefined): unknown =>
	f?.ValueDetection?.Text;
const confidenceOf = (f: TextractField | undefined): number | null =>
	typeof f?.ValueDetection?.Confidence === "number"
		? toConfidence(f.ValueDetection.Confidence / 100)
		: null;

/**
 * A type can repeat - "TOTAL" on the total line and again on a card slip stapled
 * below. The most confident reading with a value wins.
 */
function best(
	fields: TextractField[],
	type: string,
	inGroup?: string,
): TextractField | undefined {
	let pick: TextractField | undefined;
	for (const f of fields) {
		if (typeOf(f) !== type || toText(valueOf(f), 200) === null) continue;
		if (inGroup) {
			const groups = Array.isArray(f.GroupProperties)
				? f.GroupProperties
				: [];
			const tagged = groups.some(
				(g) => Array.isArray(g.Types) && g.Types.includes(inGroup),
			);
			if (!tagged) continue;
		}
		if (!pick || (confidenceOf(f) ?? 0) > (confidenceOf(pick) ?? 0))
			pick = f;
	}
	return pick;
}

const MONTHS: Record<string, number> = {
	jan: 1,
	feb: 2,
	mar: 3,
	apr: 4,
	may: 5,
	jun: 6,
	jul: 7,
	aug: 8,
	sep: 9,
	oct: 10,
	nov: 11,
	dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

function fullYear(y: number): number {
	return y < 100 ? 2000 + y : y;
}

/**
 * Textract returns the date as printed. US receipts print month first, so
 * "03/04/26" is March 4th; a day-first reading is only taken when the first
 * number cannot be a month. Any time on the same line is kept.
 * Exported for the tests.
 */
export function parsePrintedDate(text: unknown): string | null {
	if (typeof text !== "string") return null;
	const t = text.trim();
	let y: number | null = null;
	let m: number | null = null;
	let d: number | null = null;

	let hit = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
	if (hit) {
		[y, m, d] = [Number(hit[1]), Number(hit[2]), Number(hit[3])];
	} else if ((hit = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t))) {
		const [a, b] = [Number(hit[1]), Number(hit[2])];
		y = fullYear(Number(hit[3]));
		[m, d] = a > 12 && b <= 12 ? [b, a] : [a, b];
	} else if (
		(hit = /([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{2,4})/.exec(t))
	) {
		m = MONTHS[hit[1].toLowerCase()] ?? null;
		[d, y] = [Number(hit[2]), fullYear(Number(hit[3]))];
	} else if (
		(hit = /(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{2,4})/.exec(t))
	) {
		m = MONTHS[hit[2].toLowerCase()] ?? null;
		[d, y] = [Number(hit[1]), fullYear(Number(hit[3]))];
	}
	if (!y || !m || !d || m > 12 || d > 31) return null;
	const day = `${y}-${pad(m)}-${pad(d)}`;

	const clock = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?/.exec(
		t.slice((hit?.index ?? 0) + (hit?.[0].length ?? 0)),
	);
	if (!clock) return day;
	let hour = Number(clock[1]);
	const ampm = clock[4]?.toLowerCase();
	if (ampm === "p" && hour < 12) hour += 12;
	if (ampm === "a" && hour === 12) hour = 0;
	if (hour > 23) return day;
	return `${day} ${pad(hour)}:${clock[2]}:${clock[3] ?? "00"}`;
}

/**
 * Money as printed. Thermal heads drop the decimal point or print a comma for it
 * ("1 49", "5,99 P"), and a credit prints its minus after the amount, followed by a
 * tax-flag letter ("0.30-F"). Exported for the tests.
 */
export function parsePrintedMoney(text: unknown): number | null {
	if (typeof text !== "string") return toSignedMoney(text);
	const t = text.trim().replace(/\s*[A-Za-z]{1,2}$/, "");
	const negative = /^-|-$|^\(.*\)$/.test(t);
	const core = t.replace(/[^\d.,\s]/g, "").trim();
	let n: number | null = null;
	if (
		/^\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?$/.test(core) ||
		/^\d*\.\d{1,2}$/.test(core)
	) {
		n = Number(core.replace(/[,\s]/g, ""));
	} else if (/^\d+[,\s]\d{2}$/.test(core)) {
		n = Number(core.replace(/[,\s]/, "."));
	} else {
		n = toSignedMoney(core.replace(/[,\s]/g, ""));
	}
	if (n === null || !Number.isFinite(n)) return null;
	return toSignedMoney(negative ? -n : n);
}

const headerMoney = (f: TextractField | undefined) =>
	toMoney(parsePrintedMoney(valueOf(f)));

/**
 * Chains whose header is a logo Textract cannot read. Matched against the printed
 * text - footers and email addresses name them in plain type.
 */
const CHAINS: { pattern: RegExp; name: string; receiptLine?: RegExp }[] = [
	{
		// The tagline prints in plain type beside the logo; the name often does not.
		pattern: /\bhome\s*depot\b|homedepot\.com|\bhow doers\b/i,
		name: "The Home Depot",
		// "STORE REGISTER TRANS date": 6977 00002 70991 09/18/20. The store is constant.
		receiptLine:
			/^\s*\d{4}\s+\d{5}\s+(\d{5})(?:\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*)?$/,
	},
	{ pattern: /\blowe'?s\b|lowes\.com/i, name: "Lowe's" },
	{
		// The logo reads as "Reilly" / "AUTO PARTS" / "PRO SSIONAL PARTS PEOPLE"; the URL is plain type.
		pattern:
			/oreillyauto\.com|\bO['\u2019]?\s?REILLY\b|\bREILLY\b[\s\S]{0,40}\bAUTO PARTS\b|\bAUTO PARTS\b[\s\S]{0,40}\bREILLY\b/i,
		name: "O'Reilly Auto Parts",
	},
];

const KIND_HEADER =
	/^(STATEMENT|INVOICE|ESTIMATE|QUOTE|QUOTATION|PRO ?FORMA|CREDIT MEMO|CREDIT NOTE)( OF ACCOUNT)?$/i;
/** "Invoice #: 2985-Quote" is only a number; a quote prints a banner and a "Quote Total". */
const QUOTE_BANNER = /\bQUOTE ONLY\b|^QUOTE TOTAL\b/i;
const KIND_OF: Record<string, DocumentKind> = {
	STATEMENT: "statement",
	INVOICE: "invoice",
	PROFORMA: "invoice",
	ESTIMATE: "estimate",
	QUOTE: "quote",
	QUOTATION: "quote",
	CREDITMEMO: "credit_memo",
	CREDITNOTE: "credit_memo",
};

/**
 * Only a header that is the whole line counts: receipts print "INVOICE # 123" and
 * "INVOICE NO" as labels, and Lowe's prints INVOICE on a sale.
 */
function detectDocumentKind(lines: string[]): DocumentKind | null {
	for (const line of lines.slice(0, 12)) {
		const hit = KIND_HEADER.exec(line.trim());
		if (hit)
			return KIND_OF[hit[1]!.replace(/\s/g, "").toUpperCase()] ?? null;
	}
	if (lines.some((l) => QUOTE_BANNER.test(l.trim()))) return "quote";
	const paid = lines.some((l) => /\b(TOTAL|CHANGE|TENDER)\b/i.test(l));
	if (!paid && lines.some((l) => /\bBALANCE DUE\b/i.test(l)))
		return "statement";
	return null;
}

function deriveTextHints(lines: string[]): TextHints {
	const text = lines.join("\n");
	const chain = CHAINS.find((c) => c.pattern.test(text));
	let receipt_number: string | null = null;
	if (chain?.receiptLine) {
		for (const line of lines) {
			const hit = chain.receiptLine.exec(line);
			if (hit) {
				receipt_number = hit[1]!;
				break;
			}
		}
	}
	return {
		vendor: chain?.name ?? null,
		receipt_number,
		chain: chain?.name ?? null,
		document_kind: detectDocumentKind(lines),
	};
}

/** Stored hints win; a fresh response derives them from its printed text. */
function textHintsOf(doc: TextractDocument): TextHints | undefined {
	if (doc.TextHints) return doc.TextHints;
	if (!Array.isArray(doc.Blocks)) return undefined;
	return deriveTextHints(printedLines(doc.Blocks));
}

/**
 * LINE texts in order, minus pen-written ones: a note like "drove to Home Depot"
 * must not name the chain or the document kind. A LINE whose words cannot be
 * resolved counts as printed.
 */
export function printedLines(blocks: TextractBlock[]): string[] {
	const words = new Map<string, TextractBlock>();
	for (const b of blocks)
		if (b.BlockType === "WORD" && b.Id) words.set(b.Id, b);
	const out: string[] = [];
	for (const b of blocks) {
		if (b.BlockType !== "LINE" || typeof b.Text !== "string") continue;
		const children = (b.Relationships ?? [])
			.filter((r) => r.Type === "CHILD")
			.flatMap((r) => r.Ids ?? [])
			.map((id) => words.get(id))
			.filter((w): w is TextractBlock => w !== undefined);
		const pen = children.filter((w) => w.TextType === "HANDWRITING").length;
		if (children.length === 0 || pen / children.length < HANDWRITTEN_AT)
			out.push(b.Text);
	}
	return out;
}

/**
 * "TR# 01771" over "ID #: 7N8BRK6F3HG": Textract tags every ticket-ish number
 * INVOICE_RECEIPT_ID, and its confidence is about the reading, not the label.
 */
const RECEIPT_LABEL_GOOD =
	/\b(?:TR|TRANS|TRANSACTION|RECEIPT|RCPT|INVOICE|INV|TICKET|TKT)\b/i;
const RECEIPT_LABEL_BAD =
	/\b(?:ID|REF|AUTH|APPR|APPROVAL|AID|TC|TERMINAL|CASHIER|REG|STORE)\b/i;

function receiptLabelRank(f: TextractField): number {
	const label =
		typeof f.LabelDetection?.Text === "string" ? f.LabelDetection.Text : "";
	if (RECEIPT_LABEL_GOOD.test(label)) return 2;
	if (RECEIPT_LABEL_BAD.test(label)) return 0;
	return 1;
}

function bestReceiptId(fields: TextractField[]): TextractField | undefined {
	let pick: TextractField | undefined;
	for (const f of fields) {
		if (
			typeOf(f) !== "INVOICE_RECEIPT_ID" ||
			toText(valueOf(f), 200) === null
		)
			continue;
		if (!pick) {
			pick = f;
			continue;
		}
		const [a, b] = [receiptLabelRank(f), receiptLabelRank(pick)];
		if (
			a > b ||
			(a === b && (confidenceOf(f) ?? 0) > (confidenceOf(pick) ?? 0))
		)
			pick = f;
	}
	return pick;
}

/**
 * The vendor block often carries the slogan or the street address with it:
 * "FredMeyer\nH\nWhat's on your list today?". Keep the lines that name the store,
 * joined onto one line: the column feeds single-line inputs, which drop a newline.
 */
export function cleanVendor(text: string | null): string | null {
	if (!text) return null;
	const kept = text
		.split("\n")
		.map((l) => l.trim())
		.filter(
			(l) =>
				l.replace(/[^A-Za-z0-9]/g, "").length > 1 &&
				!/[?!]/.test(l) &&
				!/www\.|\.com\b|@/i.test(l) &&
				!/,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?$/.test(l) &&
				!/^\d+\s+\S+/.test(l),
		);
	const lines = kept.length > 0 ? kept : text.split("\n").map((l) => l.trim());
	return lines.filter(Boolean).join(" ");
}

/**
 * Prefer the total that equals subtotal + tax - the "PRO XTRA SPEND $38,987" line
 * below a Home Depot ticket is tagged TOTAL too.
 */
function pickTotal(
	fields: TextractField[],
	subtotal: number | null,
	tax: number | null,
): {
	amount: number | null;
	confidence: number | null;
	derived: boolean;
	field: TextractField | undefined;
} {
	const expected =
		subtotal != null && tax != null
			? Math.round((subtotal + tax) * 100) / 100
			: null;
	for (const type of ["TOTAL", "AMOUNT_PAID"]) {
		const candidates = fields.filter(
			(f) => typeOf(f) === type && headerMoney(f) != null,
		);
		if (expected != null) {
			const match = candidates.find((f) => headerMoney(f) === expected);
			if (match)
				return {
					amount: expected,
					confidence: confidenceOf(match),
					derived: false,
					field: match,
				};
		}
	}
	const fallback = best(fields, "TOTAL") ?? best(fields, "AMOUNT_PAID");
	const amount = headerMoney(fallback);
	if (amount != null)
		return {
			amount,
			confidence: confidenceOf(fallback),
			derived: false,
			field: fallback,
		};
	// Nothing printed as a total read cleanly; the sum is right but unread, so flag it.
	if (expected != null)
		return {
			amount: expected,
			confidence: 0.5,
			derived: true,
			field: undefined,
		};
	return { amount: null, confidence: null, derived: false, field: undefined };
}

/**
 * A printed vendor beats a handwritten one at any confidence - a receipt-book form
 * carries the customer's name in pen. VENDOR_NAME still beats the vendor-group NAME.
 */
function pickVendor(fields: TextractField[]): TextractField | undefined {
	const printed = fields.filter((f) => !isHandwritten(f));
	const pen = fields.filter(isHandwritten);
	return (
		best(printed, "VENDOR_NAME") ??
		best(printed, "NAME", "VENDOR") ??
		best(pen, "VENDOR_NAME") ??
		best(pen, "NAME", "VENDOR")
	);
}

/** Exported for the tests. Pure, so `remapHeader` can replay a stored `ocr_raw`. */
export function mapTextract(raw: unknown): ReceiptExtraction {
	const docs = (raw as { ExpenseDocuments?: unknown })?.ExpenseDocuments;
	const doc: TextractDocument =
		Array.isArray(docs) && docs[0] ? (docs[0] as TextractDocument) : {};
	const fields = doc.SummaryFields ?? [];
	const hints = textHintsOf(doc);

	const vendor = pickVendor(fields);
	const receiptNo = bestReceiptId(fields);
	const phone = best(fields, "VENDOR_PHONE");
	const date = best(fields, "INVOICE_RECEIPT_DATE");
	const subtotal = best(fields, "SUBTOTAL");
	const tax = best(fields, "TAX");
	const subtotalAmount = headerMoney(subtotal);
	const taxAmount = headerMoney(tax);
	const total = pickTotal(fields, subtotalAmount, taxAmount);

	const field_confidence: Record<string, number> = {};
	const score = (key: string, f: TextractField | undefined) => {
		const c = confidenceOf(f);
		if (c != null) field_confidence[key] = c;
	};
	const vendorRead = cleanVendor(toText(valueOf(vendor), 120));
	// A chain named only in the footer: right, but not read where a vendor prints.
	// A logo read as a slogan ("PRO SSIONAL PARTS PEOPLE") is confident and wrong; the chain wins.
	const chainWins =
		!!hints?.chain &&
		!!vendorRead &&
		!vendorsNear(normalizeVendor(vendorRead), normalizeVendor(hints.chain));
	const useHint = !vendorRead || chainWins;
	const vendorName = useHint
		? (hints?.vendor ?? vendorRead ?? null)
		: vendorRead;
	if (!useHint) score("vendor_name", vendor);
	else if (vendorName) field_confidence.vendor_name = 0.6;
	// A chain's fixed header layout beats Textract's guess at which number is the ticket.
	const receiptNumber =
		hints?.receipt_number ?? toText(valueOf(receiptNo), 64);
	if (hints?.receipt_number) field_confidence.receipt_number = 0.8;
	else score("receipt_number", receiptNo);
	score("purchased_at", date);
	score("subtotal", subtotal);
	score("tax_amount", tax);
	if (total.confidence != null) field_confidence.total = total.confidence;

	const ruleName = hints?.chain ?? hints?.vendor ?? null;
	const purchasedAt = toDate(parsePrintedDate(valueOf(date)));
	const field_source: ReceiptExtraction["field_source"] = readSources({
		vendor_name: vendorName,
		receipt_number: receiptNumber,
		purchased_at: purchasedAt,
		subtotal: subtotalAmount,
		tax_amount: taxAmount,
		total: total.amount,
	});
	const byRule = { source: "rule", rule: ruleName ?? undefined } as const;
	if (vendorName && useHint && vendorName === hints?.vendor)
		field_source.vendor_name = byRule;
	if (hints?.receipt_number) field_source.receipt_number = byRule;
	if (total.derived) field_source.total = { source: "derived" };

	// pickTotal already preferred a total matching subtotal + tax; if none does, the subtotal
	// is the misread one (dropped decimal, goods-only line above a core charge).
	let subtotalOut = subtotalAmount;
	if (
		subtotalAmount != null &&
		taxAmount != null &&
		total.amount != null &&
		!total.derived &&
		Math.abs(subtotalAmount + taxAmount - total.amount) > 0.02
	) {
		subtotalOut = Math.round((total.amount - taxAmount) * 100) / 100;
		field_source.subtotal = { source: "derived" };
		field_confidence.subtotal = 0.5;
	}

	// Only a value that was read: a derived or chain-rule value keeps its own chip.
	const readFrom: [keyof typeof field_source, TextractField | undefined][] = [
		["vendor_name", useHint ? undefined : vendor],
		["receipt_number", hints?.receipt_number ? undefined : receiptNo],
		["purchased_at", date],
		["subtotal", subtotal],
		["tax_amount", tax],
		["total", total.field],
	];
	for (const [key, f] of readFrom) {
		if (field_source[key]?.source === "read" && isHandwritten(f)) {
			field_source[key] = { source: "rule", rule: "handwritten" };
		}
	}

	const lines = (doc.LineItemGroups ?? [])
		.flatMap((g) => g.LineItems ?? [])
		.map((item) => {
			const own = item.LineItemExpenseFields ?? [];
			const description = best(own, "ITEM");
			const price = best(own, "PRICE");
			const confidence = confidenceOf(description);
			return normalizeLine({
				description: valueOf(description),
				quantity: valueOf(best(own, "QUANTITY")),
				unit_price: parsePrintedMoney(valueOf(best(own, "UNIT_PRICE"))),
				line_total: parsePrintedMoney(valueOf(price)),
				// Below the line cutoff, so a pen-written line gets the low-confidence mark.
				confidence:
					isHandwritten(description) || isHandwritten(price)
						? Math.min(confidence ?? 0.5, 0.5)
						: confidence,
			});
		})
		.filter((l): l is ExtractedLine => l !== null);

	return {
		vendor_name: vendorName,
		receipt_number: receiptNumber,
		// On a receipt-book form a pen-written phone is usually the customer's, and it
		// would link a supplier with no chip.
		vendor_phone: isHandwritten(phone) ? null : toText(valueOf(phone), 40),
		purchased_at: purchasedAt,
		subtotal: subtotalOut,
		tax_amount: taxAmount,
		total: total.amount,
		// Null raises no flag; only a printed header (see detectDocumentKind) sets it.
		document_type: hints?.document_kind ?? null,
		currency: toText(
			(best(fields, "TOTAL") ?? best(fields, "AMOUNT_PAID"))?.Currency
				?.Code,
			3,
		),
		lines,
		field_confidence,
		field_source,
		raw,
	};
}
