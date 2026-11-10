import { describe, expect, test } from "vitest";
import type { TaxSnapshot } from "../../types/tax";
import {
	autoEstimateTax,
	autoTaxEstimate,
	autoTaxableAmount,
	autoTaxableLineCents,
	defaultGroupForMode,
	docKeptEstimate,
	jobKeptSource,
	editorAutoTax,
	isKeptAddressRate,
	keptRateEstimate,
	keptRateOptionLabel,
	effectiveLineGroupId,
	lineTaxPayload,
	ungroupedLineGroup,
} from "../taxEditorMode";

describe("defaultGroupForMode", () => {
	test("stamps nothing until the mode is known", () => {
		expect(defaultGroupForMode(undefined, "g1")).toBeNull();
	});
	test("stamps nothing in auto mode", () => {
		expect(defaultGroupForMode(true, "g1")).toBeNull();
	});
	test("stamps the default group in manual mode", () => {
		expect(defaultGroupForMode(false, "g1")).toBe("g1");
	});
	test("manual mode without a default group stamps nothing", () => {
		expect(defaultGroupForMode(false, null)).toBeNull();
		expect(defaultGroupForMode(false, undefined)).toBeNull();
	});
});

const v2Snapshot = (over: Partial<Record<string, unknown>> = {}) =>
	({
		version: 2,
		locked_at: "draft",
		client_exempt: false,
		source: "ziptax",
		rate_set_id: "g1",
		rounding: "line_floor",
		groups: [
			{
				id: "g1",
				name: "Madison, WI (auto)",
				rates: [
					{ id: "r1", name: "State", rate: 0.05 },
					{ id: "r2", name: "County", rate: 0.005 },
				],
				taxable_amount_cents: 0,
				tax_amount_cents: 0,
			},
		],
		non_taxable_amount_cents: 0,
		total_tax_cents: 0,
		subtotal_cents: 0,
		discount_cents: 0,
		total_cents: 0,
		effective_rate: 0,
		...over,
	}) as unknown as TaxSnapshot;

describe("autoTaxEstimate", () => {
	test("sums the resolved group's rates and strips the (auto) suffix", () => {
		expect(autoTaxEstimate(v2Snapshot(), false)).toEqual({
			rate: 0.055,
			rates: [0.05, 0.005],
			place: "Madison, WI",
			rounding: "line_floor",
		});
	});
	test("carries the snapshot's rounding mode", () => {
		const half = v2Snapshot({ rounding: "jurisdiction_half_up" });
		expect(autoTaxEstimate(half, false)?.rounding).toBe("jurisdiction_half_up");
	});
	test("null when the address changed", () => {
		expect(autoTaxEstimate(v2Snapshot(), true)).toBeNull();
	});
	test("null for v1 snapshots, missing snapshots and missing rate_set_id", () => {
		expect(autoTaxEstimate(v2Snapshot({ version: 1 }), false)).toBeNull();
		expect(autoTaxEstimate(null, false)).toBeNull();
		expect(autoTaxEstimate(v2Snapshot({ rate_set_id: undefined }), false)).toBeNull();
		expect(autoTaxEstimate(v2Snapshot({ rate_set_id: "zzz" }), false)).toBeNull();
	});
});

describe("autoEstimateTax", () => {
	const estimate = (rounding: "line_floor" | "jurisdiction_half_up") => ({
		rate: 0.055,
		rates: [0.05, 0.005],
		place: "Madison, WI",
		rounding,
	});
	test("line_floor floors the combined rate on the base (unchanged)", () => {
		expect(autoEstimateTax(9.99, estimate("line_floor"))).toBe(0.54);
	});
	test("jurisdiction_half_up rounds each rate once on the aggregate, like the engine", () => {
		// 49.95 → 50 and 4.995 → 5
		expect(autoEstimateTax(9.99, estimate("jurisdiction_half_up"))).toBe(0.55);
		expect(autoEstimateTax(-9.99, estimate("jurisdiction_half_up"))).toBe(-0.55);
	});
});

describe("autoTaxableAmount", () => {
	test("pro-rates the discount over ungrouped taxable lines only", () => {
		expect(
			autoTaxableAmount(
				[
					{ total: 100, taxable: true, tax_group_id: null },
					{ total: 50, taxable: true, tax_group_id: "g1" },
					{ total: 50, taxable: false, tax_group_id: null },
				],
				20,
			),
		).toBe(90);
	});
	test("zero with no eligible lines", () => {
		expect(autoTaxableAmount([{ total: 10, taxable: false, tax_group_id: null }], 0)).toBe(0);
		expect(autoTaxableAmount([], 5)).toBe(0);
	});
});

describe("lineTaxPayload", () => {
	test("a line moved back to Auto sends an explicit null so the saved group is cleared", () => {
		expect(lineTaxPayload({ taxable: true, tax_group_id: null })).toEqual({
			taxable: true,
			tax_group_id: null,
		});
		expect(lineTaxPayload({ taxable: true, tax_group_id: undefined })).toEqual({
			taxable: true,
			tax_group_id: null,
		});
	});
	test("No Tax and grouped lines pass through", () => {
		expect(lineTaxPayload({ taxable: false, tax_group_id: null })).toEqual({
			taxable: false,
			tax_group_id: null,
		});
		expect(lineTaxPayload({ taxable: true, tax_group_id: "g1" })).toEqual({
			taxable: true,
			tax_group_id: "g1",
		});
	});
});

describe("effectiveLineGroupId", () => {
	test("the line's own group wins, then the client's", () => {
		expect(effectiveLineGroupId("line", "client")).toBe("line");
		expect(effectiveLineGroupId(null, "client")).toBe("client");
		expect(effectiveLineGroupId(undefined, null)).toBeNull();
	});
});

describe("ungroupedLineGroup", () => {
	const g = (id: string, name = id) => ({
		id,
		name,
		rates: [],
		taxable_amount_cents: 0,
		tax_amount_cents: 0,
	});
	const snap = (groups: ReturnType<typeof g>[], client_exempt = false) =>
		({ ...v2Snapshot(), groups, client_exempt }) as TaxSnapshot;

	test("is the one group no line names", () => {
		expect(ungroupedLineGroup(snap([g("A"), g("C")]), "manual_override", ["A"])?.id).toBe("C");
	});
	test("is the only group when the client group is also a line's group", () => {
		expect(ungroupedLineGroup(snap([g("A")]), "manual_override", ["A"])?.id).toBe("A");
	});
	test("is null when undecidable, untaxed, or exempt", () => {
		expect(ungroupedLineGroup(snap([g("A"), g("B")]), "manual_override", [])).toBeNull();
		expect(ungroupedLineGroup(snap([g("A")]), null, ["A"])).toBeNull();
		expect(ungroupedLineGroup(snap([g("C")], true), "manual_override", [])).toBeNull();
		expect(ungroupedLineGroup(null, "org_default", [])).toBeNull();
	});
});

describe("kept address rate", () => {
	const keptSnap = (over: Partial<Record<string, unknown>> = {}) =>
		v2Snapshot({ source: "provider", kept_from_auto: true, ...over });
	const laCrosse = () =>
		v2Snapshot({
			source: "provider",
			kept_from_auto: true,
			groups: [
				{
					id: "g1",
					name: "La Crosse, WI (auto)",
					rates: [{ id: "r1", name: "State", rate: 0.055 }],
					taxable_amount_cents: 0,
					tax_amount_cents: 0,
				},
			],
		});

	test("isKeptAddressRate needs a v2 snapshot with a rate set", () => {
		expect(isKeptAddressRate(keptSnap())).toBe(true);
		expect(isKeptAddressRate(v2Snapshot({ source: "provider" }))).toBe(true);
		expect(isKeptAddressRate(v2Snapshot({ source: "manual_override" }))).toBe(false);
		expect(isKeptAddressRate(keptSnap({ source: "manual_override" }))).toBe(false);
		expect(isKeptAddressRate(keptSnap({ rate_set_id: null }))).toBe(false);
		expect(isKeptAddressRate(keptSnap({ version: 1 }))).toBe(false);
		expect(isKeptAddressRate(null)).toBe(false);
	});

	test("keptRateEstimate is non-null only in manual mode with a kept rate", () => {
		expect(keptRateEstimate(keptSnap(), false, false)?.rate).toBeCloseTo(0.055);
		expect(keptRateEstimate(keptSnap(), true, false)).toBeNull();
		expect(keptRateEstimate(keptSnap(), undefined, false)).toBeNull();
		expect(keptRateEstimate(v2Snapshot({ source: "manual_override" }), false, false)).toBeNull();
	});

	test("keptRateOptionLabel", () => {
		const e = keptRateEstimate(laCrosse(), false, false)!;
		expect(keptRateOptionLabel(e)).toBe("Address rate · La Crosse, WI 5.5%");
	});

	test("jobKeptSource reads the job's own snapshot, else its quote's", () => {
		const own = keptSnap();
		const quote = laCrosse();
		expect(jobKeptSource({ tax_snapshot: own, quote: { tax_snapshot: quote } } as never)).toBe(own);
		expect(jobKeptSource({ tax_snapshot: null, quote: { tax_snapshot: quote } } as never)).toBe(
			quote
		);
		expect(jobKeptSource({ tax_snapshot: null, quote: null } as never)).toBeNull();
		expect(jobKeptSource(undefined)).toBeNull();
	});

	test("docKeptEstimate inherits only when the document has no snapshot, rounding as its own", () => {
		const parent = laCrosse();
		const inherited = docKeptEstimate(null, parent, false);
		expect(inherited?.place).toBe("La Crosse, WI");
		expect(inherited?.rounding).toBe("jurisdiction_half_up");
		const nonKeptOwn = v2Snapshot({ source: "manual_override" });
		expect(docKeptEstimate(nonKeptOwn, parent, false)).toBeNull();
		expect(docKeptEstimate(null, parent, true)).toBeNull();
	});

	test("editorAutoTax is non-null in manual mode when kept", () => {
		const lines = [{ total: 420, taxable: true, tax_group_id: null }];
		expect(editorAutoTax(false, lines, 0, keptSnap())).toBeNull();
		expect(editorAutoTax(false, lines, 0, keptSnap(), false, true)?.autoTaxableAmount).toBe(420);
	});
});

describe("autoEstimateTax per-line engine parity", () => {
	const est = (rounding: "line_floor" | "jurisdiction_half_up") => ({
		rate: 0.055,
		rates: [0.05, 0.005],
		place: "X",
		rounding,
	});
	const line = (total: number) => ({ total, taxable: true, tax_group_id: null });

	test("line_floor floors per line and per rate: $1.99 at 5% + 0.5% is $0.09", () => {
		const lines = [line(1.99)];
		expect(autoEstimateTax(1.99, est("line_floor"), autoTaxableLineCents(lines, 0))).toBe(0.09);
	});
	test("three $0.10 lines at 5.5% floor to $0.00", () => {
		const e = { ...est("line_floor"), rates: [0.055], rate: 0.055 };
		const lines = [line(0.1), line(0.1), line(0.1)];
		expect(autoEstimateTax(0.3, e, autoTaxableLineCents(lines, 0))).toBe(0);
	});
	test("uses the discount-allocated base of each line", () => {
		const lines = [line(10), line(10.5)];
		const bases = autoTaxableLineCents(lines, 5);
		expect(bases.reduce((a, b) => a + b, 0)).toBe(1551);
		const expected =
			bases.reduce((s, b) => s + Math.floor(b * 0.05) + Math.floor(b * 0.005), 0) / 100;
		expect(autoEstimateTax(autoTaxableAmount(lines, 5), est("line_floor"), bases)).toBe(expected);
	});
	test("half-up ignores line bases", () => {
		expect(autoEstimateTax(9.99, est("jurisdiction_half_up"), [333, 666])).toBe(0.55);
	});
});
