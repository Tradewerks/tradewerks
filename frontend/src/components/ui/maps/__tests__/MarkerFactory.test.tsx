import { describe, expect, test } from "vitest";
import CreateMarker from "../MarkerFactory";
import type { MarkerTypeValue } from "../../../../types/location";

const at = { lat: 43.8, lon: -91.2 };

describe("CreateMarker", () => {
	test.each<MarkerTypeValue>(["CLIENT", "TECHNICIAN", "SITE", "WAREHOUSE"])(
		"%s renders an icon",
		(type) => {
			const el = CreateMarker({ id: "m", type, coords: at });
			expect(el.querySelector("svg")).not.toBeNull();
		},
	);

	test("site and office are visually distinct", () => {
		expect(CreateMarker({ id: "s", type: "SITE", coords: at }).innerHTML).toContain("bg-primary");
		expect(CreateMarker({ id: "o", type: "WAREHOUSE", coords: at }).innerHTML).toContain(
			"bg-neutral",
		);
	});
});
