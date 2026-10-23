import { describe, expect, it } from "vitest";
import {
	autoRateLocation,
	collapseSnapshotRates,
	isAddressRateSnapshot,
	jobTaxSnapshots,
	jurisdictionLabel,
	taxBasis,
} from "../taxBreakdown";
import type { TaxSnapshot, TaxSnapshotRate } from "../../types/tax";
import type { Job, JobVisit } from "../../types/jobs";

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

const r = (
	id: string,
	name: string,
	rate: number,
	jurisdiction_type?: string
): TaxSnapshotRate => ({ id, name, rate, jurisdiction_type });

const v2 = (
	rates: TaxSnapshotRate[],
	name = "Madison, WI (auto)",
	tax_amount_cents = 0,
	rounding: "line_floor" | "jurisdiction_half_up" = "line_floor"
): TaxSnapshot => ({
	...base,
	version: 2,
	source: "provider",
	rounding,
	groups: [{ id: "g1", name, rates, taxable_amount_cents: 10000, tax_amount_cents }],
});

export const JURISDICTION_CASES: [{ name: string; jurisdiction_type?: string }, string][] = [
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

describe("isAddressRateSnapshot", () => {
	it("is true for address sources and for an adopted snapshot that kept a rate set", () => {
		expect(isAddressRateSnapshot(null, "provider")).toBe(true);
		expect(isAddressRateSnapshot(null, "cached_stale")).toBe(true);
		const adopted = { ...v2([]), source: "qb_ast", rate_set_id: "g1" } as TaxSnapshot;
		expect(isAddressRateSnapshot(adopted, "qb_ast")).toBe(true);
		expect(isAddressRateSnapshot({ ...adopted, rate_set_id: null } as TaxSnapshot, "qb_ast")).toBe(false);
		expect(isAddressRateSnapshot(null, "qb_ast")).toBe(false);
		expect(isAddressRateSnapshot(null, "manual_override")).toBe(false);
	});
});

describe("collapseSnapshotRates names and zero rows", () => {
	it("names address-group rates and keeps a 0% row", () => {
		const snap = {
			...v2(
				[r("s", "WI", 0.05, "state"), r("c", "LA CROSSE", 0, "city")],
				"La Crosse, WI (auto)",
				500
			),
			rate_set_id: "g1",
		} as TaxSnapshot;
		expect(collapseSnapshotRates(snap)).toEqual([
			{ id: "s", name: "Wisconsin state", rate: 0.05, amountCents: 500 },
			{ id: "c", name: "La Crosse city", rate: 0, amountCents: 0 },
		]);
	});

	it("leaves hand-made group rate names alone", () => {
		const snap = {
			...v2([r("s", "WI State Sales Tax", 0.05, "state")], "Standard", 500),
			rate_set_id: "other",
		} as TaxSnapshot;
		expect(collapseSnapshotRates(snap)[0].name).toBe("WI State Sales Tax");
	});

	it("sums to total_tax_cents with a negative group", () => {
		const snap = {
			...v2([r("s", "WI", 0.05, "state")], "Adj", 10000),
			rate_set_id: "g1",
			total_tax_cents: 10000 - 2310,
		} as TaxSnapshot;
		snap.groups.push({
			id: "g2",
			name: "Credit",
			rates: [r("s", "WI", 0.05, "state")],
			taxable_amount_cents: -46200,
			tax_amount_cents: -2310,
		});
		const sum = collapseSnapshotRates(snap).reduce((a, x) => a + x.amountCents, 0);
		expect(sum).toBe(snap.total_tax_cents);
	});
});

describe("collapseSnapshotRates", () => {
	it("returns nothing for a missing snapshot", () => {
		expect(collapseSnapshotRates(null)).toEqual([]);
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
		snap.groups.push({ id: "g2", name: "B", rates: [r("s", "State", 0.05, "state")], taxable_amount_cents: 2000, tax_amount_cents: 100 });
		expect(collapseSnapshotRates(snap)).toEqual([{ id: "s", name: "State", rate: 0.05, amountCents: 600 }]);
	});

	it("half-up rounds each rate on the group base, matching the stored total", () => {
		// 10000 x 5.4945% = 549.45 → 549; 10000 x 0.0055% = 0.55 → 1 (floor would give 0)
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

describe("autoRateLocation", () => {
	it("names the auto lookup location", () => {
		expect(autoRateLocation(v2([r("1", "A", 0.01, "state")]))).toBe("Madison, WI");
	});

	it("is null for a hand-picked group", () => {
		expect(autoRateLocation(v2([r("1", "A", 0.01)], "Standard"))).toBeNull();
	});
});

describe("taxBasis", () => {
	const taxed = (over: Partial<TaxSnapshot>): TaxSnapshot =>
		({ ...v2([r("1", "A", 0.05, "state")], "G", 2031), subtotal_cents: 61000, discount_cents: 2000, ...over }) as TaxSnapshot;

	it("splits the pre-discount subtotal so it reconciles with the lines", () => {
		expect(taxBasis(taxed({ non_taxable_amount_cents: 19000 }))).toBe(
			"Taxable lines $420.00 · $190.00 not taxed"
		);
	});

	it("omits the excluded part when every line is taxable", () => {
		expect(taxBasis(taxed({}))).toBe("Taxable lines $610.00");
	});

	it("is null for an exempt client or a document with no tax", () => {
		expect(taxBasis(taxed({ client_exempt: true }))).toBeNull();
		expect(taxBasis(v2([r("1", "A", 0.05)], "G", 0))).toBeNull();
	});
});

describe("aggregating job + visit snapshots", () => {
	const state = () => r("s", "WI", 0.05, "state");
	const snap = (
		cents: number,
		taxableCents: number,
		rounding: "line_floor" | "jurisdiction_half_up" = "jurisdiction_half_up",
		over: Partial<TaxSnapshot> = {}
	): TaxSnapshot =>
		({
			...v2([state()], "La Crosse, WI (auto)", cents, rounding),
			rate_set_id: "g1",
			total_tax_cents: cents,
			subtotal_cents: taxableCents,
			groups: [
				{
					id: "g1",
					name: "La Crosse, WI (auto)",
					rates: [state()],
					taxable_amount_cents: taxableCents,
					tax_amount_cents: cents,
				},
			],
			...over,
		}) as TaxSnapshot;
	// 5% of 20000 = 1000; 5% of 10000 = 500; line_floor visit 5% of 10010 = 500.5 -> 500
	const jobSnap = snap(1000, 20000);
	const visitA = snap(500, 10000);
	const visitB = snap(500, 10010, "line_floor", { non_taxable_amount_cents: 10 });

	it("collapses to one named row that sums the stored totals", () => {
		expect(collapseSnapshotRates([jobSnap, visitA, visitB])).toEqual([
			{ id: "s", name: "Wisconsin state", rate: 0.05, amountCents: 2000 },
		]);
	});

	it("still accepts a single snapshot", () => {
		expect(collapseSnapshotRates(jobSnap)).toEqual(collapseSnapshotRates([jobSnap]));
		expect(collapseSnapshotRates([])).toEqual([]);
	});

	it("sums the basis across all snapshots", () => {
		expect(taxBasis([jobSnap, visitA, visitB])).toBe("Taxable lines $400.00 · $0.10 not taxed");
	});

	it("has no basis when every snapshot is exempt", () => {
		const exempt = snap(0, 10000, "jurisdiction_half_up", { client_exempt: true });
		expect(taxBasis([exempt, exempt])).toBeNull();
		expect(taxBasis([])).toBeNull();
	});

	describe("jobTaxSnapshots", () => {
		const job = (tax_amount: number | null, tax_snapshot: TaxSnapshot | null) =>
			({ tax_amount, tax_snapshot }) as unknown as Job;
		const visit = (tax_snapshot: TaxSnapshot | null) => ({ tax_snapshot }) as unknown as JobVisit;

		it("leads with a current job snapshot, then visit snapshots", () => {
			expect(jobTaxSnapshots(job(10, jobSnap), [visit(visitA), visit(null), visit(visitB)])).toEqual([
				jobSnap,
				visitA,
				visitB,
			]);
		});

		it("replaces a stale job snapshot with one built from the job's stored tax", () => {
			const [own, ...rest] = jobTaxSnapshots(job(7.25, jobSnap), [visit(visitA)]);
			expect(rest).toEqual([visitA]);
			expect(own).not.toBe(jobSnap);
			expect(own.total_tax_cents).toBe(725);
			expect(collapseSnapshotRates(own)).toEqual([
				{ id: "job-legacy", name: "Job charges tax", rate: 0, amountCents: 725 },
			]);
		});

		it("builds one for a manual job with no snapshot, from its lines", () => {
			const manual = {
				tax_amount: 7.25,
				tax_rate: 0.0725,
				tax_snapshot: null,
				line_items: [
					{ quantity: 1, unit_price: 100, total: 100, taxable: true },
					{ quantity: 2, unit_price: 10, taxable: false },
				],
			} as unknown as Job;
			const [own] = jobTaxSnapshots(manual, []);
			expect(own.subtotal_cents).toBe(12000);
			expect(own.non_taxable_amount_cents).toBe(2000);
			expect(own.groups[0].taxable_amount_cents).toBe(10000);
			expect(collapseSnapshotRates(own)[0]).toMatchObject({ rate: 0.0725, amountCents: 725 });
		});

		it("has nothing for a job with no tax and no snapshot", () => {
			expect(jobTaxSnapshots(job(0, null), [])).toEqual([]);
			expect(jobTaxSnapshots(job(null, jobSnap), [])).toEqual([]);
		});
	});
});
