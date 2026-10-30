import { describe, it, expect, vi } from "vitest";
import { buildRecurringPlanInvoicePayload } from "../invoiceGenerator.js";

const line = (taxable: boolean) => ({
	name: "Filter",
	description: null,
	quantity: 2,
	unit_price: 10,
	total: 20,
	item_type: "material",
	sort_order: 0,
	taxable,
	tax_group_id: "g1",
});

function fakeDb(basis: "plan_line_items" | "visit_actuals", taxable: boolean) {
	return {
		recurring_plan: {
			findFirst: vi.fn(async () => ({
				id: "p1",
				name: "Quarterly",
				client_id: "c1",
				invoice_schedule: {
					billing_basis: basis,
					last_invoiced_at: null,
					memo_template: null,
					payment_terms_days: null,
				},
				line_items: [line(taxable)],
				job_container: { id: "j1" },
			})),
		},
		recurring_occurrence: {
			findMany: vi.fn(async () => [
				{
					job_visit: {
						id: "v1",
						scheduled_start_at: new Date("2026-01-01T00:00:00Z"),
						line_items: [line(taxable)],
					},
				},
			]),
		},
		invoice_visit: { findMany: vi.fn(async () => []) },
	} as never;
}

describe("generated invoice lines carry the source line's taxable flag", () => {
	it.each(["plan_line_items", "visit_actuals"] as const)(
		"%s basis: taxable:false stays false and no category fields are written",
		async (basis) => {
			const { payload } = await buildRecurringPlanInvoicePayload("p1", fakeDb(basis, false));
			const item = payload.line_items![0];
			expect(item.taxable).toBe(false);
			expect(item).not.toHaveProperty("tax_category");
			expect(payload).not.toHaveProperty("work_class");
		},
	);

	it("plan_line_items basis: taxable:true stays true", async () => {
		const { payload } = await buildRecurringPlanInvoicePayload(
			"p1",
			fakeDb("plan_line_items", true),
		);
		expect(payload.line_items![0].taxable).toBe(true);
	});

	it.each(["plan_line_items", "visit_actuals"] as const)(
		"%s basis: the source line's tax_group_id rides onto the invoice line",
		async (basis) => {
			const { payload } = await buildRecurringPlanInvoicePayload("p1", fakeDb(basis, true));
			expect(payload.line_items![0].tax_group_id).toBe("g1");
		},
	);
});
