import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import QuotesPage from "../QuotesPage";
import { useAuthStore } from "../../../auth/authStore";

const { state } = vi.hoisted(() => ({ state: { quotes: [] as unknown[] } }));

vi.mock("../../../hooks/useQuotes", () => ({
	useAllQuotesQuery: () => ({ data: state.quotes, isLoading: false, error: null }),
	useCreateQuoteMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../hooks/useClients", () => ({ useClientByIdQuery: () => ({ data: undefined }) }));
vi.mock("../../../hooks/useRequests", () => ({ useRequestByIdQuery: () => ({ data: undefined }) }));
vi.mock("../../../components/quotes/CreateQuote", () => ({ default: () => null }));
vi.mock("../../../components/reports/usePageReport", () => ({
	usePageReport: () => ({}),
}));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));

const quote = (id: string, status: string, title: string) => ({
	id,
	quote_number: `Q-${id}`,
	title,
	status,
	priority: "Medium",
	address: "1 Main",
	client_id: "c1",
	client: { name: "Acme" },
	created_at: "2026-06-01T00:00:00Z",
	updated_at: "2026-06-01T00:00:00Z",
	total: 100,
});

beforeEach(() => {
	state.quotes = [
		quote("1", "Sent", "Sent quote"),
		quote("2", "Viewed", "Viewed quote"),
		quote("3", "Approved", "Approved quote"),
	];
	useAuthStore.getState().login("dispatcher", "Alex", "d1", "org", "America/Chicago", ["view_quotes"]);
});

describe("QuotesPage status filter", () => {
	it("status=Sent,Viewed in the URL selects both", async () => {
		render(
			<MemoryRouter initialEntries={["/dispatch/quotes?status=Sent,Viewed"]}>
				<Routes>
					<Route path="/dispatch/quotes" element={<QuotesPage />} />
				</Routes>
			</MemoryRouter>,
		);
		// Cells hold number and title together, so assert on the rendered text.
		await screen.findByText(/2 results/);
		const text = document.body.textContent ?? "";
		expect(text).toContain("Sent quote");
		expect(text).toContain("Viewed quote");
		expect(text).not.toContain("Approved quote");
	});
});
