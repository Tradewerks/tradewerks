import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import {
	calculateMultiGroupTax,
	useFinancialCalculations,
	type LineItemForCalc,
} from "../../hooks/forms/useFinancialCalculations";
import type { TaxGroup, TaxSnapshot } from "../../types/tax";
import {
	roundHalfUpSymmetric,
	jobRounding,
	roundingFor,
	snapshotRateCents,
	stripFloatNoise,
} from "../taxRounding";
import { ROUNDING_FIXTURES, type RoundingFixture } from "./fixtures/taxRoundingFixtures";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

type FixtureGroup = NonNullable<RoundingFixture["input"]["line_items"][number]["tax_group"]>;

function toTaxGroup(g: FixtureGroup): TaxGroup {
	return {
		id: g.id,
		organization_id: "org",
		name: g.name,
		description: null,
		is_default: false,
		is_active: true,
		rates: g.rates.map((r, i) => ({
			id: `${g.id}-${r.id}`,
			sort_order: i,
			tax_rate: {
				id: r.id,
				organization_id: "org",
				name: r.name,
				rate: r.rate,
				description: null,
				jurisdiction: null,
				is_default: false,
				is_active: true,
				created_at: "",
				updated_at: "",
			},
		})),
		combined_rate: g.rates.reduce((s, r) => s + r.rate, 0),
		created_at: "",
		updated_at: "",
	};
}

function toCalc(f: RoundingFixture) {
	const groups = new Map<string, TaxGroup>();
	const lines: LineItemForCalc[] = f.input.line_items.map((l) => {
		if (l.tax_group && !groups.has(l.tax_group.id)) {
			groups.set(l.tax_group.id, toTaxGroup(l.tax_group));
		}
		return {
			id: l.id,
			total: l.total_cents / 100,
			taxable: l.taxable,
			tax_group_id: l.tax_group?.id ?? null,
		};
	});
	return {
		lines,
		groups: [...groups.values()],
		discountType: f.input.discount_type,
		discountValue: f.input.discount_value,
	};
}

describe("roundHalfUpSymmetric", () => {
	it("rounds half away from zero on both signs", () => {
		expect(roundHalfUpSymmetric(2.5)).toBe(3);
		expect(roundHalfUpSymmetric(-2.5)).toBe(-3);
		expect(roundHalfUpSymmetric(2.4999)).toBe(2);
		expect(roundHalfUpSymmetric(-2.4999)).toBe(-2);
		expect(roundHalfUpSymmetric(49.95)).toBe(50);
		expect(Object.is(roundHalfUpSymmetric(-0.3), 0)).toBe(true);
	});

	it("is not fooled by float noise just under a true half", () => {
		expect(200 * 0.0725).toBeLessThan(14.5);
		expect(roundHalfUpSymmetric(200 * 0.0725)).toBe(15);
		expect(roundHalfUpSymmetric(-200 * 0.0725)).toBe(-15);
		expect(stripFloatNoise(360 * 0.0875)).toBe(31.5);
	});
});

describe("roundingFor", () => {
	it("mirrors the backend: no snapshot is half-up, only an explicit flag keeps half-up", () => {
		expect(roundingFor(null)).toBe("jurisdiction_half_up");
		expect(roundingFor(undefined)).toBe("jurisdiction_half_up");
		const v1 = { version: 1 } as unknown as TaxSnapshot;
		const floor = { version: 2, rounding: "line_floor" } as unknown as TaxSnapshot;
		const half = { version: 2, rounding: "jurisdiction_half_up" } as unknown as TaxSnapshot;
		expect(roundingFor(v1)).toBe("line_floor");
		expect(roundingFor(floor)).toBe("line_floor");
		expect(roundingFor(half)).toBe("jurisdiction_half_up");
	});
});

describe("calculateMultiGroupTax rounding modes — shared fixtures (backend parity)", () => {
	it.each(ROUNDING_FIXTURES.map((f) => [f.name, f] as const))("%s", (_name, f) => {
		const { lines, groups, discountType, discountValue } = toCalc(f);
		const run = (rounding?: "line_floor" | "jurisdiction_half_up") =>
			calculateMultiGroupTax(
				lines,
				groups,
				discountType,
				discountValue,
				f.client_exempt,
				rounding
			);

		const groupCents = (r: ReturnType<typeof run>) =>
			Object.fromEntries(
				r.groups_summary.map((g) => [g.group.id, Math.round(g.tax_amount * 100)])
			);
		// Per-line floor cents, summed per group the way the engine taxes them.
		const groupIds = new Set(groups.map((g) => g.id));
		const floorGroups: Record<string, number> = {};
		if (!f.client_exempt) {
			for (const l of lines) {
				if (!l.taxable || !l.tax_group_id || !groupIds.has(l.tax_group_id)) continue;
				floorGroups[l.tax_group_id] =
					(floorGroups[l.tax_group_id] ?? 0) + f.expected.line_floor[l.id];
			}
		}

		const floor = run();
		expect(groupCents(floor)).toEqual(floorGroups);
		expect(Math.round(floor.total_tax * 100)).toBe(sum(Object.values(f.expected.line_floor)));
		expect(run("line_floor")).toEqual(floor);

		const half = run("jurisdiction_half_up");
		expect(groupCents(half)).toEqual(f.expected.half_up_groups);
		expect(Math.round(half.total_tax * 100)).toBe(
			sum(Object.values(f.expected.jurisdiction_half_up))
		);
	});
});

describe("useFinancialCalculations rounding option", () => {
	const f = ROUNDING_FIXTURES[0];
	const { lines, groups } = toCalc(f);

	it("defaults to line_floor", () => {
		const { result } = renderHook(() =>
			useFinancialCalculations(9.99, { taxGroups: groups, lineItemsForCalc: lines })
		);
		expect(result.current.totalTax).toBe(0.48);
		expect(result.current.resolvedTotal).toBe(10.47);
	});

	it("applies jurisdiction_half_up when asked", () => {
		const { result } = renderHook(() =>
			useFinancialCalculations(9.99, {
				taxGroups: groups,
				lineItemsForCalc: lines,
				rounding: "jurisdiction_half_up",
			})
		);
		expect(result.current.totalTax).toBe(0.5);
		expect(result.current.resolvedTotal).toBe(10.49);
	});
});

describe("snapshotRateCents (mirrors reportsController tax-liability split)", () => {
	const group = (base: number, total: number, ...rates: number[]) => ({
		rates: rates.map((rate) => ({ rate })),
		taxable_amount_cents: base,
		tax_amount_cents: total,
	});

	it("half-up reproduces the stored per-rate split", () => {
		// 999 at 5% + 0.5%: 49.95 → 50 and 4.995 → 5 (bare floor would show 49 / 6)
		expect(snapshotRateCents(group(999, 55, 0.05, 0.005), "jurisdiction_half_up")).toEqual([
			50, 5,
		]);
	});

	it("half-up rounds a negative half away from zero", () => {
		// -50 x 5% = -2.5 → -3; bare Math.round would give -2
		expect(snapshotRateCents(group(-50, -3, 0.05), "jurisdiction_half_up")).toEqual([-3]);
	});

	it("half-up is not fooled by float noise", () => {
		// 200 x 7.25% evaluates to 14.499999999999998; bare Math.round would give 14
		expect(snapshotRateCents(group(200, 15, 0.0725), "jurisdiction_half_up")).toEqual([15]);
	});

	it("line_floor floors each rate and puts the remainder on the last", () => {
		// Lines 333 x 3 floored per line: 16 x 3 + 1 x 3 = 51; aggregate floor 49 + 4 → 49 / 2
		expect(snapshotRateCents(group(999, 51, 0.05, 0.005), "line_floor")).toEqual([49, 2]);
	});
});

describe("calculateMultiGroupTax discount cents (backend dollarsToCents parity)", () => {
	const { lines, groups } = toCalc(ROUNDING_FIXTURES[0]);

	it("an amount discount of $0.29 is 29 cents, not 28", () => {
		expect(0.29 * 100).toBeLessThan(29);
		expect(calculateMultiGroupTax(lines, groups, "amount", 0.29, false).discount_amount).toBe(
			0.29
		);
	});

	it("a percent discount multiplies before dividing, as the engine does", () => {
		// 100c at 57%: 100 * (57 / 100) = 56.99999999999999 but (100 * 57) / 100 = 57
		const one = [{ id: "a", total: 1, taxable: false, tax_group_id: null }];
		expect(calculateMultiGroupTax(one, groups, "percent", 57, false).discount_amount).toBe(
			0.57
		);
	});

	it("no discount on a zero or negative subtotal", () => {
		const credit = [{ id: "a", total: -10, taxable: false, tax_group_id: null }];
		expect(calculateMultiGroupTax(credit, groups, "amount", 5, false).discount_amount).toBe(0);
	});
});

describe("jobRounding", () => {
	it("manual-mode EditJob with a null snapshot stays line_floor", () => {
		expect(jobRounding(false, null, false)).toBe("line_floor");
	});
	it("EditJob holds line_floor while the mode is loading", () => {
		expect(jobRounding(undefined, null, false)).toBe("line_floor");
	});
	it("auto-mode EditJob with a null snapshot is half-up; a floor snapshot stays floor", () => {
		expect(jobRounding(true, null, false)).toBe("jurisdiction_half_up");
		expect(jobRounding(true, { rounding: "line_floor" } as unknown as TaxSnapshot, false)).toBe(
			"line_floor"
		);
	});
	it("a manual-mode job holding a kept address rate rounds as its kept snapshot", () => {
		const halfUp = { rounding: "jurisdiction_half_up" } as unknown as TaxSnapshot;
		const floor = { rounding: "line_floor" } as unknown as TaxSnapshot;
		expect(jobRounding(false, halfUp, false, true)).toBe("jurisdiction_half_up");
		expect(jobRounding(false, floor, false, true)).toBe("line_floor");
		expect(jobRounding(false, halfUp, false, false)).toBe("line_floor");
		expect(jobRounding(false, halfUp, false)).toBe("line_floor");
	});
	it("manual CreateJob is line_floor; auto or loading CreateJob is half-up", () => {
		expect(jobRounding(false, null, true)).toBe("line_floor");
		expect(jobRounding(true, null, true)).toBe("jurisdiction_half_up");
		expect(jobRounding(undefined, null, true)).toBe("jurisdiction_half_up");
	});
});
