import { describe, expect, it } from "vitest";
import { resolveConstraints } from "../gridLayoutEngine";

const catalog = {
	w: {
		label: "W", defaultW: 4, defaultH: 4, minW: 3, maxW: 6,
		responsiveConstraints: [
			{ atWidth: 800, minW: 4 },
			{ atWidth: 500, minW: 2 },
		],
	},
};

describe("resolveConstraints", () => {
	it("uses the narrowest threshold that covers the width", () => {
		expect(resolveConstraints(catalog, "w", 1200).minW).toBe(3);
		expect(resolveConstraints(catalog, "w", 700).minW).toBe(4);
		expect(resolveConstraints(catalog, "w", 400).minW).toBe(2);
		expect(resolveConstraints(catalog, "w", 400).maxW).toBe(6);
	});
});
