/**
 * Provider response mapping, the null-provider path, and the Mindee transport,
 * whose enqueue/poll pair has failure states a mapping test cannot reach. The
 * fixtures are documented response shapes, not recordings of a live account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	getReceiptOcrProvider,
	normalizeLine,
	OCR_LOW_CONFIDENCE,
	toConfidence,
	toDate,
	toMoney,
} from "../receiptOcr/index.js";
import { extractWithMindee, mapMindee } from "../receiptOcr/mindee.js";
import { SAMPLE_RECEIPT, mapFixture } from "../receiptOcr/fixture.js";
import mindeeV2Receipt from "../receiptOcr/__fixtures__/mindeeV2Receipt.json";

const ENV_KEYS = [
	"RECEIPT_OCR_PROVIDER",
	"MINDEE_API_KEY",
	"MINDEE_MODEL_ID",
	"NODE_ENV",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
	saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe("getReceiptOcrProvider", () => {
	it("returns null when nothing is configured, which is a supported end state", () => {
		expect(getReceiptOcrProvider()).toBeNull();
		process.env.RECEIPT_OCR_PROVIDER = "none";
		expect(getReceiptOcrProvider()).toBeNull();
	});

	it("returns null rather than a half-configured provider", () => {
		process.env.RECEIPT_OCR_PROVIDER = "mindee";
		expect(getReceiptOcrProvider()).toBeNull();
		// A key without the model it names cannot ask Mindee anything.
		process.env.MINDEE_API_KEY = "k";
		expect(getReceiptOcrProvider()).toBeNull();
	});

	// Case-insensitively, so an operator's "Mindee" is not a silently disabled OCR.
	it("resolves the configured provider by name", () => {
		process.env.RECEIPT_OCR_PROVIDER = "Mindee";
		process.env.MINDEE_API_KEY = "k";
		process.env.MINDEE_MODEL_ID = "3e8f1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b";
		expect(getReceiptOcrProvider()?.name).toBe("mindee");
	});

	it("disables rather than throws on an unknown provider name", () => {
		process.env.RECEIPT_OCR_PROVIDER = "tesseract";
		expect(getReceiptOcrProvider()).toBeNull();
	});
});

describe("value coercion", () => {
	it("rejects a misread that could not be a receipt", () => {
		expect(toMoney("1,234.56")).toBe(1234.56);
		expect(toMoney(-1)).toBeNull();
		expect(toMoney(1e12)).toBeNull();
		expect(toMoney("n/a")).toBeNull();
	});

	it("parses both date shapes providers return", () => {
		expect(toDate("2026-08-21")?.toISOString()).toBe("2026-08-21T00:00:00.000Z");
		expect(toDate("2026-08-21 14:30:00")?.getUTCHours()).toBe(14);
		expect(toDate("")).toBeNull();
	});

	it("derives the two fields receipts most often omit", () => {
		expect(normalizeLine({ description: "Capacitor", quantity: null, unit_price: 24.99, line_total: null, confidence: null })).toMatchObject(
			{ quantity: 1, line_total: 24.99 },
		);
		expect(normalizeLine({ description: "Wire", quantity: 4, unit_price: null, line_total: 10, confidence: null })).toMatchObject(
			{ unit_price: 2.5, line_total: 10 },
		);
	});

	it("clamps a score into 0..1 rather than trusting the provider's range", () => {
		expect(toConfidence(0.9317)).toBe(0.932);
		expect(toConfidence(1.4)).toBe(1);
		expect(toConfidence(-0.2)).toBe(0);
		expect(toConfidence("0.5")).toBe(0.5);
		// Absent, not certain. A missing score must never read as a confident one.
		expect(toConfidence(null)).toBeNull();
		expect(toConfidence("n/a")).toBeNull();
	});

	it("keeps a zone the provider did state, and assumes none where it stated none", () => {
		// Re-reading an explicit offset as UTC would move the receipt by that offset.
		expect(toDate("2026-08-21T14:30:00-04:00")?.toISOString()).toBe("2026-08-21T18:30:00.000Z");
		expect(toDate("2026-08-21T14:30:00Z")?.getUTCHours()).toBe(14);
		expect(toDate("not a date")).toBeNull();
		expect(toDate(null)).toBeNull();
		expect(toDate(20260821)).toBeNull();
	});

	it("rounds to cents, because a receipt has no third decimal", () => {
		expect(toMoney(24.994)).toBe(24.99);
		expect(toMoney(24.995)).toBe(25);
		expect(toMoney("$1,234.56 ")).toBe(1234.56);
		expect(toMoney(0)).toBe(0);
		expect(toMoney(true)).toBeNull();
	});

	it("treats a quantity of zero as one, which is what the receipt meant", () => {
		expect(
			normalizeLine({ description: "Fuse", quantity: 0, unit_price: 3, line_total: null, confidence: null }),
		).toMatchObject({ quantity: 1, line_total: 3 });
	});

	it("drops a line whose derived total could not have come off a receipt", () => {
		expect(
			normalizeLine({ description: "Ghost", quantity: 5000, unit_price: 5000, line_total: null, confidence: null }),
		).toBeNull();
	});

	/**
	 * Deliberately not dropped. Numbers this size are a misread, but the description
	 * usually is not, and the technician has to check and price every line anyway -
	 * a row at zero they must correct beats a line that silently vanished.
	 */
	it("keeps the description when the numbers are unreadable, priced at zero", () => {
		expect(
			normalizeLine({ description: "Ghost", quantity: 1e9, unit_price: 1e9, line_total: null, confidence: null }),
		).toMatchObject({ description: "Ghost", quantity: 1, unit_price: 0, line_total: 0 });
	});

	it("truncates a description rather than letting it overflow the column", () => {
		const line = normalizeLine({
			description: "x".repeat(300),
			quantity: 1,
			unit_price: 1,
			line_total: 1,
			confidence: null,
		});
		expect(line!.description).toHaveLength(200);
	});

	/**
	 * A printed discount is a negative line. Read as null and floored at zero it
	 * became a phantom row, and the receipt then disagreed with its own lines on
	 * every discounted purchase — a total_mismatch flag on ordinary input.
	 */
	it("keeps a negative line total", () => {
		expect(
			normalizeLine({ description: "CONTRACTOR DISC", quantity: null, unit_price: null, line_total: -12.5, confidence: null }),
		).toMatchObject({ quantity: 1, unit_price: -12.5, line_total: -12.5 });
	});

	it("derives a negative unit price from a negative total", () => {
		expect(
			normalizeLine({ description: "DISC", quantity: 2, unit_price: null, line_total: -10, confidence: null }),
		).toMatchObject({ quantity: 2, unit_price: -5, line_total: -10 });
	});

	// A negative quantity is not a negative line; it is a misread, and falls back
	// to one the way a zero or a missing one already does.
	it("keeps quantity positive", () => {
		expect(
			normalizeLine({ description: "Fuse", quantity: -3, unit_price: 3, line_total: null, confidence: null }),
		).toMatchObject({ quantity: 1, line_total: 3 });
	});

	// The bound becomes two-sided rather than removed.
	it("still refuses a magnitude past MAX_MONEY", () => {
		expect(
			normalizeLine({ description: "Ghost", quantity: 1, unit_price: null, line_total: -9_999_999_999, confidence: null }),
		).toMatchObject({ unit_price: 0, line_total: 0 });
	});

	it("drops a line with no description, which is not a line", () => {
		expect(normalizeLine({ description: "  ", quantity: 1, unit_price: 1, line_total: 1, confidence: 1 })).toBeNull();
	});
});

/** A Mindee V2 inference for the Receipt catalogue template. */
const MINDEE_RECEIPT = {
	inference: {
		result: {
			fields: {
				supplier_name: { value: "Grainger", confidence: "Certain" },
				date: { value: "2026-08-21", confidence: "High" },
				time: { value: "14:32:00", confidence: "High" },
				total_net: { value: 61.0, confidence: "High" },
				total_tax: { value: 4.27, confidence: "Medium" },
				total_amount: { value: 65.27, confidence: "Certain" },
				line_items: {
					confidence: "High",
					items: [
						{
							confidence: "High",
							fields: {
								description: { value: "Capacitor 45/5" },
								quantity: { value: 1 },
								unit_price: { value: 24.99 },
								total_price: { value: 24.99 },
							},
						},
						// Wrapped, which is the other shape the list schema permits.
						[
							{
								confidence: "Medium",
								fields: {
									description: { value: "Contactor 2P" },
									quantity: { value: 2 },
									unit_price: { value: 18.0 },
									total_price: { value: 36.0 },
								},
							},
						],
					],
				},
			},
		},
	},
};

describe("mapMindee", () => {
	it("maps the header, its confidences, and the line items", () => {
		const out = mapMindee(MINDEE_RECEIPT);
		expect(out.vendor_name).toBe("Grainger");
		// Date and time are separate fields; the instant is what the job-window check reads.
		expect(out.purchased_at?.toISOString()).toBe("2026-08-21T14:32:00.000Z");
		expect([out.subtotal, out.tax_amount, out.total]).toEqual([61, 4.27, 65.27]);
		expect(out.lines).toHaveLength(2);
		expect(out.lines[0]).toMatchObject({ quantity: 1, line_total: 24.99, confidence: 0.9 });
		expect(out.lines[1]).toMatchObject({ quantity: 2, line_total: 36, confidence: 0.6 });
	});

	it("scores the grades so that Medium and below trip the technician's flag", () => {
		const out = mapMindee(MINDEE_RECEIPT);
		expect(out.field_confidence).toEqual({
			vendor_name: 1,
			purchased_at: 0.9,
			subtotal: 0.9,
			tax_amount: 0.6,
			total: 1,
		});
		expect(out.field_confidence.tax_amount).toBeLessThan(OCR_LOW_CONFIDENCE);
		expect(out.field_confidence.subtotal).toBeGreaterThanOrEqual(OCR_LOW_CONFIDENCE);
	});

	it("keeps a date with no time rather than dropping the day", () => {
		const out = mapMindee({
			inference: { result: { fields: { date: { value: "2026-08-21" } } } },
		});
		expect(out.purchased_at?.toISOString()).toBe("2026-08-21T00:00:00.000Z");
	});

	it("survives a payload with nothing in it", () => {
		const out = mapMindee({});
		expect(out.vendor_name).toBeNull();
		expect(out.lines).toEqual([]);
		expect(out.field_confidence).toEqual({});
	});

	it("carries the receipt number, which is the strongest reuse key on the paper", () => {
		expect(mapMindee(mindeeV2Receipt).receipt_number).toBe("884213");
		expect(mapMindee({}).receipt_number).toBeNull();
	});

	it("ignores a grade it has never seen instead of scoring it zero", () => {
		const out = mapMindee({
			inference: { result: { fields: { total_amount: { value: 5, confidence: "Excellent" } } } },
		});
		expect(out.total).toBe(5);
		expect(out.field_confidence).toEqual({});
	});

	/**
	 * A full V2 envelope, unlike `SAMPLE_RECEIPT`'s bare `inference.result`. This is
	 * the test that fails if Mindee changes its payload rather than its docs.
	 */
	it("maps a full V2 envelope", () => {
		const out = mapMindee(mindeeV2Receipt);
		expect(out.vendor_name).toBe("Northgate Trade Supply");
		expect(out.purchased_at?.toISOString()).toBe("2026-08-21T14:32:00.000Z");
		expect([out.subtotal, out.tax_amount, out.total]).toEqual([287.83, 22.39, 310.22]);
		expect(out.lines).toHaveLength(5);
		expect(out.lines[0]).toMatchObject({
			description: "Capacitor 45/5 MFD 440V",
			quantity: 2,
			line_total: 49.98,
		});
		// Every grade on this receipt was Certain, so the whole header scores 1.
		expect(out.field_confidence).toEqual({
			vendor_name: 1,
			purchased_at: 1,
			subtotal: 1,
			tax_amount: 1,
			total: 1,
		});
	});

	it("reads the same receipt from both fixtures, so neither can drift alone", () => {
		const fromJson = mapMindee(mindeeV2Receipt);
		const fromModule = mapFixture(SAMPLE_RECEIPT);
		expect(fromJson.total).toBe(fromModule.total);
		expect(fromJson.tax_amount).toBe(fromModule.tax_amount);
		expect(fromJson.lines).toHaveLength(fromModule.lines.length);
	});

	it("reports what kind of document it read and in what currency", () => {
		const out = mapMindee(mindeeV2Receipt);
		expect(out.document_type).toBe("expense_receipt");
		expect(out.currency).toBe("USD");
	});
});

describe("extractWithMindee", () => {
	const CFG = { apiKey: "md_test", modelId: "3e8f1a2b-4c5d-4e6f-8a9b-0c1d2e3f4a5b" };
	const FILE = { buffer: Buffer.from("receipt-bytes"), mimetype: "image/heic", filename: "r.heic" };
	const JOB_URL = "https://api-v2.mindee.net/v2/jobs/j1";
	const RESULT_URL = `${JOB_URL}/result`;

	interface Reply {
		status?: number;
		body?: unknown;
	}

	/** A fresh Response per call: a body can only be read once. */
	function mockFetch(...replies: Reply[]) {
		let i = 0;
		const fn = vi.fn(async () => {
			const r = replies[Math.min(i, replies.length - 1)] ?? {};
			i += 1;
			return new Response(JSON.stringify(r.body ?? {}), {
				status: r.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fn);
		return fn;
	}

	const enqueued = { body: { job: { id: "j1", polling_url: JOB_URL } } };

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	/** The poll sleeps, so the clock has to move for the promise to settle. */
	async function settle<T>(p: Promise<T>, ms = 30_000) {
		const done = p.then(
			(value) => ({ rejected: false as const, value }),
			(err: unknown) => ({ rejected: true as const, err }),
		);
		await vi.advanceTimersByTimeAsync(ms);
		return done;
	}

	it.each([
		[401, "401-001", /rejected the API key \(401\)/],
		[403, "403-001", /rejected the API key \(403\)/],
		[402, "402-001", /out of credit/],
		[404, "404-001", /No Mindee model matches MINDEE_MODEL_ID/],
		[429, "429-001", /rate limiting - retry the receipt shortly/],
		[422, "422-003", /would not accept this receipt/],
		[500, "500-000", /Mindee returned 500/],
	])("turns a %i into a message that says what to do about it", async (status, code, match) => {
		mockFetch({ status, body: { status, detail: "the reason", code } });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(true);
		expect((out as { err: Error }).err.message).toMatch(match);
		// The vendor code survives into ocr_error, which is where support reads it.
		expect((out as { err: Error }).err.message).toContain(code);
	});

	it("sends the model id and the file, and authenticates without Bearer", async () => {
		const fetchMock = mockFetch(
			enqueued,
			{ body: { job: { status: "Processed", result_url: RESULT_URL } } },
			{ body: MINDEE_RECEIPT },
		);
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(false);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api-v2.mindee.net/v2/products/extraction/enqueue");
		const auth = (init.headers as Record<string, string>).authorization;
		expect(auth).toBe(CFG.apiKey);
		expect(auth).not.toMatch(/bearer/i);

		const form = init.body as FormData;
		expect(form.get("model_id")).toBe(CFG.modelId);
		// Without this the grades come back null and nothing ever trips the flag.
		expect(form.get("confidence")).toBe("true");
		expect((form.get("file") as { name?: string }).name).toBe("r.heic");
	});

	/**
	 * `raw_text` puts the receipt's full printed text - card digits, approval code,
	 * footer - into `ocr_raw`. The retention policy for that column was reasoned
	 * about a field-level payload, not a searchable copy of the whole receipt, so
	 * this is pinned rather than left to a provider default that could change
	 * under us.
	 */
	it("never asks Mindee for the receipt's raw text", async () => {
		const fetchMock = mockFetch(
			enqueued,
			{ body: { job: { status: "Processed", result_url: RESULT_URL } } },
			{ body: MINDEE_RECEIPT },
		);
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(false);

		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect((init.body as FormData).get("raw_text")).toBe("false");
	});

	it("polls past Processing and reads the result the job points at", async () => {
		const fetchMock = mockFetch(
			enqueued,
			{ body: { job: { status: "Processing" } } },
			{ body: { job: { status: "Processed", result_url: RESULT_URL } } },
			{ body: MINDEE_RECEIPT },
		);
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(false);
		expect((out as { value: { vendor_name: string } }).value.vendor_name).toBe("Grainger");

		expect(fetchMock).toHaveBeenCalledTimes(4);
		// Left on, the poll answers a redirect that fetch would follow blind.
		for (const [url] of fetchMock.mock.calls.slice(1) as unknown as [string][]) {
			expect(url).toContain("redirect=false");
		}
		expect((fetchMock.mock.calls[3] as unknown as [string])[0]).toContain(RESULT_URL);
	});

	it("reads an inference the poll hands back inline", async () => {
		const fetchMock = mockFetch(enqueued, { body: MINDEE_RECEIPT });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect((out as { value: { total: number } }).value.total).toBe(65.27);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("falls back to the job id when enqueue names no polling url", async () => {
		const fetchMock = mockFetch({ body: { job: { id: "j1" } } }, { body: MINDEE_RECEIPT });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(false);
		expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain("/v2/jobs/j1");
	});

	it("refuses an enqueue that names no job at all", async () => {
		mockFetch({ body: {} });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect((out as { err: Error }).err.message).toMatch(/named no job to poll/);
	});

	it("reports a failed job with the reason Mindee gave", async () => {
		mockFetch(enqueued, { body: { job: { status: "Failed", error: { detail: "Unreadable page" } } } });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect((out as { err: Error }).err.message).toMatch(/could not read the receipt: Unreadable page/);
	});

	it("refuses a processed job that names no result", async () => {
		mockFetch(enqueued, { body: { job: { status: "Processed" } } });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect((out as { err: Error }).err.message).toMatch(/named no result to read/);
	});

	it("gives up inside the window a technician can stand at a counter", async () => {
		mockFetch(enqueued, { body: { job: { status: "Processing" } } });
		const out = await settle(extractWithMindee(FILE, CFG), 60_000);
		expect(out.rejected).toBe(true);
		expect((out as { err: Error }).err.message).toMatch(/did not answer in time/);
	});

	it("retries once through a rate limit rather than losing the receipt", async () => {
		const fetchMock = mockFetch(
			{ status: 429, body: { status: 429, detail: "slow down", code: "429-001" } },
			enqueued,
			{ body: MINDEE_RECEIPT },
		);
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("gives up after one retry rather than hammering a limit", async () => {
		const fetchMock = mockFetch({ status: 429, body: { status: 429, detail: "slow down", code: "429-001" } });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(true);
		expect((out as { err: Error }).err.message).toMatch(/rate limiting/);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not retry a rejected key, which will not get better", async () => {
		const fetchMock = mockFetch({ status: 401, body: { status: 401, detail: "bad", code: "401-001" } });
		const out = await settle(extractWithMindee(FILE, CFG));
		expect(out.rejected).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

/**
 * The keyless provider. Its job is to make auto-fill demonstrable and E2E-testable
 * with no vendor account and no network, so what is asserted is that it is
 * deterministic and that its own arithmetic holds - a fixture whose total disagreed
 * with its lines would raise a total_mismatch flag on every demo receipt.
 */
describe("fixture provider", () => {
	const file = { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" };

	beforeEach(() => {
		process.env.RECEIPT_OCR_PROVIDER = "fixture";
	});

	it("resolves without any credential, unlike the paid providers", () => {
		expect(getReceiptOcrProvider()?.name).toBe("fixture");
	});

	/**
	 * It invents a receipt. In production that is not a demo, it is fabricated
	 * financial data written onto a real reimbursement — a vendor, a date and a
	 * total nobody paid, plus line items nobody bought, all applied silently
	 * because runReceiptOcr is designed never to throw.
	 */
	it("refuses to run in production, where a made-up receipt is fraud", () => {
		process.env.NODE_ENV = "production";
		expect(getReceiptOcrProvider()).toBeNull();
	});

	it("still runs in every other environment", () => {
		process.env.NODE_ENV = "development";
		expect(getReceiptOcrProvider()?.name).toBe("fixture");
		process.env.NODE_ENV = "test";
		expect(getReceiptOcrProvider()?.name).toBe("fixture");
	});

	it("reads the same receipt every time", async () => {
		const provider = getReceiptOcrProvider()!;
		expect(await provider.extract(file)).toEqual(await provider.extract(file));
	});

	it("fills every header field and more than one line", async () => {
		const out = await getReceiptOcrProvider()!.extract(file);
		expect(out.vendor_name).toBeTruthy();
		expect(out.purchased_at).toBeInstanceOf(Date);
		expect(out.subtotal).toBeGreaterThan(0);
		expect(out.tax_amount).toBeGreaterThan(0);
		expect(out.total).toBeGreaterThan(0);
		expect(out.lines.length).toBeGreaterThan(1);
		for (const l of out.lines) {
			expect(l.description).toBeTruthy();
			expect(l.quantity).toBeGreaterThan(0);
			// Signed, not positive: the fixture carries a printed discount, which is
			// the only way the demo receipt can show that path working.
			expect(l.unit_price).not.toBe(0);
		}
	});

	it("carries a discount line, so the signed path is demonstrable", async () => {
		const out = await getReceiptOcrProvider()!.extract(file);
		expect(out.lines.filter((l) => l.line_total < 0)).toHaveLength(1);
	});

	it("adds up, so a demo receipt raises no total_mismatch flag", async () => {
		const out = await getReceiptOcrProvider()!.extract(file);
		const lines = out.lines.reduce((n, l) => n + l.line_total, 0);
		expect(lines).toBeCloseTo(out.subtotal!, 2);
		expect(lines + out.tax_amount!).toBeCloseTo(out.total!, 2);
	});

	it("carries a low-confidence header field and line, so the flags have something to show", async () => {
		const out = await getReceiptOcrProvider()!.extract(file);
		expect(Object.values(out.field_confidence).some((c) => c < OCR_LOW_CONFIDENCE)).toBe(true);
		expect(out.lines.some((l) => l.confidence != null && l.confidence < OCR_LOW_CONFIDENCE)).toBe(
			true,
		);
	});
});
