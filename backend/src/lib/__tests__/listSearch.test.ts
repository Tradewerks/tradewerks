import { describe, it, expect } from "vitest";
import { andOfOrs, enumListParam, searchTerms, singleParam } from "../listSearch.js";
import { ListQueryError } from "../listQuery.js";

describe("searchTerms", () => {
	it("splits on whitespace and caps at 5", () => {
		expect(searchTerms("  john   smith ")).toEqual(["john", "smith"]);
		expect(searchTerms("a b c d e f g")).toEqual(["a", "b", "c", "d", "e"]);
		expect(searchTerms(undefined)).toEqual([]);
		expect(searchTerms("   ")).toEqual([]);
	});
});

describe("andOfOrs", () => {
	it("builds one OR clause per term inside an AND", () => {
		expect(andOfOrs("ab cd", (t) => [{ x: t }, { y: t }])).toEqual({
			AND: [
				{ OR: [{ x: "ab" }, { y: "ab" }] },
				{ OR: [{ x: "cd" }, { y: "cd" }] },
			],
		});
	});
	it("is undefined with nothing to search", () => {
		expect(andOfOrs("", () => [])).toBeUndefined();
	});
});

describe("enumListParam", () => {
	const values = ["High", "Low"] as const;
	it("parses a comma list", () => {
		expect(enumListParam({ p: "High, Low" }, "p", values)).toEqual(["High", "Low"]);
		expect(enumListParam({}, "p", values)).toBeUndefined();
		expect(enumListParam({ p: "" }, "p", values)).toBeUndefined();
	});
	it("throws ListQueryError for a bad value or a repeated param", () => {
		expect(() => enumListParam({ p: "Huge" }, "p", values)).toThrow(ListQueryError);
		expect(() => enumListParam({ p: ["High", "Low"] }, "p", values)).toThrow(ListQueryError);
	});
});

describe("singleParam", () => {
	it("trims and rejects repeats", () => {
		expect(singleParam({ c: " x " }, "c")).toBe("x");
		expect(singleParam({ c: " " }, "c")).toBeUndefined();
		expect(() => singleParam({ c: ["a", "b"] }, "c")).toThrow(ListQueryError);
	});
});
