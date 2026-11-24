import { describe, it, expect } from "vitest";
import { Prisma } from "../../../generated/prisma/client.js";
import {
	centsToDollars,
	isWholeCents,
	moneyAmount,
	sumCents,
	toCents,
} from "../money.js";

describe("toCents", () => {
	it("toCents of 1.1 + 2.2 equals toCents of 3.3", () => {
		expect(toCents(1.1) + toCents(2.2)).toBe(toCents(3.3));
		expect(toCents(3.3)).toBe(330);
	});

	it("toCents reads a Prisma.Decimal by its string, not a float", () => {
		expect(toCents(new Prisma.Decimal("1234.56"))).toBe(123456);
		// 1234.56 survives a float detour too (Math.round(1234.56 * 100) is
		// 123456), so it can't tell the paths apart; 1.005 can — its float
		// * 100 is 100.49999…, which a float path would round to 100.
		expect(toCents(new Prisma.Decimal("1.005"))).toBe(101);
		expect(toCents(new Prisma.Decimal("-42.10"))).toBe(-4210);
		expect(toCents(new Prisma.Decimal("99999999.99"))).toBe(9999999999);
	});

	it("toCents throws on NaN and Infinity instead of returning them", () => {
		expect(() => toCents(Number.NaN)).toThrow();
		expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow();
		expect(() => toCents(Number.NEGATIVE_INFINITY)).toThrow();
		expect(() => toCents(new Prisma.Decimal(Number.NaN))).toThrow();
		expect(() => toCents(new Prisma.Decimal("Infinity"))).toThrow();
		expect(() => toCents(new Prisma.Decimal("-Infinity"))).toThrow();
	});

	it("toCents treats null and undefined as zero", () => {
		expect(toCents(null)).toBe(0);
		expect(toCents(undefined)).toBe(0);
	});

	it("toCents reads numeric strings exactly", () => {
		expect(toCents("19.99")).toBe(1999);
		expect(toCents("0.07")).toBe(7);
		expect(toCents("-0.00")).toBe(0);
		expect(Object.is(toCents("-0.00"), -0)).toBe(false);
	});
});

describe("sumCents", () => {
	it("sumCents of ten 0.10 payments is 100", () => {
		expect(sumCents(Array.from({ length: 10 }, () => 0.1))).toBe(100);
	});

	it("sums mixed inputs", () => {
		expect(
			sumCents([new Prisma.Decimal("10.01"), "5.50", 0.49, null]),
		).toBe(1600);
		expect(sumCents([])).toBe(0);
	});
});

describe("isWholeCents", () => {
	it("isWholeCents accepts 19.99 and 0.07 and rejects 100.005 and 0.001", () => {
		expect(isWholeCents(19.99)).toBe(true);
		expect(isWholeCents(0.07)).toBe(true);
		expect(isWholeCents(100.005)).toBe(false);
		expect(isWholeCents(0.001)).toBe(false);
		expect(isWholeCents(1e-3)).toBe(false);
	});
});

describe("centsToDollars", () => {
	it("converts integer cents back to dollars", () => {
		expect(centsToDollars(123456)).toBe(1234.56);
	});
});

describe("moneyAmount", () => {
	const schema = moneyAmount("Must be positive");

	it("keeps the caller's positive message", () => {
		const r = schema.safeParse(0);
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toBe("Must be positive");
	});

	it("rejects a third decimal place with the two-decimal message", () => {
		const r = schema.safeParse(0.001);
		expect(r.success).toBe(false);
		expect(r.error?.issues[0]?.message).toBe(
			"Amounts can have at most two decimal places",
		);
	});

	it("passes a whole-cent amount through unchanged", () => {
		expect(schema.parse(19.99)).toBe(19.99);
	});
});
