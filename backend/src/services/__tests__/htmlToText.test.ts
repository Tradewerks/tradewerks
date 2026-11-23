import { describe, it, expect } from "vitest";
import { htmlToText } from "../htmlToText.js";

describe("htmlToText", () => {
	it("htmlToText turns &middot; into a middle dot", () => {
		expect(htmlToText("<p>a &middot; b</p>")).toBe("a \u00b7 b");
	});
});
