import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenDisputeSummary } from "../../../types/disputes";

const { calls, query } = vi.hoisted(() => ({
	calls: [] as Array<string | undefined>,
	query: { current: {} as Record<string, unknown> },
}));
vi.mock("../../../hooks/useDisputes", () => ({
	useOpenDisputesQuery: (clientId?: string) => {
		calls.push(clientId);
		return query.current;
	},
}));

import ClientDisputesCard from "../ClientDisputesCard";

const DAY = 86_400_000;
const summary = (over: Partial<OpenDisputeSummary> = {}): OpenDisputeSummary => ({
	dispute_id: "d-i",
	kind: "invoice",
	document_id: "i1",
	document_number: "INV-0142",
	client: { id: "c1", name: "Acme" },
	amount: 1240,
	contested_amount: null,
	reason: "Charged 2 hrs, was 1",
	opened_at: new Date(Date.now() - 12 * DAY).toISOString(),
	opened_by: { id: "u2", name: "Sam" },
	can_resolve: true,
	...over,
});
const aQuoteDispute = () =>
	summary({
		dispute_id: "d-q",
		kind: "quote",
		document_id: "q1",
		document_number: "Q-0031",
		amount: 860,
		reason: "Scope disagreement",
		opened_at: new Date().toISOString(),
		opened_by: null,
	});
const renderCard = () =>
	render(
		<MemoryRouter>
			<ClientDisputesCard clientId="c1" />
		</MemoryRouter>,
	);

beforeEach(() => {
	calls.length = 0;
	query.current = { data: undefined, isError: false };
});

describe("ClientDisputesCard", () => {
	it("queries by this client", () => {
		renderCard();
		expect(calls).toContain("c1");
	});

	it("renders nothing with no open disputes, on load, or on error", () => {
		query.current = { data: { items: [], counts: { quote: 0, invoice: 0 }, total: 0 } };
		expect(renderCard().container.textContent).toBe("");
		query.current = { data: undefined, isError: true };
		expect(renderCard().container.textContent).toBe("");
	});

	it("leads each row with the document, then amount, reason and age, linking to it", () => {
		query.current = {
			data: { items: [summary(), aQuoteDispute()], counts: { quote: 1, invoice: 1 }, total: 2 },
		};
		renderCard();

		expect(screen.getByRole("heading", { name: "Open Disputes" })).toBeTruthy();
		expect(screen.queryByText("Acme")).toBeNull();

		const invoice = screen.getByRole("link", {
			name: "invoice INV-0142, $1,240.00 balance, open 12 days by Sam",
		});
		expect(invoice.getAttribute("href")).toBe("/dispatch/invoices/i1");
		expect(invoice.textContent).toContain("Charged 2 hrs, was 1");
		expect(screen.getByText("12d").getAttribute("title")).toBe("Opened 12 days ago by Sam");

		const quote = screen.getByRole("link", { name: "quote Q-0031, $860.00 quote total, open 0 days" });
		expect(quote.getAttribute("href")).toBe("/dispatch/quotes/q1");
		expect(quote.textContent).toContain("Scope disagreement");
	});

	it("marks a dispute past the stale line in warning text", () => {
		query.current = {
			data: { items: [summary(), aQuoteDispute()], counts: { quote: 1, invoice: 1 }, total: 2 },
		};
		renderCard();
		expect(screen.getByText("12d").className).toContain("text-warning-text");
		expect(screen.getByText("0d").className).not.toContain("text-warning-text");
	});

	it("notes a capped list", () => {
		query.current = {
			data: { items: [summary()], counts: { quote: 0, invoice: 51 }, total: 51 },
		};
		renderCard();
		expect(screen.getByText("Showing the oldest 1 of 51.")).toBeTruthy();
	});
});
