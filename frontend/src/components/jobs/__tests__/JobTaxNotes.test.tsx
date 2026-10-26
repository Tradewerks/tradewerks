import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import JobTaxNotes from "../JobTaxNotes";
import type { JobTaxSummary } from "../../../lib/jobTaxSummary";

const empty: JobTaxSummary = {
	wholeJobTaxCents: 1000,
	invoiced: [],
	notYetInvoicedCents: 1000,
	differs: [],
};

const renderNotes = (summary: JobTaxSummary, qbCalculatesTax?: boolean) =>
	render(
		<MemoryRouter>
			<JobTaxNotes summary={summary} jobId="j1" qbCalculatesTax={qbCalculatesTax} />
		</MemoryRouter>,
	);

const LINE = "QuickBooks calculates the final tax when this is invoiced.";

describe("JobTaxNotes QuickBooks line", () => {
	it("renders nothing when there is nothing to reconcile and QuickBooks is not calculating", () => {
		const { container } = renderNotes(empty);
		expect(container).toBeEmptyDOMElement();
	});

	it("shows the QuickBooks line even with no invoices or differing visits", () => {
		renderNotes(empty, true);
		expect(screen.getByText(LINE)).toBeInTheDocument();
	});

	it("shows it alongside the invoice reconciliation", () => {
		renderNotes(
			{
				...empty,
				invoiced: [{ invoiceId: "i1", number: "INV-0012", taxCents: 500, draft: false }],
				notYetInvoicedCents: 500,
			},
			true,
		);
		expect(screen.getByText(LINE)).toBeInTheDocument();
		expect(screen.getByText(/Already invoiced/)).toBeInTheDocument();
	});
});
