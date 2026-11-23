import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../../../api/publicLinks", () => ({
	markPublicLinkViewed: vi.fn(async () => {}),
	getPublicDocumentPdf: vi.fn(),
}));
import type { InvoiceLinkData } from "../../../api/publicLinks";
import InvoiceView from "../InvoiceView";

const invoice = (over: Partial<InvoiceLinkData> = {}): InvoiceLinkData => ({
	purpose: "invoice",
	org: {
		name: "Acme HVAC",
		logo_url: null,
		color: "#0f766e",
		phone: "555-0100",
		email: null,
	},
	number: "INV-7",
	status_label: "Due",
	issue_date: "2026-11-01T18:00:00.000Z",
	due_date: "2026-12-01T18:00:00.000Z",
	line_items: [
		{ name: "Tune-up", description: null, quantity: 1, unit_price: 200, total: 200 },
	],
	total: 200,
	amount_paid: 0,
	balance_due: 200,
	...over,
});

describe("InvoiceView", () => {
	it("an open invoice shows the due date and how to pay", () => {
		render(<InvoiceView token="tok" data={invoice()} />);
		expect(screen.getByText(/Due Dec 1, 2026/)).toBeInTheDocument();
		expect(
			screen.getByText(/To pay, contact Acme HVAC at 555-0100/)
		).toBeInTheDocument();
	});

	it("date-only issue and due dates stored as UTC midnight show their own day", () => {
		render(
			<InvoiceView
				token="tok"
				data={invoice({
					issue_date: "2026-11-01T00:00:00.000Z",
					due_date: "2026-12-01T00:00:00.000Z",
				})}
			/>
		);
		expect(screen.getByText(/Issued Nov 1, 2026/)).toBeInTheDocument();
		expect(screen.getByText(/Due Dec 1, 2026/)).toBeInTheDocument();
	});

	it("a paid invoice hides the due date and the to-pay line", () => {
		render(
			<InvoiceView
				token="tok"
				data={invoice({
					status_label: "Paid",
					amount_paid: 200,
					balance_due: 0,
				})}
			/>
		);
		expect(screen.queryByText(/Due Dec/)).toBeNull();
		expect(screen.queryByText(/To pay/)).toBeNull();
		expect(screen.getByRole("button", { name: "Download PDF" })).toBeInTheDocument();
	});

	it("a void invoice hides the to-pay line and the PDF even with a balance", () => {
		render(<InvoiceView token="tok" data={invoice({ status_label: "Void" })} />);
		expect(screen.queryByText(/To pay/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Download PDF" })).toBeNull();
	});
});
