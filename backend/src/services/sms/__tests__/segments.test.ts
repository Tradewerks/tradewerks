import { describe, it, expect } from "vitest";
import { countSegments } from "../segments.js";

describe("countSegments", () => {
	it("160 GSM chars → 1", () => {
		expect(countSegments("a".repeat(160))).toEqual({
			encoding: "GSM-7",
			segments: 1,
		});
	});

	it("161 GSM chars → 2", () => {
		expect(countSegments("a".repeat(161))).toEqual({
			encoding: "GSM-7",
			segments: 2,
		});
	});

	it("70 chars with an emoji → 1 UCS-2", () => {
		const body = "a".repeat(68) + "😀";
		expect(body.length).toBe(70);
		expect(countSegments(body)).toEqual({
			encoding: "UCS-2",
			segments: 1,
		});
	});

	it("71 chars with an emoji → 2 UCS-2", () => {
		const body = "a".repeat(69) + "😀";
		expect(countSegments(body)).toEqual({
			encoding: "UCS-2",
			segments: 2,
		});
	});

	it('"€" counts as 2 GSM chars', () => {
		expect(countSegments("€".repeat(80))).toEqual({
			encoding: "GSM-7",
			segments: 1,
		});
		expect(countSegments("€".repeat(80) + "a")).toEqual({
			encoding: "GSM-7",
			segments: 2,
		});
	});

	it("multi-part messages use 153 GSM / 67 UCS-2 per part", () => {
		expect(countSegments("a".repeat(306)).segments).toBe(2);
		expect(countSegments("a".repeat(307)).segments).toBe(3);
		expect(countSegments("é".repeat(134) + "😀").encoding).toBe("UCS-2");
		expect(countSegments("ж".repeat(134)).segments).toBe(2);
		expect(countSegments("ж".repeat(135)).segments).toBe(3);
	});

	it("never splits an extension pair or a surrogate pair across parts", () => {
		// 152 + "€" would need 154 in the first part, so "€" moves to part 2.
		expect(
			countSegments("a".repeat(152) + "€" + "a".repeat(152)).segments,
		).toBe(3);
		// 66 + emoji would need 68 in the first part.
		expect(
			countSegments("ж".repeat(66) + "😀" + "ж".repeat(66)).segments,
		).toBe(3);
	});

	it('"\\" is a GSM extension char and counts as 2', () => {
		expect(countSegments("\\".repeat(80))).toEqual({
			encoding: "GSM-7",
			segments: 1,
		});
		expect(countSegments("\\".repeat(80) + "a")).toEqual({
			encoding: "GSM-7",
			segments: 2,
		});
	});

	it("an empty body is one GSM segment", () => {
		expect(countSegments("")).toEqual({ encoding: "GSM-7", segments: 1 });
	});
});
