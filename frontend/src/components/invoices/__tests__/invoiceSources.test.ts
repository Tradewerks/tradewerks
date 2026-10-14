import { describe, it, expect } from "vitest";
import {
	buildLinkedJobGroups,
	groupLineItemsBySource,
	resolveLineSources,
	shouldGroupBySource,
	upstreamOf,
} from "../invoiceSources";
import type { Invoice, InvoiceLineItem, JobReference, VisitReference } from "../../../types/invoices";

const quote = (id: string) => ({
	id,
	quote_number: `QUO-${id}`,
	title: "Compressor replacement",
	status: "Approved",
	total: 2400,
	created_at: "2026-01-02T00:00:00.000Z",
});

const job = (id: string, over: Partial<JobReference> = {}): JobReference => ({
	id,
	job_number: `J-${id}`,
	name: "Compressor Replacement",
	status: "Completed",
	...over,
});

const visit = (id: string, parent: JobReference): VisitReference => ({
	id,
	scheduled_start_at: "2026-02-03T15:00:00.000Z",
	scheduled_end_at: "2026-02-03T18:00:00.000Z",
	status: "Completed",
	job: parent,
});

const line = (id: string, over: Partial<InvoiceLineItem> = {}): InvoiceLineItem =>
	({
		id,
		invoice_id: "inv",
		name: `Line ${id}`,
		quantity: 1,
		unit_price: 100,
		total: 100,
		sort_order: 0,
		taxable: true,
		tax_group_id: null,
		tax_amount: null,
		...over,
	}) as InvoiceLineItem;

const invoice = (over: Partial<Invoice> = {}): Invoice =>
	({
		id: "inv",
		invoice_number: "INV-0001",
		client_id: "c1",
		status: "Issued",
		issue_date: null,
		total: 0,
		...over,
	}) as Invoice;

describe("upstreamOf", () => {
	it("counts one quote once even when two jobs were sold on it", () => {
		const q = quote("q1");
		const inv = invoice({
			jobs: [
				{ invoice_id: "inv", job_id: "a", job: job("a", { quote: q }) },
				{ invoice_id: "inv", job_id: "b", job: job("b", { quote: q }) },
			],
		});

		expect(upstreamOf(inv).quotes).toHaveLength(1);
	});

	it("reaches a quote through a visit's parent job", () => {
		const parent = job("a", { quote: quote("q1") });
		const inv = invoice({
			visits: [
				{
					invoice_id: "inv",
					visit_id: "v1",
					billed_amount: 100,
					visit: visit("v1", parent),
				},
			],
		});

		expect(upstreamOf(inv).quotes.map((q) => q.id)).toEqual(["q1"]);
	});
});

describe("resolveLineSources", () => {
	it("resolves a source the join tables never carried", () => {
		// The adjustment case: the line names a job that no invoice_job row backs.
		const inv = invoice({
			line_items: [line("l1", { source_job_id: "a" })],
			unlinked_sources: { jobs: [job("a")], visits: [] },
		});

		expect(resolveLineSources(inv).get("l1")).toMatchObject({
			kind: "job",
			id: "a",
			to: "/dispatch/jobs/a",
		});
	});

	it("prefers the visit when a line carries both ids", () => {
		const parent = job("a");
		const inv = invoice({
			jobs: [{ invoice_id: "inv", job_id: "a", job: parent }],
			visits: [
				{
					invoice_id: "inv",
					visit_id: "v1",
					billed_amount: 100,
					visit: visit("v1", parent),
				},
			],
			line_items: [line("l1", { source_job_id: "a", source_visit_id: "v1" })],
		});

		expect(resolveLineSources(inv).get("l1")).toMatchObject({
			kind: "visit",
			to: "/dispatch/jobs/a/visits/v1",
		});
	});

	it("leaves a line unresolved when nothing knows the id", () => {
		const inv = invoice({ line_items: [line("l1", { source_job_id: "ghost" })] });
		expect(resolveLineSources(inv).has("l1")).toBe(false);
	});
});

describe("groupLineItemsBySource", () => {
	const parent = job("a");
	const inv = invoice({
		jobs: [{ invoice_id: "inv", job_id: "a", job: parent }],
		visits: [
			{
				invoice_id: "inv",
				visit_id: "v1",
				billed_amount: 300,
				visit: visit("v1", parent),
			},
		],
		line_items: [
			line("l1", { source_visit_id: "v1", total: 200 }),
			line("l2", { source_job_id: "a", total: 50 }),
			line("l3", { total: 25 }),
			line("l4", { source_visit_id: "v1", total: 100 }),
		],
	});

	const groups = groupLineItemsBySource(inv.line_items!, resolveLineSources(inv));

	it("gathers lines under their source without reordering within a group", () => {
		expect(groups[0].items.map((i) => i.id)).toEqual(["l1", "l4"]);
		expect(groups[0].source?.kind).toBe("visit");
	});

	it("subtotals each group from its own lines", () => {
		expect(groups[0].subtotal).toBe(300);
		expect(groups[1].subtotal).toBe(50);
	});

	it("puts what it could not place last, as the residue", () => {
		expect(groups.at(-1)?.source).toBeNull();
		expect(groups.at(-1)?.items.map((i) => i.id)).toEqual(["l3"]);
	});

	it("groups when a single source leaves lines unattributed", () => {
		// One named source plus a stray line still needs the split: which
		// lines belong to nothing is exactly the question being asked.
		const single = invoice({
			jobs: [{ invoice_id: "inv", job_id: "a", job: parent }],
			line_items: [line("l1", { source_job_id: "a" }), line("l2")],
		});
		const split = groupLineItemsBySource(single.line_items!, resolveLineSources(single));
		expect(shouldGroupBySource(split)).toBe(true);
	});

	it("does not group when every line shares one source", () => {
		const single = invoice({
			jobs: [{ invoice_id: "inv", job_id: "a", job: parent }],
			line_items: [line("l1", { source_job_id: "a" }), line("l2", { source_job_id: "a" })],
		});
		const one = groupLineItemsBySource(single.line_items!, resolveLineSources(single));
		expect(shouldGroupBySource(one)).toBe(false);
	});
});

describe("buildLinkedJobGroups", () => {
	it("keeps a billing amount and never lets a later pass erase it", () => {
		const parent = job("a");
		const inv = invoice({
			jobs: [{ invoice_id: "inv", job_id: "a", billed_amount: 400, job: parent }],
			unlinked_sources: { jobs: [job("a")], visits: [] },
		});

		expect(buildLinkedJobGroups(inv)).toEqual([
			expect.objectContaining({ jobId: "a", billedAmount: 400 }),
		]);
	});

	it("files a visit under its parent job, creating the job if only the visit is linked", () => {
		const parent = job("a");
		const inv = invoice({
			visits: [
				{
					invoice_id: "inv",
					visit_id: "v1",
					billed_amount: 120,
					visit: visit("v1", parent),
				},
			],
		});

		const [group] = buildLinkedJobGroups(inv);
		expect(group.billedAmount).toBeNull();
		expect(group.visits).toEqual([
			expect.objectContaining({ visitId: "v1", billedAmount: 120, jobId: "a" }),
		]);
	});
});
