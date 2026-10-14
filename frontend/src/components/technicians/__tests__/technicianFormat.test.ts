import { describe, it, expect } from "vitest";
import {
	formatHireDate,
	formatLastLogin,
	formatPhone,
	formatTenure,
	initials,
} from "../technicianFormat";

const NOW = new Date("2026-09-25T12:00:00").getTime();

describe("formatLastLogin", () => {
	it.each([
		[null, "Never"],
		["not a date", "Never"],
		[new Date(NOW - 2 * 60_000).toISOString(), "Just now"],
		[new Date(NOW - 30 * 60_000).toISOString(), "30m ago"],
		[new Date(NOW - 5 * 3_600_000).toISOString(), "5h ago"],
		[new Date(NOW - 3 * 86_400_000).toISOString(), "3d ago"],
	])("%s → %s", (raw, expected) => {
		expect(formatLastLogin(raw, NOW)).toBe(expected);
	});
});

describe("formatPhone", () => {
	it.each([
		["6082550102", "(608) 255-0102"],
		["16082550102", "+1 (608) 255-0102"],
		["(608) 255-0102", "(608) 255-0102"],
		["+44 20 7946 0958", "+44 20 7946 0958"],
		["", null],
		[null, null],
	])("%s → %s", (raw, expected) => {
		expect(formatPhone(raw)).toBe(expected);
	});
});

describe("formatHireDate", () => {
	it("uses the short month form", () => {
		expect(formatHireDate("2020-06-30T12:00:00")).toBe("Jun 30, 2020");
	});
});

describe("formatTenure", () => {
	const now = new Date("2026-09-25T12:00:00");
	it.each([
		["2026-03-01T12:00:00", "< 1 yr"],
		["2025-09-25T12:00:00", "1 yr"],
		["2020-06-30T12:00:00", "6 yrs"],
	])("%s → %s", (hire, expected) => {
		expect(formatTenure(hire, now)).toBe(expected);
	});
});

describe("initials", () => {
	it.each([
		["Maria Rodriguez", "MR"],
		["Cher", "C"],
		["  ", "?"],
		["ana maria de la cruz", "AC"],
	])("%s → %s", (name, expected) => {
		expect(initials(name)).toBe(expected);
	});
});
