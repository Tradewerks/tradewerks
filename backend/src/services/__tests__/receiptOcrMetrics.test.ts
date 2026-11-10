import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({ db: {} }));
vi.mock("../appLogger.js", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
const m = vi.hoisted(() => ({
	reads: vi.fn(),
	duration: vi.fn(),
	flags: vi.fn(),
}));
vi.mock("../metricsService.js", () => ({
	receiptOcrReads: { add: m.reads },
	receiptOcrDuration: { record: m.duration },
	receiptOcrFieldFlags: { add: m.flags },
	receiptOcrPending: { addCallback: vi.fn() },
	receiptOcrOldestPendingAge: { addCallback: vi.fn() },
}));

import { ocrMetrics, outcomeForFailure, pendingReadStats } from "../receiptOcr/ocrMetrics.js";

beforeEach(() => vi.clearAllMocks());

describe("receipt OCR metrics", () => {
	it("maps a provider failure to its outcome", () => {
		expect(outcomeForFailure("final")).toBe("failed");
		expect(outcomeForFailure("throttled")).toBe("throttled");
		expect(outcomeForFailure("timeout")).toBe("timeout");
		expect(outcomeForFailure("unavailable")).toBe("unavailable");
	});

	it("labels reads by provider and outcome only", () => {
		ocrMetrics.read("textract", "recovered");
		expect(m.reads).toHaveBeenCalledWith(1, { provider: "textract", outcome: "recovered" });
		ocrMetrics.duration("textract", 3.2);
		expect(m.duration).toHaveBeenCalledWith(3.2, { provider: "textract" });
	});

	it("counts each flagged field once, by field and kind", () => {
		ocrMetrics.flags({
			fields: {
				total: { kind: "unsure", confidence: 0.6, rule: null },
				receipt_number: { kind: "not_found", confidence: null, rule: null },
			},
			line_cutoff: 0.75,
		});
		expect(m.flags).toHaveBeenCalledTimes(2);
		expect(m.flags).toHaveBeenCalledWith(1, { field: "total", kind: "unsure" });
		expect(m.flags).toHaveBeenCalledWith(1, { field: "receipt_number", kind: "not_found" });
	});

	it("reports the pending count and the oldest read's age", async () => {
		const now = Date.parse("2026-11-06T12:00:00Z");
		const aggregate = vi.fn(async () => ({
			_count: { _all: 4 },
			_min: { ocr_started_at: new Date(now - 90_000) },
		}));
		const stats = await pendingReadStats({ field_purchase: { aggregate } } as never, now);
		expect(stats).toEqual({ count: 4, oldestAgeSeconds: 90 });
		expect(aggregate).toHaveBeenCalledWith(
			expect.objectContaining({ where: { ocr_status: "pending" } }),
		);
	});

	it("reports age zero with nothing pending", async () => {
		const aggregate = vi.fn(async () => ({ _count: { _all: 0 }, _min: { ocr_started_at: null } }));
		expect(await pendingReadStats({ field_purchase: { aggregate } } as never)).toEqual({
			count: 0,
			oldestAgeSeconds: 0,
		});
	});
});
