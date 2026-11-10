import { describe, expect, it } from "vitest";
import { isOcrReadStalled, OCR_STALE_MS } from "../ocrRead";

describe("isOcrReadStalled", () => {
	const now = Date.parse("2026-11-06T12:00:00Z");
	const at = (msAgo: number) => new Date(now - msAgo).toISOString();

	it("is false for a read still inside the cutoff", () => {
		expect(isOcrReadStalled({ ocr_status: "pending", updated_at: at(30_000) }, now)).toBe(false);
	});

	it("is true once a pending read passes the cutoff", () => {
		expect(isOcrReadStalled({ ocr_status: "pending", updated_at: at(OCR_STALE_MS) }, now)).toBe(true);
	});

	it("is false for any status but pending", () => {
		expect(isOcrReadStalled({ ocr_status: "failed", updated_at: at(OCR_STALE_MS * 5) }, now)).toBe(false);
		expect(isOcrReadStalled({ ocr_status: "succeeded", updated_at: at(OCR_STALE_MS * 5) }, now)).toBe(false);
	});

	it("is false without a usable timestamp", () => {
		expect(isOcrReadStalled({ ocr_status: "pending", updated_at: null }, now)).toBe(false);
		expect(isOcrReadStalled({ ocr_status: "pending", updated_at: "nope" }, now)).toBe(false);
	});

	it("goes by ocr_started_at, so an edit mid-read does not hide a stall", () => {
		expect(
			isOcrReadStalled(
				{ ocr_status: "pending", ocr_started_at: at(OCR_STALE_MS), updated_at: at(1_000) },
				now,
			),
		).toBe(true);
		expect(
			isOcrReadStalled(
				{ ocr_status: "pending", ocr_started_at: at(1_000), updated_at: at(OCR_STALE_MS * 2) },
				now,
			),
		).toBe(false);
	});

	it("falls back to updated_at when the start was never recorded", () => {
		expect(
			isOcrReadStalled({ ocr_status: "pending", ocr_started_at: null, updated_at: at(OCR_STALE_MS) }, now),
		).toBe(true);
	});
});
