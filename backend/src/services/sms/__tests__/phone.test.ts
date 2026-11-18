import { describe, it, expect } from "vitest";
import { toE164 } from "../phone.js";

describe("toE164", () => {
	it('toE164("(512) 555-0100","US") → "+15125550100"', () => {
		expect(toE164("(512) 555-0100", "US")).toBe("+15125550100");
	});

	it('"555-0100" → null', () => {
		expect(toE164("555-0100", "US")).toBeNull();
	});

	it('"+44…" → null', () => {
		expect(toE164("+44 20 7946 0958", "US")).toBeNull();
		expect(toE164("+447946095800", "CA")).toBeNull();
	});

	it("accepts a leading 1 or +1 and common separators", () => {
		expect(toE164("1-512-555-0100", "US")).toBe("+15125550100");
		expect(toE164("+1 (416) 555-0100", "CA")).toBe("+14165550100");
		expect(toE164("512.555.0100", "CA")).toBe("+15125550100");
	});

	it("drops an extension", () => {
		expect(toE164("512-555-0100 ext. 12", "US")).toBe("+15125550100");
		expect(toE164("512-555-0100 x12", "US")).toBe("+15125550100");
	});

	it("rejects area codes or exchanges starting with 0 or 1, and junk", () => {
		expect(toE164("(012) 555-0100", "US")).toBeNull();
		expect(toE164("(512) 155-0100", "US")).toBeNull();
		expect(toE164("", "US")).toBeNull();
		expect(toE164("call me", "US")).toBeNull();
		expect(toE164("512-555-01000", "US")).toBeNull();
	});
});
