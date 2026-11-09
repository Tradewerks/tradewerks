import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindMany = vi.fn();
const mockUpdateMany = vi.fn();
vi.mock("../../db.js", () => ({
	db: {
		field_purchase: {
			findMany: (...a: unknown[]) => mockFindMany(...a),
			updateMany: (...a: unknown[]) => mockUpdateMany(...a),
		},
	},
}));

const mockRun = vi.fn();
vi.mock("../../controllers/fieldPurchasesController.js", () => ({
	READ_STALLED: "stalled copy",
	runReceiptOcr: (...args: unknown[]) => mockRun(...args),
}));
const mockGetBuffer = vi.fn();
vi.mock("../wasabiService.js", () => ({ getBuffer: (...a: unknown[]) => mockGetBuffer(...a) }));
const mockEmit = vi.fn();
vi.mock("../socketService.js", () => ({ emitToOrg: (...a: unknown[]) => mockEmit(...a) }));
vi.mock("../appLogger.js", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const mockProvider = vi.fn();
vi.mock("../receiptOcr/index.js", async () => {
	const normalize = await import("../receiptOcr/normalize.js");
	return { ...normalize, getReceiptOcrProvider: () => mockProvider() };
});
const mockRead = vi.fn();
vi.mock("../receiptOcr/ocrMetrics.js", () => ({
	ocrMetrics: { read: (...a: unknown[]) => mockRead(...a) },
	registerOcrPendingGauges: vi.fn(),
}));

import { sweepStalledReads } from "../receiptOcrSweeper.js";
import { OCR_STALE_MS } from "../receiptOcr/normalize.js";

const NOW = new Date("2026-11-06T12:00:00Z");
const STARTED = new Date(NOW.getTime() - OCR_STALE_MS - 1_000);

function stale(over: Record<string, unknown> = {}) {
	return {
		id: "fp-1",
		organization_id: "org-1",
		status: "draft",
		receipt_image_url: "https://bucket/receipts/r.jpg",
		receipt_image_hash: "hash-a",
		ocr_started_at: STARTED,
		ocr_attempts: 1,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	delete process.env.OCR_MAX_ATTEMPTS;
	mockProvider.mockReturnValue({ name: "textract", extract: vi.fn() });
	mockGetBuffer.mockResolvedValue({ buffer: Buffer.from("img"), contentType: "image/jpeg" });
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockRun.mockResolvedValue(undefined);
});

describe("sweepStalledReads", () => {
	it("asks only for reads pending past the stale cutoff, legacy rows included", async () => {
		mockFindMany.mockResolvedValue([]);
		await sweepStalledReads(NOW);
		const cutoff = new Date(NOW.getTime() - OCR_STALE_MS);
		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					ocr_status: "pending",
					OR: [
						{ ocr_started_at: { lt: cutoff } },
						{ ocr_started_at: null, updated_at: { lt: cutoff } },
					],
				},
				take: 20,
			}),
		);
	});

	it("claims a stale row by compare-and-set, then re-runs it as a recovery", async () => {
		mockFindMany.mockResolvedValue([stale()]);
		expect(await sweepStalledReads(NOW)).toBe(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: "fp-1", ocr_status: "pending", ocr_started_at: STARTED },
			data: { ocr_started_at: NOW, ocr_attempts: { increment: 1 } },
		});
		expect(mockGetBuffer).toHaveBeenCalledWith("https://bucket/receipts/r.jpg");
		expect(mockRun).toHaveBeenCalledWith(
			"org-1",
			"fp-1",
			{ buffer: Buffer.from("img"), mimetype: "image/jpeg", filename: "receipt" },
			"hash-a",
			{ recovery: true },
		);
	});

	it("skips a row another instance or a Try again claimed first", async () => {
		mockFindMany.mockResolvedValue([stale()]);
		mockUpdateMany.mockResolvedValue({ count: 0 });
		expect(await sweepStalledReads(NOW)).toBe(0);
		expect(mockGetBuffer).not.toHaveBeenCalled();
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("gives up at the attempt cap with the stalled copy, and counts it abandoned", async () => {
		mockFindMany.mockResolvedValue([stale({ ocr_attempts: 3 })]);
		expect(await sweepStalledReads(NOW)).toBe(0);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: "fp-1", ocr_status: "pending", ocr_started_at: STARTED },
			data: { ocr_status: "failed", ocr_error: "stalled copy", ocr_completed_at: NOW },
		});
		expect(mockRead).toHaveBeenCalledWith("textract", "abandoned");
		expect(mockEmit).toHaveBeenCalledWith("org-1", "field_purchase:ocr", { id: "fp-1", status: "failed" });
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("reads the cap from OCR_MAX_ATTEMPTS", async () => {
		process.env.OCR_MAX_ATTEMPTS = "5";
		mockFindMany.mockResolvedValue([stale({ ocr_attempts: 3 })]);
		expect(await sweepStalledReads(NOW)).toBe(1);
	});

	it("does not count an abandon another instance already made", async () => {
		mockFindMany.mockResolvedValue([stale({ ocr_attempts: 3 })]);
		mockUpdateMany.mockResolvedValue({ count: 0 });
		await sweepStalledReads(NOW);
		expect(mockRead).not.toHaveBeenCalled();
		expect(mockEmit).not.toHaveBeenCalled();
	});

	it("fails a read whose purchase left the technician's hands, without a provider call", async () => {
		mockFindMany.mockResolvedValue([stale({ status: "pending_review" })]);
		await sweepStalledReads(NOW);
		expect(mockUpdateMany.mock.calls[0][0].data).toMatchObject({
			ocr_status: "failed",
			ocr_error: "The purchase moved on before the receipt was read",
		});
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("fails pending reads once no provider is configured", async () => {
		mockProvider.mockReturnValue(null);
		mockFindMany.mockResolvedValue([stale()]);
		await sweepStalledReads(NOW);
		expect(mockUpdateMany.mock.calls[0][0].data.ocr_status).toBe("failed");
		expect(mockRead).toHaveBeenCalledWith("none", "abandoned");
	});

	it("leaves a claimed row for the next sweep when storage fails", async () => {
		mockFindMany.mockResolvedValue([stale()]);
		mockGetBuffer.mockRejectedValue(new Error("wasabi down"));
		expect(await sweepStalledReads(NOW)).toBe(0);
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockRun).not.toHaveBeenCalled();
	});

	it("keeps sweeping past a row that throws", async () => {
		mockFindMany.mockResolvedValue([stale({ id: "fp-1" }), stale({ id: "fp-2" })]);
		mockUpdateMany.mockRejectedValueOnce(new Error("db blip")).mockResolvedValue({ count: 1 });
		expect(await sweepStalledReads(NOW)).toBe(1);
		expect(mockRun).toHaveBeenCalledWith("org-1", "fp-2", expect.anything(), "hash-a", { recovery: true });
	});

	it("claims a legacy row by its null start time", async () => {
		mockFindMany.mockResolvedValue([stale({ ocr_started_at: null })]);
		await sweepStalledReads(NOW);
		expect(mockUpdateMany.mock.calls[0][0].where).toEqual({
			id: "fp-1",
			ocr_status: "pending",
			ocr_started_at: null,
		});
	});
});
