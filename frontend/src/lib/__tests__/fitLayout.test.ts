import { describe, expect, it } from "vitest";
import { fitLayout, stackLayout } from "../gridLayoutEngine";
import { DEFAULT_LAYOUT, WIDGET_CATALOG } from "../DashboardConfig";

const emptyCells = (layout: readonly { w: number; h: number; y: number }[], cols: number) =>
	cols * Math.max(...layout.map(w => w.y + w.h)) - layout.reduce((s, w) => s + w.w * w.h, 0);

// Tallest widgets last, so packing in this order strands holes beside them.
const messy = [...DEFAULT_LAYOUT]
	.sort((a, b) => a.h - b.h)
	.map((w, k) => ({ ...w, x: 0, y: k * 10 }));

describe("fitLayout", () => {
	it("leaves no empty cells for the default dashboard at 12 columns", () => {
		expect(emptyCells(fitLayout(WIDGET_CATALOG, DEFAULT_LAYOUT, 12), 12)).toBe(0);
	});

	it("leaves no empty cells when starting from a badly ordered layout", () => {
		expect(emptyCells(fitLayout(WIDGET_CATALOG, messy, 12), 12)).toBe(0);
	});

	it("keeps every widget inside the grid without overlaps", () => {
		for (const cols of [12, 8, 4]) {
			const out = fitLayout(WIDGET_CATALOG, messy, cols);
			expect(out).toHaveLength(messy.length);
			for (const a of out) {
				expect(a.x + a.w).toBeLessThanOrEqual(cols);
				for (const b of out) {
					if (a === b) continue;
					const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
					expect(overlap).toBe(false);
				}
			}
		}
	});
});

describe("stackLayout", () => {
	it("stacks widgets full width in top-to-bottom, left-to-right order", () => {
		const out = stackLayout(DEFAULT_LAYOUT, 8);
		expect(out.map(w => w.i).slice(0, 2)).toEqual(["week-strip", "arrivals"]);
		expect(out.every(w => w.x === 0 && w.w === 8)).toBe(true);
		expect(emptyCells(out, 8)).toBe(0);
	});
});
