import {
	OCR_TIMEOUT_MS,
	normalizeLine,
	toDate,
	toMoney,
	toText,
	type ExtractedLine,
	type OcrFile,
	type ReceiptExtraction,
} from "./normalize.js";

/**
 * Mindee V2. Verified against a live account on 2026-09-01: `Authorization: <key>`
 * with no `Bearer`, a `model_id` the operator creates from the Receipt catalogue
 * template in their own console, and an enqueue/poll pair rather than one
 * synchronous predict.
 */

const BASE_URL = "https://api-v2.mindee.net";
const ENQUEUE_URL = `${BASE_URL}/v2/products/extraction/enqueue`;

/**
 * Mindee grades a field instead of scoring it, and the flags the technician sees
 * are numeric. Mapped so `OCR_LOW_CONFIDENCE` (0.75) leaves Certain and High alone
 * and marks Medium and below for attention - the same boundary Mindee draws
 * between a field to trust and a field to look at.
 */
const CONFIDENCE_SCORE: Record<string, number> = {
	certain: 1,
	high: 0.9,
	medium: 0.6,
	low: 0.3,
};

/** Extraction settles in a few seconds, so the first look waits longer than the rest. */
const FIRST_POLL_DELAY_MS = 1_500;
const POLL_INTERVAL_MS = 750;

export interface MindeeConfig {
	apiKey: string;
	modelId: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Enqueue and every poll share one budget rather than each getting its own: a
 * technician is standing at a counter, and three patient requests are worse than
 * one refusal.
 */
function remaining(deadline: number): number {
	const left = deadline - Date.now();
	if (left <= 0) throw new Error("Mindee did not answer in time - enter the receipt by hand");
	return left;
}

interface MindeeProblem {
	detail?: unknown;
	title?: unknown;
	code?: unknown;
}

async function readProblem(res: Response): Promise<string> {
	const body = await res.text().catch(() => "");
	let parsed: MindeeProblem | null = null;
	try {
		parsed = JSON.parse(body) as MindeeProblem;
	} catch {
		parsed = null;
	}
	const detail =
		(typeof parsed?.detail === "string" && parsed.detail) ||
		(typeof parsed?.title === "string" && parsed.title) ||
		body.slice(0, 200);
	return typeof parsed?.code === "string" ? `${detail} [${parsed.code}]` : detail;
}

/**
 * The message reaches the technician verbatim through `ocr_error`, so each status
 * says what they can do about it rather than what the wire said.
 */
function describeFailure(status: number, problem: string): string {
	if (status === 401 || status === 403) return `Mindee rejected the API key (${status}): ${problem}`;
	if (status === 402) return `The Mindee account is out of credit: ${problem}`;
	if (status === 404) return `No Mindee model matches MINDEE_MODEL_ID: ${problem}`;
	if (status === 429) return `Mindee is rate limiting - retry the receipt shortly: ${problem}`;
	if (status === 422) return `Mindee would not accept this receipt: ${problem}`;
	return `Mindee returned ${status}: ${problem}`;
}

async function getJson(url: string, cfg: MindeeConfig, deadline: number): Promise<unknown> {
	const res = await fetch(url, {
		headers: { authorization: cfg.apiKey },
		signal: AbortSignal.timeout(remaining(deadline)),
	});
	if (!res.ok) throw new Error(describeFailure(res.status, await readProblem(res)));
	return res.json();
}

/** Without this the poll answers a redirect to the result, which fetch would follow blind. */
function noRedirect(url: string): string {
	const u = new URL(url);
	u.searchParams.set("redirect", "false");
	return u.toString();
}

/** A limit and a wobble are worth one more try; a bad key or a bad file are not. */
const RETRYABLE = (status: number) => status === 429 || status >= 500;
const RETRY_DELAY_MS = 1_200;

async function enqueue(file: OcrFile, cfg: MindeeConfig, deadline: number): Promise<string> {
	const form = new FormData();
	form.append("model_id", cfg.modelId);
	// Off by default, and without it every `confidence` comes back null - which would
	// leave the technician's low-confidence flags with nothing to raise.
	form.append("confidence", "true");

	// Sent explicitly rather than left to Mindee's default, because the retention
	// policy for `ocr_raw` rests on it. Enabled, this returns the receipt's full
	// printed text - card digits, approval code, footer - and stores it verbatim in
	// a column no surface reads back. A field-level payload of a vendor, a date and
	// a total is a different artifact from the whole receipt rendered searchable,
	// and only the first is what the 180-day window was reasoned about. Do not
	// turn this on.
	form.append("raw_text", "false");
	form.append("file", new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }), file.filename);

	let res = await fetch(ENQUEUE_URL, {
		method: "POST",
		headers: { authorization: cfg.apiKey },
		body: form,
		signal: AbortSignal.timeout(remaining(deadline)),
	});
	// Reserve room for the retry's own round trip and the poll that follows it: a
	// retry that succeeds and then times out mid-poll is worse than failing fast.
	if (!res.ok && RETRYABLE(res.status) && deadline - Date.now() > RETRY_DELAY_MS + 5_000) {
		await sleep(RETRY_DELAY_MS);
		res = await fetch(ENQUEUE_URL, {
			method: "POST",
			headers: { authorization: cfg.apiKey },
			body: form,
			signal: AbortSignal.timeout(remaining(deadline)),
		});
	}
	if (!res.ok) throw new Error(describeFailure(res.status, await readProblem(res)));

	const body = (await res.json()) as { job?: { id?: unknown; polling_url?: unknown } };
	if (typeof body.job?.polling_url === "string") return body.job.polling_url;
	if (typeof body.job?.id === "string") return `${BASE_URL}/v2/jobs/${body.job.id}`;
	throw new Error("Mindee accepted the receipt but named no job to poll");
}

function describeJobError(err: unknown): string {
	const e = err as MindeeProblem | null;
	if (typeof e?.detail === "string") return e.detail;
	if (typeof e?.title === "string") return e.title;
	return "no reason given";
}

async function pollForResult(pollingUrl: string, cfg: MindeeConfig, deadline: number): Promise<unknown> {
	await sleep(Math.min(FIRST_POLL_DELAY_MS, remaining(deadline)));

	for (;;) {
		const body = (await getJson(noRedirect(pollingUrl), cfg, deadline)) as {
			job?: { status?: unknown; result_url?: unknown; error?: unknown };
			inference?: unknown;
		};

		// A finished job can answer with the inference itself instead of a pointer to it.
		if (body.inference) return body;

		const status = typeof body.job?.status === "string" ? body.job.status.toLowerCase() : "";
		if (status === "failed") {
			throw new Error(`Mindee could not read the receipt: ${describeJobError(body.job?.error)}`);
		}
		if (status === "processed") {
			const resultUrl = body.job?.result_url;
			if (typeof resultUrl !== "string") {
				throw new Error("Mindee finished the job but named no result to read");
			}
			return getJson(noRedirect(resultUrl), cfg, deadline);
		}

		await sleep(Math.min(POLL_INTERVAL_MS, remaining(deadline)));
	}
}

export async function extractWithMindee(file: OcrFile, cfg: MindeeConfig): Promise<ReceiptExtraction> {
	const deadline = Date.now() + OCR_TIMEOUT_MS;
	const pollingUrl = await enqueue(file, cfg, deadline);
	return mapMindee(await pollForResult(pollingUrl, cfg, deadline));
}

interface V2Field {
	value?: unknown;
	confidence?: unknown;
	fields?: Record<string, unknown>;
	items?: unknown[];
}

function fieldAt(source: Record<string, unknown>, key: string): V2Field {
	const v = source[key];
	return v && typeof v === "object" ? (v as V2Field) : {};
}

function gradeToScore(v: unknown): number | null {
	if (typeof v !== "string") return null;
	return CONFIDENCE_SCORE[v.trim().toLowerCase()] ?? null;
}

/**
 * `items` is documented as a list of field results and observed wrapping each row
 * in a single-element array; both are read the same way rather than betting a
 * receipt on which one arrives.
 */
function listRows(field: V2Field): V2Field[] {
	const raw = Array.isArray(field.items) ? field.items : [];
	return raw.flatMap((entry) => {
		const row = Array.isArray(entry) ? entry : [entry];
		return row.filter((v): v is V2Field => !!v && typeof v === "object");
	});
}

/**
 * Exported for the tests: the mapping is the part worth pinning, not the fetch.
 *
 * Pure, which is what lets `remapHeader` replay a stored `ocr_raw` long after the
 * call without a network round trip.
 */
export function mapMindee(raw: unknown): ReceiptExtraction {
	const doc = raw as { inference?: { result?: { fields?: Record<string, unknown> } } };
	const fields = doc?.inference?.result?.fields ?? {};

	const supplier = fieldAt(fields, "supplier_name");
	const receiptNo = fieldAt(fields, "receipt_number");
	const date = fieldAt(fields, "date");
	const time = fieldAt(fields, "time");
	const net = fieldAt(fields, "total_net");
	const tax = fieldAt(fields, "total_tax");
	const total = fieldAt(fields, "total_amount");

	const field_confidence: Record<string, number> = {};
	const score = (key: string, f: V2Field) => {
		const c = gradeToScore(f.confidence);
		if (c != null) field_confidence[key] = c;
	};
	score("vendor_name", supplier);
	score("purchased_at", date);
	score("subtotal", net);
	score("tax_amount", tax);
	score("total", total);

	// The receipt schema splits the purchase instant across two fields, and the time
	// of day is what the job-window check in the trust model reads.
	const day = toText(date.value, 32);
	const clock = toText(time.value, 8);
	const stamp = day && clock && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day} ${clock}` : day;

	const lines = listRows(fieldAt(fields, "line_items"))
		.map((row) => {
			const sub = row.fields ?? {};
			const lineTotal = fieldAt(sub, "total_price");
			return normalizeLine({
				description: fieldAt(sub, "description").value,
				quantity: fieldAt(sub, "quantity").value,
				unit_price: fieldAt(sub, "unit_price").value,
				// `total_amount` is what the older receipt schema called the line total.
				line_total: lineTotal.value ?? fieldAt(sub, "total_amount").value,
				confidence: gradeToScore(row.confidence),
			});
		})
		.filter((l): l is ExtractedLine => l !== null);

	// `locale` is a graded field like any other, but its own value carries no
	// content - what matters is its nested `currency`, `language`, and `country`.
	const localeFields = fieldAt(fields, "locale").fields ?? {};

	return {
		vendor_name: toText(supplier.value, 120),
		receipt_number: toText(receiptNo.value, 64),
		vendor_phone: toText(fieldAt(fields, "supplier_phone_number").value, 40),
		purchased_at: toDate(stamp),
		subtotal: toMoney(net.value),
		tax_amount: toMoney(tax.value),
		total: toMoney(total.value),
		document_type: toText(fieldAt(fields, "document_type").value, 40),
		currency: toText(fieldAt(localeFields, "currency").value, 3),
		lines,
		field_confidence,
		raw,
	};
}
