import { describe, expect, it } from "vitest";
import { smsSegments } from "../smsSegments";

describe("smsSegments", () => {
	it("counts a plain GSM-7 message of up to 160 characters as one segment", () => {
		expect(smsSegments("a".repeat(160))).toMatchObject({
			encoding: "GSM-7",
			segments: 1,
		});
		expect(smsSegments("a".repeat(161))).toMatchObject({
			segments: 2,
			perSegment: 153,
		});
		expect(smsSegments("a".repeat(306)).segments).toBe(2);
		expect(smsSegments("a".repeat(307)).segments).toBe(3);
	});

	it("counts GSM extension characters twice", () => {
		expect(smsSegments("[]").length).toBe(4);
		expect(smsSegments("€".repeat(81)).segments).toBe(2);
	});

	it("switches to UCS-2 at 70 and 67 per segment when a character is outside GSM-7", () => {
		expect(smsSegments("é".repeat(5) + "—")).toMatchObject({
			encoding: "UCS-2",
			segments: 1,
		});
		expect(smsSegments("—".repeat(70)).segments).toBe(1);
		expect(smsSegments("—".repeat(71))).toMatchObject({ segments: 2, perSegment: 67 });
		expect(smsSegments("😀")).toMatchObject({ encoding: "UCS-2", length: 2 });
	});

	// Same vectors as backend/src/services/sms/__tests__/segments.test.ts.
	it("matches the backend counter", () => {
		expect(smsSegments("a".repeat(68) + "😀")).toMatchObject({
			encoding: "UCS-2",
			segments: 1,
		});
		expect(smsSegments("a".repeat(69) + "😀").segments).toBe(2);
		expect(smsSegments("€".repeat(80))).toMatchObject({
			encoding: "GSM-7",
			segments: 1,
		});
		expect(smsSegments("€".repeat(80) + "a").segments).toBe(2);
		expect(smsSegments("\\".repeat(80))).toMatchObject({
			encoding: "GSM-7",
			segments: 1,
		});
		expect(smsSegments("\\".repeat(80) + "a").segments).toBe(2);
		expect(smsSegments("ж".repeat(134)).segments).toBe(2);
		expect(smsSegments("ж".repeat(135)).segments).toBe(3);
	});

	it("never splits an extension pair or a surrogate pair across parts", () => {
		expect(smsSegments("a".repeat(152) + "€" + "a".repeat(152)).segments).toBe(3);
		expect(smsSegments("ж".repeat(66) + "😀" + "ж".repeat(66)).segments).toBe(3);
	});

	it("reports zero segments for an empty body", () => {
		expect(smsSegments("").segments).toBe(0);
	});
});
