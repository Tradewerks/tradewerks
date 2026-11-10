/**
 * Provider selection, value coercion, and the keyless fixture provider. The
 * Textract mapping lives in receiptOcrTextract.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	getReceiptOcrProvider,
	normalizeLine,
	OCR_CUTOFFS,
	toConfidence,
	toDate,
	toMoney,
} from "../receiptOcr/index.js";
import { buildOcrFlags } from "../receiptOcr/flags.js";
import { remapHeader } from "../receiptOcr/remap.js";

const ENV_KEYS = [
	"RECEIPT_OCR_PROVIDER",
	"TEXTRACT_REGION",
	"TEXTRACT_ACCESS_KEY_ID",
	"TEXTRACT_SECRET_ACCESS_KEY",
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

	it("retired providers are unknown, so they disable OCR rather than resolving", () => {
		for (const retired of ["mindee", "azure"]) {
			process.env.RECEIPT_OCR_PROVIDER = retired;
			expect(getReceiptOcrProvider()).toBeNull();
		}
	});

	it("returns null rather than a half-configured provider", () => {
		process.env.RECEIPT_OCR_PROVIDER = "textract";
		expect(getReceiptOcrProvider()).toBeNull();
	});

	// Case-insensitively, so an operator's "Textract" is not a silently disabled OCR.
	it("resolves the configured provider by name", () => {
		process.env.RECEIPT_OCR_PROVIDER = "Textract";
		process.env.TEXTRACT_REGION = "us-east-1";
		process.env.TEXTRACT_ACCESS_KEY_ID = "k";
		process.env.TEXTRACT_SECRET_ACCESS_KEY = "s";
		expect(getReceiptOcrProvider()?.name).toBe("textract");
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
		expect(Object.values(out.field_confidence).some((c) => c < OCR_CUTOFFS.line)).toBe(true);
		expect(out.lines.some((l) => l.confidence != null && l.confidence < OCR_CUTOFFS.line)).toBe(
			true,
		);
	});

	it("fixture yields all three flag kinds", async () => {
		const out = await getReceiptOcrProvider()!.extract(file);
		const { fields } = buildOcrFlags(out);
		// Unsure by confidence, unsure by rule, and calculated; the confident
		// vendor carries no flag at all.
		expect(fields.purchased_at).toMatchObject({ kind: "unsure", rule: null });
		expect(fields.receipt_number?.kind).toBe("unsure");
		expect(fields.receipt_number?.rule).toBeNull();
		expect(fields.total?.kind).toBe("calculated");
		expect(fields.vendor_name).toBeUndefined();
		expect(out.total).toBe(310.22);
		expect(out.vendor_phone).toBe("(555) 555-0188");
	});
});

describe("remapHeader", () => {
	it("remapHeader('mindee', raw) is null", () => {
		expect(remapHeader("mindee", { anything: true })).toBeNull();
	});

	it("remapHeader('textract', raw) includes receipt_number", async () => {
		process.env.RECEIPT_OCR_PROVIDER = "fixture";
		const file = { buffer: Buffer.from("x"), mimetype: "image/jpeg", filename: "r.jpg" };
		const out = await getReceiptOcrProvider()!.extract(file);
		expect(remapHeader("textract", out.raw)?.receipt_number).toBe("884213");
		expect(remapHeader("fixture", out.raw)?.receipt_number).toBe("884213");
	});
});
