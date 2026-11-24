import { describe, it, expect, vi } from "vitest";
import { buildRecurringPlanInvoicePayload } from "../invoiceGenerator.js";

const visitLine = (name: string) => ({
	name,
	description: null,
	quantity: 1,
	unit_price: 50,
	total: 50,
	item_type: "labor",
	sort_order: 0,
	taxable: false,
	tax_group_id: null,
});

type InvoiceVisitRow = {
	visit_id: string;
	billed_amount: number | null;
	invoice: { id: string; invoice_number: string; status: string };
};

// Honours the invoice-status filter the generator sends, so the test sees
// exactly which invoices the query would have matched.
function matchesStatus(
	status: string,
	filter: { notIn?: string[]; not?: string } | undefined,
): boolean {
	if (!filter) return true;
	if (filter.notIn && filter.notIn.includes(status)) return false;
	if (filter.not !== undefined && filter.not === status) return false;
	return true;
}

function fakeDb(invoiceVisits: InvoiceVisitRow[]) {
	return {
		recurring_plan: {
			findFirst: vi.fn(async () => ({
				id: "p1",
				name: "Quarterly",
				client_id: "c1",
				invoice_schedule: {
					billing_basis: "visit_actuals",
					last_invoiced_at: null,
					memo_template: null,
					payment_terms_days: null,
				},
				line_items: [],
				job_container: { id: "j1" },
			})),
		},
		recurring_occurrence: {
			findMany: vi.fn(async () => [
				{
					job_visit: {
						id: "v1",
						scheduled_start_at: new Date("2026-10-01T15:00:00Z"),
						line_items: [visitLine("October tune-up")],
					},
				},
				{
					job_visit: {
						id: "v2",
						scheduled_start_at: new Date("2026-11-01T15:00:00Z"),
						line_items: [visitLine("November tune-up")],
					},
				},
			]),
		},
		invoice_visit: {
			findMany: vi.fn(
				async (args: {
					where: {
						visit_id: { in: string[] };
						invoice?: { status?: { notIn?: string[]; not?: string } };
					};
				}) =>
					invoiceVisits.filter(
						(iv) =>
							args.where.visit_id.in.includes(iv.visit_id) &&
							matchesStatus(iv.invoice.status, args.where.invoice?.status),
					),
			),
		},
	} as never;
}

describe("buildRecurringPlanInvoicePayload visit_actuals", () => {
	it("visit_actuals skips a visit already on a Draft invoice", async () => {
		const { payload, warnings, empty } = await buildRecurringPlanInvoicePayload(
			"p1",
			fakeDb([
				{
					visit_id: "v1",
					billed_amount: 50,
					invoice: { id: "inv-d", invoice_number: "INV-7", status: "Draft" },
				},
			]),
		);

		expect(payload.line_items!.map((l) => l.source_visit_id)).toEqual(["v2"]);
		expect(payload.visit_billings).toEqual([{ visit_id: "v2", billed_amount: 50 }]);
		expect(warnings.map((w) => w.visit_id)).toEqual(["v1"]);
		expect(warnings[0].existing_invoices[0].invoice_number).toBe("INV-7");
		expect(empty).toBe(false);
	});

	it("a visit whose only invoice is Void is billed again", async () => {
		const { payload, warnings } = await buildRecurringPlanInvoicePayload(
			"p1",
			fakeDb([
				{
					visit_id: "v1",
					billed_amount: 50,
					invoice: { id: "inv-v", invoice_number: "INV-3", status: "Void" },
				},
			]),
		);

		expect(payload.line_items!.map((l) => l.source_visit_id)).toEqual(["v1", "v2"]);
		expect(warnings).toEqual([]);
	});

	it("every visit already billed leaves an empty payload", async () => {
		const { payload, empty } = await buildRecurringPlanInvoicePayload(
			"p1",
			fakeDb([
				{
					visit_id: "v1",
					billed_amount: 50,
					invoice: { id: "inv-a", invoice_number: "INV-8", status: "Sent" },
				},
				{
					visit_id: "v2",
					billed_amount: 50,
					invoice: { id: "inv-a", invoice_number: "INV-8", status: "Sent" },
				},
			]),
		);

		expect(payload.line_items).toEqual([]);
		expect(payload).not.toHaveProperty("visit_billings");
		expect(empty).toBe(true);
	});
});
