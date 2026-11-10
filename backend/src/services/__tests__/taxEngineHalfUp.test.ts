import { describe, it, expect } from "vitest";
import { calculateDocumentTax } from "../taxEngine.js";
import { allocateHalfUp, roundHalfUpSymmetric, stripFloatNoise } from "../tax/rounding.js";
import { roundingFor, toSnapshotV2 } from "../tax/snapshot.js";
import { ROUNDING_FIXTURES } from "./fixtures/taxRoundingFixtures.js";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("roundHalfUpSymmetric", () => {
	it("rounds half away from zero on both signs", () => {
		expect(roundHalfUpSymmetric(2.5)).toBe(3);
		expect(roundHalfUpSymmetric(-2.5)).toBe(-3);
		expect(roundHalfUpSymmetric(2.4999)).toBe(2);
		expect(roundHalfUpSymmetric(-2.4999)).toBe(-2);
		expect(roundHalfUpSymmetric(49.95)).toBe(50);
		expect(roundHalfUpSymmetric(0)).toBe(0);
	});

	it("is not fooled by float noise just under a true half", () => {
		expect(200 * 0.0725).toBeLessThan(14.5);
		expect(roundHalfUpSymmetric(200 * 0.0725)).toBe(15);
		expect(roundHalfUpSymmetric(-200 * 0.0725)).toBe(-15);
		expect(stripFloatNoise(360 * 0.0875)).toBe(31.5);
	});
});

describe("allocateHalfUp", () => {
	it("always sums exactly to the rounded aggregate, within a cent of each share", () => {
		const rates = [0.05, 0.005, 0.0725, 0.0875, 0.00125, 0.06, 0.1];
		let seed = 7;
		const next = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed;
		};
		for (let trial = 0; trial < 2000; trial++) {
			const n = 1 + (next() % 6);
			const bases = Array.from({ length: n }, () => (next() % 20001) - 10000);
			const rate = rates[next() % rates.length];
			const { total, perLine } = allocateHalfUp(bases, rate);
			expect(sum(perLine)).toBe(total);
			expect(total).toBe(roundHalfUpSymmetric(sum(bases) * rate));
			perLine.forEach((cents, i) => {
				expect(Number.isInteger(cents)).toBe(true);
				expect(Math.abs(cents - bases[i] * rate)).toBeLessThan(1 + 1e-9);
			});
		}
	});

	it("is deterministic and breaks ties toward the earlier line", () => {
		const a = allocateHalfUp([333, 333, 333], 0.05);
		const b = allocateHalfUp([333, 333, 333], 0.05);
		expect(a).toEqual(b);
		expect(a.perLine).toEqual([17, 17, 16]);
	});

	it("handles an empty group", () => {
		expect(allocateHalfUp([], 0.05)).toEqual({ total: 0, perLine: [] });
	});
});

describe("calculateDocumentTax rounding modes — shared fixtures", () => {
	it.each(ROUNDING_FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, f) => {
		const floor = calculateDocumentTax(f.input, f.client_exempt);
		expect(floor.line_item_tax_amounts).toEqual(f.expected.line_floor);
		expect(calculateDocumentTax(f.input, f.client_exempt, undefined, "line_floor")).toEqual(
			floor,
		);

		const half = calculateDocumentTax(
			f.input,
			f.client_exempt,
			undefined,
			"jurisdiction_half_up",
		);
		expect(half.line_item_tax_amounts).toEqual(f.expected.jurisdiction_half_up);
		const groups = Object.fromEntries(
			half.groups_summary.map((g) => [g.group.id, g.tax_amount_cents]),
		);
		expect(groups).toEqual(f.expected.half_up_groups);
		expect(half.total_tax_cents).toBe(sum(Object.values(f.expected.jurisdiction_half_up)));
		expect(half.snapshot.total_tax_cents).toBe(half.total_tax_cents);
		expect(half.total_cents).toBe(
			half.subtotal_cents - half.discount_cents + half.total_tax_cents,
		);
		// Discount allocation and taxable bases are rounding-independent.
		expect(half.discount_cents).toBe(floor.discount_cents);
		expect(half.groups_summary.map((g) => g.taxable_amount_cents)).toEqual(
			floor.groups_summary.map((g) => g.taxable_amount_cents),
		);
	});

	it("gives the same allocation for the same input twice", () => {
		const f = ROUNDING_FIXTURES[1];
		expect(calculateDocumentTax(f.input, false, undefined, "jurisdiction_half_up")).toEqual(
			calculateDocumentTax(f.input, false, undefined, "jurisdiction_half_up"),
		);
	});
});

describe("toSnapshotV2 rounding flag", () => {
	const v1 = calculateDocumentTax(ROUNDING_FIXTURES[0].input, false).snapshot;
	const meta = { source: null, rate_set_id: null, review_reason: null, sourcing: null };

	it("defaults to line_floor", () => {
		expect(toSnapshotV2(v1, meta).rounding).toBe("line_floor");
	});

	it("writes the rounding it is given", () => {
		expect(toSnapshotV2(v1, { ...meta, rounding: "jurisdiction_half_up" }).rounding).toBe(
			"jurisdiction_half_up",
		);
	});
});

describe("roundingFor", () => {
	it("starts a document with no snapshot half-up and keeps any stored line_floor", () => {
		expect(roundingFor(null)).toBe("jurisdiction_half_up");
		expect(roundingFor(undefined)).toBe("jurisdiction_half_up");
		expect(roundingFor({ version: 2, rounding: "jurisdiction_half_up" })).toBe(
			"jurisdiction_half_up",
		);
		expect(roundingFor({ version: 2, rounding: "line_floor" })).toBe("line_floor");
		expect(roundingFor({ version: 1, locked_at: "draft", groups: [] })).toBe("line_floor");
		expect(roundingFor({ locked_at: "draft" })).toBe("line_floor");
	});
});
