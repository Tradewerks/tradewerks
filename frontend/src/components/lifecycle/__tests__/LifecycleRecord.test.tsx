import { describe, it, expect } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import LifecycleRecord from "../LifecycleRecord";
import type { Dispute } from "../../../types/disputes";

const resolved = {
	id: "d1",
	document_kind: "quote",
	quote_id: "q1",
	invoice_id: null,
	status: "Resolved",
	reason: "Client says the labor line was double-quoted",
	contested_line_item_ids: [{ id: "li1", name: "Labor", total: 200 }],
	status_at_open: "Sent",
	opened_at: "2026-09-04T12:00:00.000Z",
	opened_by_dispatcher: { id: "d", name: "Austin" },
	resolution: "ReviseAndResend",
	resolution_note: "Re-quoted at the correct labor rate",
	resolved_at: "2026-09-05T09:00:00.000Z",
	resolved_by_dispatcher: { id: "d", name: "Austin" },
	replacement_quote_id: "q2",
	replacement_invoice_id: null,
	adjustment_invoice_id: null,
	outcomes: null,
} as Dispute;

describe("LifecycleRecord", () => {
	/** A resolved dispute used to vanish: the banner rendered only while Open. */
	it("keeps a resolved dispute on the page with its outcome and note", () => {
		render(
			<MemoryRouter>
				<LifecycleRecord disputes={[resolved]} />
			</MemoryRouter>
		);

		expect(screen.getByText(/Revise & Resend/)).toBeTruthy();
		expect(screen.getByText(/correct labor rate/)).toBeTruthy();
		// Both actors are named. Opener and resolver are the same dispatcher
		// here, so the name appears on two lines — getByText would throw.
		expect(screen.getAllByText(/Austin/)).toHaveLength(2);
		expect(screen.getByText(/was Sent when opened/i)).toBeTruthy();
	});

	it("links the document the resolution produced", () => {
		render(
			<MemoryRouter>
				<LifecycleRecord disputes={[resolved]} />
			</MemoryRouter>
		);

		const link = screen.getByRole("link", { name: /replacement/i });
		expect(link.getAttribute("href")).toBe("/dispatch/quotes/q2");
	});

	it("renders nothing when there is no dispute history", () => {
		const { container } = render(
			<MemoryRouter>
				<LifecycleRecord disputes={[]} />
			</MemoryRouter>
		);

		expect(container.textContent).toBe("");
	});
});
