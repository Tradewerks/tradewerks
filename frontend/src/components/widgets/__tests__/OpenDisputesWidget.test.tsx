import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenDisputeList, OpenDisputeSummary } from "../../../types/disputes";

const { query } = vi.hoisted(() => ({ query: { current: {} as Record<string, unknown> } }));
vi.mock("../../../hooks/useDisputes", () => ({ useOpenDisputesQuery: () => query.current }));

import OpenDisputesWidget from "../OpenDisputesWidget";

const DAY = 86_400_000;
const summary = (over: Partial<OpenDisputeSummary> = {}): OpenDisputeSummary => ({
	dispute_id: "d-i",
	kind: "invoice",
	document_id: "i1",
	document_number: "INV-0142",
	client: { id: "c2", name: "Acme HVAC" },
	amount: 1240,
	contested_amount: null,
	reason: "Charged 2 hrs, was 1",
	opened_at: new Date(Date.now() - 12 * DAY).toISOString(),
	opened_by: { id: "u2", name: "Sam" },
	can_resolve: true,
	...over,
});
const aQuoteDispute = (over: Partial<OpenDisputeSummary> = {}) =>
	summary({
		dispute_id: "d-q",
		kind: "quote",
		document_id: "q1",
		document_number: "Q-0031",
		client: { id: "c1", name: "J. Rivera" },
		amount: 860,
		opened_at: new Date(Date.now() - 3 * DAY).toISOString(),
		can_resolve: false,
		...over,
	});
const list = (items: OpenDisputeSummary[], over: Partial<OpenDisputeList> = {}): OpenDisputeList => ({
	items,
	counts: {
		quote: items.filter((d) => d.kind === "quote").length,
		invoice: items.filter((d) => d.kind === "invoice").length,
	},
	total: items.length,
	...over,
});
const renderWidget = () =>
	render(
		<MemoryRouter>
			<OpenDisputesWidget />
		</MemoryRouter>,
	);
const ticks = (row: HTMLElement, cls: string) =>
	within(row).getByTestId("age-meter").querySelectorAll(`.${cls}`).length;

beforeEach(() => {
	query.current = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
});

describe("OpenDisputesWidget", () => {
	it("shows a skeleton while loading", () => {
		query.current = { ...query.current, isLoading: true };
		const { container } = renderWidget();
		expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
		expect(screen.queryByText("No open disputes")).toBeNull();
	});

	it("shows a load error with a working Retry", () => {
		const refetch = vi.fn();
		query.current = { ...query.current, isError: true, refetch };
		renderWidget();
		expect(screen.getByText("Failed to load disputes")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(refetch).toHaveBeenCalled();
	});

	it("shows a quiet empty state with no header links at zero", () => {
		query.current = { ...query.current, data: list([]) };
		renderWidget();
		expect(screen.getByText("No open disputes")).toBeTruthy();
		expect(screen.queryAllByRole("link")).toHaveLength(0);
	});

	it("groups disputes by who can act, each row linking to its document", () => {
		query.current = { ...query.current, data: list([aQuoteDispute(), summary()]) };
		renderWidget();

		const resolvable = screen.getByRole("region", { name: "You can resolve" });
		const unresolvable = screen.getByRole("region", { name: "Needs a resolver" });
		expect(within(resolvable).getByRole("link", { name: /INV-0142/ }).getAttribute("href")).toBe(
			"/dispatch/invoices/i1",
		);
		expect(within(unresolvable).getByRole("link", { name: /Q-0031/ }).getAttribute("href")).toBe(
			"/dispatch/quotes/q1",
		);
		expect(within(resolvable).queryByText("Q-0031")).toBeNull();
		expect(
			resolvable.compareDocumentPosition(unresolvable) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("omits a group nobody is in", () => {
		query.current = { ...query.current, data: list([summary()]) };
		renderWidget();
		expect(screen.getByRole("region", { name: "You can resolve" })).toBeTruthy();
		expect(screen.queryByText("Needs a resolver")).toBeNull();
	});

	it("marks age against the stale line: warning text and a full meter at 7+ days", () => {
		query.current = { ...query.current, data: list([summary(), aQuoteDispute()]) };
		renderWidget();

		expect(screen.getByText("12d").className).toContain("text-warning-text");
		expect(screen.getByText("3d").className).not.toContain("text-warning-text");

		const stale = screen.getByRole("link", { name: /INV-0142/ });
		const fresh = screen.getByRole("link", { name: /Q-0031/ });
		expect(ticks(stale, "bg-warning")).toBe(7);
		expect(ticks(fresh, "bg-text-faint")).toBe(3);
		expect(ticks(fresh, "bg-border-subtle")).toBe(4);
	});

	it("puts per-kind counts in the header as links to the Disputed lists", () => {
		query.current = { ...query.current, data: list([summary(), aQuoteDispute()]) };
		renderWidget();
		expect(screen.getByRole("link", { name: "1 quote" }).getAttribute("href")).toBe(
			"/dispatch/quotes?status=Disputed",
		);
		expect(screen.getByRole("link", { name: "1 invoice" }).getAttribute("href")).toBe(
			"/dispatch/invoices?status=Disputed",
		);
	});

	it("hides a kind with no disputes and notes a capped list", () => {
		query.current = {
			...query.current,
			data: list([summary()], { total: 51, counts: { quote: 0, invoice: 51 } }),
		};
		renderWidget();
		expect(screen.queryByRole("link", { name: /quote/ })).toBeNull();
		expect(screen.getByRole("link", { name: "51 invoices" })).toBeTruthy();
		expect(screen.getByText("Showing the oldest 1 of 51.")).toBeTruthy();
	});
});
