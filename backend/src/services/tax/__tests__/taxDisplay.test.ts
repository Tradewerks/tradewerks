import { describe, expect, it } from "vitest";
import {
	collapseSnapshotRates,
	jurisdictionLabel,
	pdfTaxRows,
	taxBasisLine,
} from "../taxDisplay.js";
import type { AnyTaxSnapshot } from "../snapshot.js";

type Rate = { id: string; name: string; rate: number; jurisdiction_type?: string };

const base = {
	locked_at: "draft",
	client_exempt: false,
	non_taxable_amount_cents: 0,
	total_tax_cents: 0,
	subtotal_cents: 0,
	discount_cents: 0,
	total_cents: 0,
	effective_rate: 0,
};

const r = (id: string, name: string, rate: number, jurisdiction_type?: string): Rate => ({
	id,
	name,
	rate,
	jurisdiction_type,
});

const v2 = (
	rates: Rate[],
	name = "Madison, WI (auto)",
	tax_amount_cents = 0,
	rounding: "line_floor" | "jurisdiction_half_up" = "line_floor"
) =>
	({
		...base,
		version: 2,
		source: "provider",
		rounding,
		groups: [{ id: "g1", name, rates, taxable_amount_cents: 10000, tax_amount_cents }],
	}) as unknown as Extract<AnyTaxSnapshot, { version: 2 }>;

// Copied verbatim from frontend/src/lib/__tests__/taxBreakdown.test.ts
const JURISDICTION_CASES: [{ name: string; jurisdiction_type?: string }, string][] = [
	[{ name: "WI", jurisdiction_type: "state" }, "Wisconsin state"],
	[{ name: "WISCONSIN", jurisdiction_type: "state" }, "Wisconsin state"],
	[{ name: "LA CROSSE", jurisdiction_type: "county" }, "La Crosse County"],
	[{ name: "Fixture County", jurisdiction_type: "county" }, "Fixture County"],
	[{ name: "LA CROSSE", jurisdiction_type: "city" }, "La Crosse city"],
	[{ name: "Local District: 37", jurisdiction_type: "district" }, "Local District: 37"],
	[{ name: "RTA", jurisdiction_type: "district" }, "Rta district"],
	[{ name: "SPECIAL TAX" }, "Special Tax"],
];

describe("jurisdictionLabel", () => {
	it.each(JURISDICTION_CASES)("labels %j as %s", (rate, expected) => {
		expect(jurisdictionLabel(rate)).toBe(expected);
	});
});

describe("jurisdictionLabel apostrophes", () => {
	it("capitalises the letter after an apostrophe", () => {
		expect(jurisdictionLabel({ name: "O'FALLON", jurisdiction_type: "city" })).toBe(
			"O'Fallon city"
		);
		expect(jurisdictionLabel({ name: "O'FALLON" })).toBe("O'Fallon");
	});
});

describe("pdfTaxRows legacy fallback", () => {
	it("prints no rate for a rate-less group and strips the (auto) marker", () => {
		const rows = pdfTaxRows(v2([], "La Crosse, WI (auto)", 2310));
		expect(rows).toEqual([
			{ id: "g1", name: "La Crosse, WI", rate: 0, amountCents: 2310, showRate: false },
		]);
	});

	it("shows the rate on collapsed rows, zero included", () => {
		const rows = pdfTaxRows(v2([r("c", "LA CROSSE", 0, "city")], "Madison, WI (auto)"));
		expect(rows.map((row) => row.showRate)).toEqual([true]);
	});
});

describe("collapseSnapshotRates", () => {
	it("returns nothing for a missing snapshot", () => {
		expect(collapseSnapshotRates(null)).toEqual([]);
	});

	it("names address-group rates and keeps a 0% row", () => {
		const snap = {
			...v2(
				[r("s", "WI", 0.05, "state"), r("c", "LA CROSSE", 0, "city")],
				"La Crosse, WI (auto)",
				500
			),
			rate_set_id: "g1",
		};
		expect(collapseSnapshotRates(snap)).toEqual([
			{ id: "s", name: "Wisconsin state", rate: 0.05, amountCents: 500 },
			{ id: "c", name: "La Crosse city", rate: 0, amountCents: 0 },
		]);
	});

	it("leaves hand-made group rate names alone", () => {
		const snap = {
			...v2([r("s", "WI State Sales Tax", 0.05, "state")], "Standard", 500),
			rate_set_id: "other",
		};
		expect(collapseSnapshotRates(snap)[0].name).toBe("WI State Sales Tax");
	});

	it("sums to total_tax_cents with a negative group", () => {
		const snap = {
			...v2([r("s", "WI", 0.05, "state")], "Adj", 10000),
			rate_set_id: "g1",
			total_tax_cents: 10000 - 2310,
		};
		snap.groups.push({
			id: "g2",
			name: "Credit",
			rates: [r("s", "WI", 0.05, "state")],
			taxable_amount_cents: -46200,
			tax_amount_cents: -2310,
		} as never);
		const sum = collapseSnapshotRates(snap).reduce((a, x) => a + x.amountCents, 0);
		expect(sum).toBe(snap.total_tax_cents);
	});

	it("orders by jurisdiction rank and puts untyped rates last", () => {
		const names = collapseSnapshotRates(
			v2([
				r("1", "Other", 0.01),
				r("2", "City tax", 0.01, "city"),
				r("3", "State tax", 0.05, "state"),
				r("4", "District tax", 0.005, "district"),
				r("5", "County tax", 0.005, "county"),
			])
		).map((x) => x.name);
		expect(names).toEqual(["State tax", "County tax", "City tax", "District tax", "Other"]);
	});

	it("sums a rate shared by two groups", () => {
		const snap = v2([r("s", "State", 0.05, "state")], "A", 500);
		snap.groups.push({
			id: "g2",
			name: "B",
			rates: [r("s", "State", 0.05, "state")],
			taxable_amount_cents: 2000,
			tax_amount_cents: 100,
		} as never);
		expect(collapseSnapshotRates(snap)).toEqual([
			{ id: "s", name: "State", rate: 0.05, amountCents: 600 },
		]);
	});

	it("half-up rounds each rate on the group base, matching the stored total", () => {
		const cents = collapseSnapshotRates(
			v2(
				[r("1", "State", 0.054945, "state"), r("2", "County", 0.000055, "county")],
				undefined,
				550,
				"jurisdiction_half_up"
			)
		).map((x) => x.amountCents);
		expect(cents).toEqual([549, 1]);
	});
});

describe("taxBasisLine", () => {
	const taxed = (over: Record<string, unknown>) =>
		({
			...v2([r("1", "A", 0.05, "state")], "G", 2031),
			subtotal_cents: 61000,
			discount_cents: 2000,
			...over,
		}) as AnyTaxSnapshot;

	it("splits the pre-discount subtotal so it reconciles with the lines", () => {
		expect(taxBasisLine(taxed({ non_taxable_amount_cents: 19000 }))).toBe(
			"Taxable lines $420.00 · $190.00 not taxed"
		);
	});

	it("omits the excluded part when every line is taxable and groups thousands", () => {
		expect(taxBasisLine(taxed({}))).toBe("Taxable lines $610.00");
		expect(taxBasisLine(taxed({ subtotal_cents: 123456 }))).toBe("Taxable lines $1,234.56");
	});

	it("is null for an exempt client, no snapshot, or a document with no tax", () => {
		expect(taxBasisLine(taxed({ client_exempt: true }))).toBeNull();
		expect(taxBasisLine(null)).toBeNull();
		expect(taxBasisLine(v2([r("1", "A", 0.05)], "G", 0))).toBeNull();
	});
});
