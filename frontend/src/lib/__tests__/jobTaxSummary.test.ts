import { describe, expect, it } from "vitest";
import { jobTaxSummary } from "../jobTaxSummary";
import type { TaxSnapshot, TaxSource } from "../../types/tax";
import type { Job, JobVisit } from "../../types/jobs";
import type { Invoice } from "../../types/invoices";

const snap = (
	source: TaxSource,
	groupName: string,
	taxCents: number,
	extra: Partial<{ client_exempt: boolean; review_reason: string }> = {}
): TaxSnapshot => ({
	version: 2,
	source,
	rounding: "line_floor",
	locked_at: "draft",
	client_exempt: false,
	non_taxable_amount_cents: 0,
	total_tax_cents: taxCents,
	subtotal_cents: 10000,
	discount_cents: 0,
	total_cents: 10000 + taxCents,
	effective_rate: 0.05,
	groups: [
		{
			id: groupName,
			name: groupName,
			rates: [{ id: groupName, name: groupName, rate: 0.05 }],
			taxable_amount_cents: 10000,
			tax_amount_cents: taxCents,
		},
	],
	...extra,
});

const job = (tax_snapshot: TaxSnapshot | null, tax_source: TaxSource | null, taxCents: number) =>
	({
		id: "j1",
		tax_snapshot,
		tax_source,
		tax_amount: taxCents / 100,
		line_items: [],
	}) as unknown as Job;

const visit = (id: string, tax_snapshot: TaxSnapshot | null) =>
	({ id, job_id: "j1", status: "Completed", tax_snapshot }) as unknown as JobVisit;

const invoice = (invoice_number: string, tax_amount: number, status = "Created"): Invoice =>
	({ id: invoice_number, invoice_number, tax_amount, status }) as unknown as Invoice;

const addressJob = () =>
	job(snap("provider", "La Crosse, WI (auto)", 500), "provider", 500);

describe("jobTaxSummary", () => {
	it("flags a visit taxed with a different group than the job's address rate", () => {
		const s = jobTaxSummary(addressJob(), [visit("v1", snap("org_default", "WI Standard", 300))], []);
		expect(s.differs).toEqual([
			{
				visitId: "v1",
				text: "1 visit is taxed with WI Standard; the job uses the La Crosse, WI address rate",
			},
		]);
	});

	it("pluralises when two visits differ the same way", () => {
		const s = jobTaxSummary(
			addressJob(),
			[
				visit("v1", snap("org_default", "WI Standard", 300)),
				visit("v2", snap("org_default", "WI Standard", 300)),
			],
			[]
		);
		expect(s.differs).toHaveLength(1);
		expect(s.differs[0].text).toBe(
			"2 visits are taxed with WI Standard; the job uses the La Crosse, WI address rate"
		);
	});

	it("does not flag visits that match the job", () => {
		const s = jobTaxSummary(
			addressJob(),
			[visit("v1", snap("provider", "La Crosse, WI (auto)", 300))],
			[]
		);
		expect(s.differs).toEqual([]);
	});

	it("flags a visit needing tax review", () => {
		const s = jobTaxSummary(
			addressJob(),
			[visit("v1", snap("provider", "La Crosse, WI (auto)", 300, { review_reason: "x" }))],
			[]
		);
		expect(s.differs[0].text).toBe("1 visit needs tax review");
	});

	it("flags a tax-exempt visit client when the job is not exempt", () => {
		const s = jobTaxSummary(
			addressJob(),
			[visit("v1", snap("provider", "La Crosse, WI (auto)", 0, { client_exempt: true }))],
			[]
		);
		expect(s.differs[0].text).toBe("1 visit's client is tax exempt");
	});

	it("uses the source most visits share when the job has no taxed lines", () => {
		const s = jobTaxSummary(
			job(null, null, 0),
			[
				visit("v1", snap("org_default", "WI Standard", 300)),
				visit("v2", snap("org_default", "WI Standard", 300)),
				visit("v3", snap("provider", "La Crosse, WI (auto)", 300)),
			],
			[]
		);
		expect(s.differs).toEqual([
			{
				visitId: "v3",
				text: "1 visit is taxed with the La Crosse, WI address rate; the job uses WI Standard",
			},
		]);
	});

	it("compares against the job's own source when its snapshot is stale", () => {
		// The stored $7.00 no longer matches the snapshot's $5.00 address-rate tax, so the place
		// it names is not known to be the job's.
		const stale = job(snap("provider", "La Crosse, WI (auto)", 500), "provider", 700);
		const s = jobTaxSummary(
			stale,
			[
				visit("v1", snap("org_default", "WI Standard", 300)),
				visit("v2", snap("org_default", "WI Standard", 300)),
				visit("v3", snap("provider", "La Crosse, WI (auto)", 300)),
			],
			[]
		);
		expect(s.differs).toEqual([
			{
				visitId: "v1",
				text: "2 visits are taxed with WI Standard; the job uses the address rate",
			},
		]);
	});

	it("names a flat-rate job's own source, not a group or place, when it has no snapshot", () => {
		const s = jobTaxSummary(
			job(null, "legacy", 725),
			[visit("v1", snap("provider", "La Crosse, WI (auto)", 300))],
			[]
		);
		expect(s.differs).toEqual([
			{
				visitId: "v1",
				text: "1 visit is taxed with the La Crosse, WI address rate; the job uses the organization rate",
			},
		]);
	});

	it("phrases a default-group job with no snapshot without naming a group", () => {
		const s = jobTaxSummary(
			job(null, "org_default", 725),
			[visit("v1", snap("provider", "La Crosse, WI (auto)", 300))],
			[]
		);
		expect(s.differs[0].text).toBe(
			"1 visit is taxed with the La Crosse, WI address rate; the job uses the default tax group"
		);
	});

	it("does not flag a visit on the job's own flat-rate source", () => {
		const s = jobTaxSummary(
			job(null, "legacy", 725),
			[visit("v1", snap("legacy", "Organization rate", 300))],
			[]
		);
		expect(s.differs).toEqual([]);
	});

	it("lists invoiced tax and what is left", () => {
		const s = jobTaxSummary(
			addressJob(),
			[visit("v1", snap("provider", "La Crosse, WI (auto)", 750))],
			[invoice("INV-0012", 12.5, "Draft")]
		);
		expect(s.wholeJobTaxCents).toBe(1250);
		expect(s.invoiced).toEqual([
			{ invoiceId: "INV-0012", number: "INV-0012", taxCents: 1250, draft: true },
		]);
		expect(s.notYetInvoicedCents).toBe(0);
		const s2 = jobTaxSummary(addressJob(), [], [invoice("INV-0012", 2)]);
		expect(s2.notYetInvoicedCents).toBe(300);
	});

	it("floors not-yet-invoiced at zero and ignores void invoices", () => {
		const s = jobTaxSummary(addressJob(), [], [invoice("A", 9), invoice("B", 99, "Void")]);
		expect(s.invoiced).toHaveLength(1);
		expect(s.notYetInvoicedCents).toBe(0);
	});
});
