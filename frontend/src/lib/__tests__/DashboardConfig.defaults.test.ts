import { describe, expect, it } from "vitest";
import { DEFAULT_RESPONSIVE_LAYOUTS, WIDGET_CATALOG } from "../DashboardConfig";

type Box = { i: string; x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) =>
	a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("default dashboard layouts", () => {
	for (const bp of ["lg", "md", "sm"] as const) {
		const items = (DEFAULT_RESPONSIVE_LAYOUTS[bp] ?? []) as Box[];

		it(`${bp} includes the Open Disputes widget`, () => {
			expect(items.some((item) => item.i === "open-disputes")).toBe(true);
		});

		it(`${bp} has no overlapping widgets`, () => {
			for (let i = 0; i < items.length; i++) {
				for (let j = i + 1; j < items.length; j++) {
					expect(overlaps(items[i], items[j]), `${items[i].i} overlaps ${items[j].i}`).toBe(false);
				}
			}
		});

		it(`${bp} only references catalog widgets`, () => {
			for (const item of items) expect(WIDGET_CATALOG[item.i], item.i).toBeDefined();
		});
	}

	it("gates Open Disputes on either document view permission", () => {
		expect(WIDGET_CATALOG["open-disputes"].requiredAnyPermission).toEqual(["view_quotes", "view_invoices"]);
	});
});
