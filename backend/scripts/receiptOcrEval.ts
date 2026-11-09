/**
 * Side-by-side receipt OCR accuracy: runs every configured provider over a folder of
 * real receipt photos and scores each against hand-checked truth. Run with:
 *   npx tsx --env-file=.env scripts/receiptOcrEval.ts <receipts-dir> [--refresh]
 * --cutoffs='{"fields":{"total":0.9},"line":0.8}' scores a candidate cutoff table (merged over
 * OCR_CUTOFFS). A holdout is the same script on a second folder with its own truth.json.
 *
 * Textract runs when TEXTRACT_REGION + TEXTRACT_ACCESS_KEY_ID +
 * TEXTRACT_SECRET_ACCESS_KEY are set. Every call bills the vendor account directly -
 * the per-org scan meter is not in this path - so each provider's raw payload is
 * cached under <dir>/.ocr-eval/ and re-read on later runs; --refresh calls again.
 *
 * Truth lives in <dir>/truth.json, keyed by file name. On a first run without it,
 * <dir>/truth.template.json is written prefilled from whichever provider answered
 * first, with a `_check` list of every field the providers disagree on. Correct it
 * by looking at each photo - all of it, not only `_check`: a prefill accepted on
 * trust scores that provider against itself - then rename it to truth.json. Fields
 * left null are not scored. The folder holds real receipts: keep it out of the repo.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildOcrFlags } from "../src/services/receiptOcr/flags.js";
import {
	OCR_CUTOFFS,
	OCR_HEADER_FIELDS,
	type OcrCutoffs,
	type OcrFieldKey,
	type ReceiptExtraction,
} from "../src/services/receiptOcr/normalize.js";
import { extractWithTextract, mapTextract } from "../src/services/receiptOcr/textract.js";
import {
	normalizePhone,
	normalizeReceiptNumber,
	normalizeVendor,
	vendorsNear,
} from "../src/lib/fieldPurchase.js";

interface Truth {
	vendor_name: string | null;
	receipt_number: string | null;
	vendor_phone: string | null;
	/** YYYY-MM-DD. Time of day is not scored: few receipts print one both read alike. */
	purchased_at: string | null;
	subtotal: number | null;
	tax_amount: number | null;
	total: number | null;
	/** Every printed line, discounts included, so the count and the amounts both score. */
	lines: { description: string; line_total: number }[] | null;
}

type Field = Exclude<keyof Truth, "lines">;
const FIELDS: Field[] = [
	"vendor_name",
	"receipt_number",
	"vendor_phone",
	"purchased_at",
	"subtotal",
	"tax_amount",
	"total",
];
const isOcrField = (f: Field): f is OcrFieldKey => OCR_HEADER_FIELDS.some((k) => k === f);

type EventSource = "read" | "rule" | "derived" | "none";
const SOURCES: { key: EventSource; tag: string }[] = [
	{ key: "read", tag: "r" },
	{ key: "rule", tag: "u" },
	{ key: "derived", tag: "d" },
	{ key: "none", tag: "n" },
];
const SWEEP = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

interface FlagEvent {
	field: OcrFieldKey;
	source: EventSource;
	right: boolean;
	/** At the evaluated cutoffs: a flag exists and it is not "not_found". */
	flagged: boolean;
	confidence: number | null;
}
interface LineEvent {
	right: boolean;
	confidence: number | null;
}

/** Same test buildOcrFlags applies to a read value; a missing confidence is never flagged. */
const unsureAt = (confidence: number | null, cutoff: number) =>
	confidence != null && confidence < cutoff;

interface Provider {
	name: string;
	run: (file: { buffer: Buffer; mimetype: string; filename: string }) => Promise<ReceiptExtraction>;
	map: (raw: unknown) => ReceiptExtraction;
}

const MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".heic": "image/heic",
	".pdf": "application/pdf",
};

function providers(): Provider[] {
	const out: Provider[] = [];
	const { TEXTRACT_REGION, TEXTRACT_ACCESS_KEY_ID, TEXTRACT_SECRET_ACCESS_KEY } = process.env;
	if (TEXTRACT_REGION && TEXTRACT_ACCESS_KEY_ID && TEXTRACT_SECRET_ACCESS_KEY) {
		const cfg = {
			region: TEXTRACT_REGION,
			accessKeyId: TEXTRACT_ACCESS_KEY_ID,
			secretAccessKey: TEXTRACT_SECRET_ACCESS_KEY,
		};
		out.push({ name: "textract", run: (f) => extractWithTextract(f, cfg), map: mapTextract });
	}
	return out;
}

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const cents = (n: number) => Math.round(n * 100);

function matches(field: Field, got: ReceiptExtraction, want: Truth): boolean {
	switch (field) {
		case "vendor_name": {
			// Same rule the duplicate check uses: "Johnstone Supply #114" is a hit.
			return vendorsNear(normalizeVendor(got.vendor_name), normalizeVendor(want.vendor_name));
		}
		case "vendor_phone":
			return normalizePhone(got.vendor_phone) === normalizePhone(want.vendor_phone);
		case "receipt_number":
			return normalizeReceiptNumber(got.receipt_number) === normalizeReceiptNumber(want.receipt_number);
		case "purchased_at":
			return day(got.purchased_at) === want.purchased_at;
		default: {
			const g = got[field];
			const w = want[field];
			return g != null && w != null && cents(g) === cents(w);
		}
	}
}

interface LineScore {
	expected: number;
	read: number;
	/** Truth lines whose amount appears among the read lines, each read line used once. */
	amountHits: number;
	/** Per read line: its amount matched a truth line, so the line is a real one. */
	readRight: boolean[];
}

function scoreLines(got: ReceiptExtraction, want: Truth): LineScore | null {
	if (!want.lines) return null;
	const used = new Set<number>();
	for (const line of want.lines) {
		const i = got.lines.findIndex(
			(l, j) => !used.has(j) && cents(l.line_total) === cents(line.line_total),
		);
		if (i >= 0) used.add(i);
	}
	return {
		expected: want.lines.length,
		read: got.lines.length,
		amountHits: used.size,
		readRight: got.lines.map((_, j) => used.has(j)),
	};
}

interface Tally {
	right: number;
	scored: number;
}

interface ProviderReport {
	fields: Record<Field, Tally>;
	receiptsAllHeaderRight: number;
	receiptsScored: number;
	lines: { expected: number; read: number; amountHits: number; exactCount: number; receipts: number };
	events: FlagEvent[];
	lineEvents: LineEvent[];
	failures: string[];
	latencyMs: number[];
}

function emptyReport(): ProviderReport {
	return {
		fields: Object.fromEntries(FIELDS.map((f) => [f, { right: 0, scored: 0 }])) as Record<Field, Tally>,
		receiptsAllHeaderRight: 0,
		receiptsScored: 0,
		lines: { expected: 0, read: 0, amountHits: 0, exactCount: 0, receipts: 0 },
		events: [],
		lineEvents: [],
		failures: [],
		latencyMs: [],
	};
}

function parseCutoffs(json: string): OcrCutoffs {
	const bad = (why: string): never => {
		throw new Error(`--cutoffs: ${why}. Expected {"fields":{"total":0.9},"line":0.8}`);
	};
	const inRange = (v: unknown): v is number =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		return bad(`not valid JSON (${(err as Error).message})`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return bad("must be a JSON object");
	}
	const { fields, line, ...extra } = parsed as Record<string, unknown>;
	if (Object.keys(extra).length > 0) bad(`unknown key(s): ${Object.keys(extra).join(", ")}`);
	const out: OcrCutoffs = { fields: { ...OCR_CUTOFFS.fields }, line: OCR_CUTOFFS.line };
	if (line !== undefined) {
		if (!inRange(line)) bad(`line must be a number in [0,1], got ${JSON.stringify(line)}`);
		else out.line = line;
	}
	if (fields !== undefined) {
		if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
			bad("fields must be an object");
		}
		for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
			const known = OCR_HEADER_FIELDS.find((k) => k === key);
			if (!known) bad(`unknown field "${key}" (valid: ${OCR_HEADER_FIELDS.join(", ")})`);
			else if (!inRange(value)) bad(`${key} must be a number in [0,1], got ${JSON.stringify(value)}`);
			else out.fields[known] = value;
		}
	}
	return out;
}

function flagSections(
	entries: (readonly [string, ProviderReport])[],
	cutoffs: OcrCutoffs,
): string[] {
	const out: string[] = [
		"## Flag outcomes at the evaluated cutoffs",
		"",
		`Cutoffs: ${JSON.stringify(cutoffs)}. Flagged = an unsure or calculated flag. Silent = a wrong`,
		"value with no such flag. A value the provider left empty shows a Not found chip, so it is",
		"counted as missing, never silent. Cell = total, then by source: r read, u rule, d derived.",
		"Truth-null fields count only when a value was invented.",
		"",
	];
	const split = (events: FlagEvent[]) => {
		if (events.length === 0) return "0";
		const parts = SOURCES.flatMap(({ key, tag }) => {
			const n = events.filter((e) => e.source === key).length;
			return n > 0 ? [`${n}${tag}`] : [];
		});
		return `${events.length} (${parts.join(" ")})`;
	};
	for (const [name, r] of entries) {
		out.push(
			`### ${name}`,
			"",
			"| Field | correct | wrong & flagged | wrong & UNFLAGGED (silent) | missing (Not found chip) | right & flagged (noise) |",
			"|---|---|---|---|---|---|",
		);
		for (const field of OCR_HEADER_FIELDS) {
			const ev = r.events.filter((e) => e.field === field);
			const cells = [
				ev.filter((e) => e.right),
				ev.filter((e) => !e.right && e.flagged),
				ev.filter((e) => !e.right && !e.flagged && e.source !== "none"),
				ev.filter((e) => !e.right && e.source === "none"),
				ev.filter((e) => e.right && e.flagged),
			].map(split);
			out.push(`| ${field} | ${cells.join(" | ")} |`);
		}
		const le = r.lineEvents;
		const flagged = (e: LineEvent) => unsureAt(e.confidence, cutoffs.line);
		const counts = [
			le.filter((e) => e.right),
			le.filter((e) => !e.right && flagged(e)),
			le.filter((e) => !e.right && !flagged(e)),
			le.filter((e) => e.right && flagged(e)),
		].map((x) => x.length);
		const [ok, wrongFlagged, silent, noise] = counts;
		const lineCells = [ok, wrongFlagged, silent, "—", noise].join(" | ");
		out.push(`| lines (cutoff ${cutoffs.line}) | ${lineCells} |`, "");
	}
	out.push(
		"## Cutoff sweep (read values only, cell = silent / noise)",
		"",
		"Silent = wrong and not flagged at that cutoff; noise = right but flagged. Rule, derived",
		"and empty values are outside the sweep. A read value with no confidence is never flagged,",
		"so it stays silent at every cutoff; the last row counts them (with how many are wrong,",
		"out of all read) to explain a flat silent column.",
		"",
	);
	const cell = (items: { right: boolean; confidence: number | null }[], c: number) => {
		const silent = items.filter((e) => !e.right && !unsureAt(e.confidence, c)).length;
		const noise = items.filter((e) => e.right && unsureAt(e.confidence, c)).length;
		return `${silent} / ${noise}`;
	};
	for (const [name, r] of entries) {
		const cols = [...OCR_HEADER_FIELDS, "all fields", "lines"];
		out.push(
			`### ${name}`,
			"",
			`| Cutoff | ${cols.join(" | ")} |`,
			`|---|${cols.map(() => "---").join("|")}|`,
		);
		const read = r.events.filter((e) => e.source === "read");
		for (const c of SWEEP) {
			const cells = [
				...OCR_HEADER_FIELDS.map((f) =>
					cell(
						read.filter((e) => e.field === f),
						c,
					),
				),
				cell(read, c),
				cell(r.lineEvents, c),
			];
			out.push(`| ${c.toFixed(2)} | ${cells.join(" | ")} |`);
		}
		const nullConf = (items: { right: boolean; confidence: number | null }[]) => {
			const none = items.filter((e) => e.confidence == null);
			const wrong = none.filter((e) => !e.right).length;
			return `${none.length} (${wrong} wrong) of ${items.length}`;
		};
		const nullCells = [
			...OCR_HEADER_FIELDS.map((f) =>
				nullConf(
					read.filter((e) => e.field === f),
				),
			),
			nullConf(read),
			nullConf(r.lineEvents),
		];
		out.push(`| null confidence | ${nullCells.join(" | ")} |`);
		out.push("");
	}
	return out;
}

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

interface Cached {
	raw: unknown;
	latency_ms: number;
}

async function readOrRun(
	p: Provider,
	cacheDir: string,
	name: string,
	buffer: Buffer,
	refresh: boolean,
): Promise<{ extraction: ReceiptExtraction; latency: number }> {
	const cacheFile = path.join(cacheDir, p.name, `${name}.json`);
	if (!refresh && existsSync(cacheFile)) {
		const cached = JSON.parse(await readFile(cacheFile, "utf8")) as Cached;
		// Re-mapped from raw, so a mapping fix is re-scored without paying for the call again.
		return { extraction: p.map(cached.raw), latency: cached.latency_ms };
	}
	const started = Date.now();
	const extraction = await p.run({
		buffer,
		mimetype: MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream",
		filename: name,
	});
	const latency = Date.now() - started;
	await mkdir(path.dirname(cacheFile), { recursive: true });
	await writeFile(cacheFile, JSON.stringify({ raw: extraction.raw, latency_ms: latency } satisfies Cached, null, 2));
	return { extraction, latency };
}

function toTruth(x: ReceiptExtraction): Truth {
	return {
		vendor_name: x.vendor_name,
		receipt_number: x.receipt_number,
		vendor_phone: x.vendor_phone,
		purchased_at: day(x.purchased_at),
		subtotal: x.subtotal,
		tax_amount: x.tax_amount,
		total: x.total,
		lines: x.lines.map((l) => ({ description: l.description, line_total: l.line_total })),
	};
}

function show(v: unknown): string {
	if (v instanceof Date) return day(v) ?? "";
	if (v == null) return "∅";
	return String(v);
}

async function main() {
	const args = process.argv.slice(2);
	const dir = args.find((a) => !a.startsWith("--"));
	const cutoffsArg = args.find((a) => a.startsWith("--cutoffs="));
	const cutoffs = cutoffsArg
		? parseCutoffs(cutoffsArg.slice("--cutoffs=".length))
		: OCR_CUTOFFS;
	// --refresh calls every provider again; --refresh=textract only that one.
	const refreshArg = args.find((a) => a.startsWith("--refresh"));
	const refreshOnly = refreshArg?.split("=")[1];
	const refreshes = (p: Provider) => refreshArg != null && (!refreshOnly || refreshOnly === p.name);
	if (!dir) {
		throw new Error(
			"usage: receiptOcrEval.ts <receipts-dir> [--refresh[=provider]] [--cutoffs=<json>]",
		);
	}

	const active = providers();
	if (active.length === 0) throw new Error("No provider credentials set - see the header of this script");

	const files = (await readdir(dir)).filter((f) => MIME[path.extname(f).toLowerCase()]).sort();
	if (files.length === 0) throw new Error(`No receipt images in ${dir}`);

	const cacheDir = path.join(dir, ".ocr-eval");
	const truthPath = path.join(dir, "truth.json");
	const truth: Record<string, Truth> = existsSync(truthPath)
		? (JSON.parse(await readFile(truthPath, "utf8")) as Record<string, Truth>)
		: {};

	console.log(`${files.length} receipts · providers: ${active.map((p) => p.name).join(", ")}`);

	const reports = Object.fromEntries(active.map((p) => [p.name, emptyReport()])) as Record<string, ProviderReport>;
	const template: Record<string, Truth & { _check?: string[] }> = {};
	const misses: string[] = [];

	for (const name of files) {
		const buffer = await readFile(path.join(dir, name));
		const want = truth[name];
		const read: Record<string, ReceiptExtraction> = {};
		for (const p of active) {
			const report = reports[p.name]!;
			let extraction: ReceiptExtraction;
			try {
				// A throttled read is not an accuracy result; nobody is waiting here, so pace and retry once.
				const out = await readOrRun(p, cacheDir, name, buffer, refreshes(p)).catch(async (err: Error) => {
					if (!/rate limit/i.test(err.message)) throw err;
					console.log(`  … ${p.name} ${name}: rate limited, retrying in 20s`);
					await new Promise((resolve) => setTimeout(resolve, 20_000));
					return readOrRun(p, cacheDir, name, buffer, refreshes(p));
				});
				extraction = out.extraction;
				report.latencyMs.push(out.latency);
			} catch (err) {
				report.failures.push(`${name}: ${(err as Error).message}`);
				console.log(`  ✗ ${p.name} ${name}: ${(err as Error).message}`);
				continue;
			}
			read[p.name] = extraction;
			template[name] ??= toTruth(extraction);
			if (!want) continue;

			report.receiptsScored += 1;
			let allRight = true;
			const flags = buildOcrFlags(extraction, cutoffs).fields;
			const record = (field: OcrFieldKey, ok: boolean) => {
				const flag = flags[field];
				const source = extraction[field] == null ? "none" : extraction.field_source[field]?.source;
				report.events.push({
					field,
					source: source ?? "read",
					right: ok,
					flagged: flag != null && flag.kind !== "not_found",
					confidence: extraction.field_confidence[field] ?? null,
				});
			};
			for (const field of FIELDS) {
				if (want[field] == null) {
					// Truth says nothing printed: only an invented value is an error worth flagging.
					if (isOcrField(field) && extraction[field] != null) record(field, false);
					continue;
				}
				const ok = matches(field, extraction, want);
				report.fields[field].scored += 1;
				if (ok) report.fields[field].right += 1;
				else {
					allRight = false;
					misses.push(`| ${name} | ${p.name} | ${field} | ${show(want[field])} | ${show(extraction[field])} |`);
				}
				if (isOcrField(field)) record(field, ok);
			}
			if (allRight) report.receiptsAllHeaderRight += 1;

			const lines = scoreLines(extraction, want);
			if (lines) {
				report.lines.receipts += 1;
				report.lines.expected += lines.expected;
				report.lines.read += lines.read;
				report.lines.amountHits += lines.amountHits;
				if (lines.read === lines.expected) report.lines.exactCount += 1;
				extraction.lines.forEach((l, j) =>
					report.lineEvents.push({ right: lines.readRight[j]!, confidence: l.confidence }),
				);
			}
		}

		const entry = template[name];
		if (entry && Object.keys(read).length > 1) {
			const check = [...FIELDS, "lines" as const].flatMap((field) => {
				const values = Object.entries(read).map(([n, x]) => [n, JSON.stringify(toTruth(x)[field])] as const);
				return new Set(values.map(([, v]) => v)).size > 1
					? [`${field}: ${values.map(([n, v]) => `${n}=${field === "lines" ? `${JSON.parse(v).length} lines` : v}`).join(" ")}`]
					: [];
			});
			if (check.length > 0) entry._check = check;
		}
	}

	// Template covers only receipts without truth, so new photos can join an existing set.
	const pending = Object.fromEntries(Object.entries(template).filter(([name]) => !truth[name]));
	if (Object.keys(pending).length > 0) {
		const out = path.join(dir, "truth.template.json");
		await writeFile(out, JSON.stringify(pending, null, 2));
		console.log(`\n${Object.keys(pending).length} receipts lack truth. Wrote ${out} - correct it against the photos, merge into truth.json, re-run.`);
		console.log("Re-runs read the cache, so scoring costs nothing further.");
	}
	if (Object.keys(truth).length === 0) return;

	const median = (xs: number[]) => {
		if (xs.length === 0) return "—";
		const s = [...xs].sort((a, b) => a - b);
		return `${(s[Math.floor(s.length / 2)]! / 1000).toFixed(1)}s`;
	};

	const names = active.map((p) => p.name);
	const row = (label: string, cell: (r: ProviderReport) => string) =>
		`| ${label} | ${names.map((n) => cell(reports[n]!)).join(" | ")} |`;
	const lines = [
		`# Receipt OCR eval — ${new Date().toISOString().slice(0, 10)}`,
		"",
		`${files.length} receipts, ${Object.keys(truth).length} with truth.`,
		"",
		`| Metric | ${names.join(" | ")} |`,
		`|---|${names.map(() => "---").join("|")}|`,
		...FIELDS.map((f) => row(f, (r) => `${pct(r.fields[f].right, r.fields[f].scored)} (${r.fields[f].right}/${r.fields[f].scored})`)),
		row("**every header field right**", (r) => pct(r.receiptsAllHeaderRight, r.receiptsScored)),
		row("line count exact", (r) => pct(r.lines.exactCount, r.lines.receipts)),
		row("line amounts found", (r) => `${pct(r.lines.amountHits, r.lines.expected)} (${r.lines.amountHits}/${r.lines.expected}, read ${r.lines.read})`),
		row("failed calls", (r) => String(r.failures.length)),
		row("median latency", (r) => median(r.latencyMs)),
		"",
		...flagSections(names.map((n) => [n, reports[n]!] as const), cutoffs),
		"## Misses",
		"",
		"| Receipt | Provider | Field | Truth | Read |",
		"|---|---|---|---|---|",
		...misses,
	];
	const report = lines.join("\n");
	await mkdir(cacheDir, { recursive: true });
	await writeFile(path.join(cacheDir, "report.md"), report);
	console.log(`\n${report}\n\nWritten to ${path.join(cacheDir, "report.md")}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
