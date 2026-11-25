import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import QuotesPage from "../QuotesPage";
import { useAuthStore } from "../../../auth/authStore";
import type { ListParams, PagedResult } from "../../../types/paging";

const { getQuotesPage } = vi.hoisted(() => ({ getQuotesPage: vi.fn() }));

vi.mock("../../../api/quotes", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/quotes")>()),
	getQuotesPage,
}));
vi.mock("../../../hooks/useClients", () => ({ useClientByIdQuery: () => ({ data: undefined }) }));
vi.mock("../../../hooks/useRequests", () => ({ useRequestByIdQuery: () => ({ data: undefined }) }));
vi.mock("../../../components/quotes/CreateQuote", () => ({ default: () => null }));
vi.mock("../../../components/reports/usePageReport", () => ({
	usePageReport: () => ({}),
}));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));

const quote = (n: number, status = "Sent") => ({
	id: `${n}`,
	quote_number: `Q-${n}`,
	title: `Quote ${n}`,
	status,
	priority: "Medium",
	address: "1 Main",
	client_id: "c1",
	client: { id: "c1", name: "Acme" },
	created_at: "2026-06-01T00:00:00Z",
	updated_at: "2026-06-01T00:00:00Z",
	total: 100,
});

const pageOf = (params: ListParams, rows: unknown[]): PagedResult<unknown> => ({
	rows,
	total: 120,
	page: params.page,
	limit: params.limit,
});

function renderAt(url: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[url]}>
				<Routes>
					<Route path="/dispatch/quotes" element={<QuotesPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getQuotesPage.mockReset();
	useAuthStore.getState().login("dispatcher", "Alex", "d1", "org", "America/Chicago", ["view_quotes"]);
});

describe("QuotesPage server paging", () => {
	it("changing page requests page 2 and keeps page 1 as placeholder", async () => {
		let release!: (v: PagedResult<unknown>) => void;
		getQuotesPage.mockImplementation((params: ListParams) =>
			params.page === 1
				? Promise.resolve(pageOf(params, [quote(1)]))
				: new Promise((r) => (release = r)),
		);
		renderAt("/dispatch/quotes");
		await screen.findByText(/Quote 1$/);

		fireEvent.click(screen.getByLabelText("Next page"));

		await waitFor(() =>
			expect(getQuotesPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }), expect.anything()),
		);
		expect(screen.getByText(/Quote 1$/)).toBeTruthy();

		await act(async () => release(pageOf({ page: 2, limit: 50 }, [quote(51)])));
		await screen.findByText(/Quote 51$/);
		expect(screen.queryByText(/Quote 1$/)).toBeNull();
	});

	it("status in the URL pre-selects the filter", async () => {
		getQuotesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [quote(1, "Viewed")])),
		);
		renderAt("/dispatch/quotes?status=Sent,Viewed");
		await screen.findByText(/Quote 1$/);

		expect(getQuotesPage).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1, status: ["Sent", "Viewed"] }),
			expect.anything(),
		);
		expect(screen.getByText("Status: Sent")).toBeTruthy();
		expect(screen.getByText("Status: Viewed")).toBeTruthy();
	});

	it("removing one comma-joined status chip keeps the other", async () => {
		getQuotesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [quote(1)])),
		);
		renderAt("/dispatch/quotes?status=Sent,Viewed");
		await screen.findByLabelText("Remove Status: Viewed filter");
		fireEvent.click(screen.getByLabelText("Remove Status: Sent filter"));
		await waitFor(() => expect(screen.queryByLabelText("Remove Status: Sent filter")).toBeNull());
		expect(screen.getByLabelText("Remove Status: Viewed filter")).toBeTruthy();
		await waitFor(() =>
			expect(getQuotesPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ status: ["Viewed"] }),
				expect.anything(),
			),
		);
	});

	it("a comma-joined status lands as repeated params so the dropdown shows both", async () => {
		getQuotesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [quote(1)])),
		);
		renderAt("/dispatch/quotes?status=Sent,Viewed");
		const trigger = await screen.findByText("Status (2)");
		fireEvent.click(trigger);
		fireEvent.click(await screen.findByRole("option", { name: /Approved/ }));
		await screen.findByText("Status (3)");
		expect(screen.getAllByLabelText("Remove Status: Sent filter")).toHaveLength(1);
		expect(screen.getAllByLabelText("Remove Status: Viewed filter")).toHaveLength(1);
		expect(screen.getAllByLabelText("Remove Status: Approved filter")).toHaveLength(1);
	});

	it("maps the page's sort keys to server columns and drops unknown ones", async () => {
		getQuotesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [quote(1)])),
		);
		renderAt("/dispatch/quotes?sort=quoteNumber&dir=asc");
		await screen.findByText(/Quote 1$/);
		expect(getQuotesPage.mock.calls[0][0]).toMatchObject({ sort: "quote_number", dir: "asc" });
		getQuotesPage.mockClear();
		renderAt("/dispatch/quotes?sort=bogus");
		await waitFor(() => expect(getQuotesPage).toHaveBeenCalled());
		expect(getQuotesPage.mock.calls[0][0].sort).toBeUndefined();
	});
});
