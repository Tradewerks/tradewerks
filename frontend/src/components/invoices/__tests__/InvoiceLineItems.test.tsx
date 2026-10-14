import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, within } from "@testing-library/react";
import InvoiceLineItems from "../InvoiceLineItems";
import type { Invoice, InvoiceLineItem, JobReference } from "../../../types/invoices";

const job = (id: string): JobReference => ({
	id,
	job_number: `J-${id}`,
	name: "Compressor Replacement",
	status: "Completed",
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
		subtotal: 350,
		total: 350,
		amount_paid: 0,
		balance_due: 350,
		...over,
	}) as Invoice;

const twoSources = invoice({
	jobs: [
		{ invoice_id: "inv", job_id: "a", job: job("a") },
		{ invoice_id: "inv", job_id: "b", job: job("b") },
	],
	line_items: [
		line("l1", { source_job_id: "a", total: 200 }),
		line("l2", { source_job_id: "b", total: 100 }),
		line("l3", { total: 50 }),
	],
});

const renderItems = (inv: Invoice, contested = new Set<string>()) =>
	render(
		<MemoryRouter>
			<InvoiceLineItems invoice={inv} contestedIds={contested} />
		</MemoryRouter>
	);

describe("InvoiceLineItems", () => {
	it("heads each group with a link to its source and that group's subtotal", () => {
		renderItems(twoSources);

		const link = screen.getByText("J-a · Compressor Replacement");
		expect(link.closest("a")).toHaveAttribute("href", "/dispatch/jobs/a");
		// Scoped to the header row: the same figure is also this group's one
		// line amount, and an unscoped query cannot tell which it found.
		const headerRow = link.closest("div")!;
		expect(within(headerRow).getByText("$200.00")).toBeInTheDocument();
	});

	it("names the residue rather than hiding it", () => {
		renderItems(twoSources);
		expect(screen.getByText("Not attributed")).toBeInTheDocument();
	});

	it("stays flat when every line came from the same place", () => {
		renderItems(
			invoice({
				jobs: [{ invoice_id: "inv", job_id: "a", job: job("a") }],
				line_items: [
					line("l1", { source_job_id: "a" }),
					line("l2", { source_job_id: "a" }),
				],
			})
		);
		expect(screen.queryByText("J-a · Compressor Replacement")).not.toBeInTheDocument();
	});

	it("keeps the contested marker through grouping", () => {
		renderItems(twoSources, new Set(["l1"]));
		expect(screen.getByText("Contested")).toBeInTheDocument();
	});

	it("still totals the whole invoice below the groups", () => {
		renderItems(twoSources);
		const totalRow = screen.getByText("Total").closest("div")!;
		expect(within(totalRow).getByText("$350.00")).toBeInTheDocument();
	});
});
