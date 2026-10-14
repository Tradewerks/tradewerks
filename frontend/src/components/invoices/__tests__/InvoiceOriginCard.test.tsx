import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import InvoiceOriginCard from "../InvoiceOriginCard";
import type { Invoice, JobReference } from "../../../types/invoices";

const job = (id: string, over: Partial<JobReference> = {}): JobReference => ({
	id,
	job_number: `J-${id}`,
	name: "Compressor Replacement",
	status: "Completed",
	...over,
});

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

const renderCard = (inv: Invoice) =>
	render(
		<MemoryRouter>
			<InvoiceOriginCard invoice={inv} />
		</MemoryRouter>
	);

describe("InvoiceOriginCard", () => {
	it("says so when there is no origin, rather than rendering nothing", () => {
		// Returning null here is indistinguishable from a card that failed to
		// load.
		renderCard(invoice());
		expect(screen.getByText(/Created manually/)).toBeInTheDocument();
	});

	it("links the quote a linked job was sold on", () => {
		const inv = invoice({
			jobs: [
				{
					invoice_id: "inv",
					job_id: "a",
					job: job("a", {
						quote: {
							id: "q1",
							quote_number: "QUO-0004",
							title: "Compressor replacement",
							status: "Approved",
							total: 2400,
							created_at: "2026-01-02T00:00:00.000Z",
						},
					}),
				},
			],
		});

		renderCard(inv);
		expect(
			screen.getByText(/QUO-0004 · Compressor replacement/).closest("a")
		).toHaveAttribute("href", "/dispatch/quotes/q1");
	});

	it("separates what was agreed from what was billed only when it has both", () => {
		// Alone, either group is what the card title already says it is.
		const workOnly = invoice({
			jobs: [{ invoice_id: "inv", job_id: "a", job: job("a") }],
		});
		const { unmount } = renderCard(workOnly);
		expect(screen.queryByText("Billed work")).not.toBeInTheDocument();
		unmount();

		const both = invoice({
			jobs: [
				{
					invoice_id: "inv",
					job_id: "a",
					job: job("a", {
						request: {
							id: "r1",
							title: "Furnace not starting",
							status: "Quoted",
							created_at: "2026-01-02T00:00:00.000Z",
						},
					}),
				},
			],
		});
		renderCard(both);
		expect(screen.getByText("From")).toBeInTheDocument();
		expect(screen.getByText("Billed work")).toBeInTheDocument();
	});

	it("makes a job reached only through its visit navigable", () => {
		// Not an inert span: a record whose number you can read but not open.
		const inv = invoice({
			visits: [
				{
					invoice_id: "inv",
					visit_id: "v1",
					billed_amount: 120,
					visit: {
						id: "v1",
						scheduled_start_at: "2026-02-03T15:00:00.000Z",
						scheduled_end_at: "2026-02-03T18:00:00.000Z",
						status: "Completed",
						job: job("a"),
					},
				},
			],
		});

		renderCard(inv);
		expect(screen.getByText(/J-a · Compressor Replacement/).closest("a")).toHaveAttribute(
			"href",
			"/dispatch/jobs/a"
		);
	});

	it("shows a recurring plan on its own, with no billed work", () => {
		renderCard(
			invoice({
				recurring_plan: { id: "p1", name: "Quarterly PM", status: "Active" },
			})
		);
		expect(screen.getByText("Quarterly PM")).toBeInTheDocument();
		expect(screen.queryByText("Billed Work")).not.toBeInTheDocument();
	});
});
