import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import RequestsPage from "../RequestsPage";
import { useAuthStore } from "../../../auth/authStore";
import type { ListParams, PagedResult } from "../../../types/paging";

const { getRequestsPage } = vi.hoisted(() => ({ getRequestsPage: vi.fn() }));

vi.mock("../../../api/requests", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/requests")>()),
	getRequestsPage,
}));
vi.mock("../../../hooks/useClients", () => ({ useClientByIdQuery: () => ({ data: undefined }) }));
vi.mock("../../../components/requests/CreateRequest", () => ({ default: () => null }));
vi.mock("../../../components/reports/usePageReport", () => ({ usePageReport: () => ({}) }));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));

const request = (n: number, status = "New") => ({
	id: `r${n}`,
	title: `Request ${n}`,
	status,
	priority: "Medium",
	address: "1 Main",
	client_id: "c1",
	client: { id: "c1", name: "Acme" },
	created_at: "2026-06-01T00:00:00Z",
	updated_at: "2026-06-01T00:00:00Z",
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
					<Route path="/dispatch/requests" element={<RequestsPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	getRequestsPage.mockReset();
	useAuthStore.getState().login("dispatcher", "Alex", "d1", "org", "America/Chicago", ["view_requests"]);
});

describe("RequestsPage server paging", () => {
	it("changing page requests page 2 and keeps page 1 as placeholder", async () => {
		let release!: (v: PagedResult<unknown>) => void;
		getRequestsPage.mockImplementation((params: ListParams) =>
			params.page === 1
				? Promise.resolve(pageOf(params, [request(1)]))
				: new Promise((r) => (release = r)),
		);
		renderAt("/dispatch/requests");
		await screen.findByText("Request 1");

		fireEvent.click(screen.getByLabelText("Next page"));

		await waitFor(() =>
			expect(getRequestsPage).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }), expect.anything()),
		);
		// Page 2 is still in flight: page 1's rows stay on screen.
		expect(screen.getByText("Request 1")).toBeTruthy();

		await act(async () => release(pageOf({ page: 2, limit: 50 }, [request(51)])));
		await screen.findByText("Request 51");
		expect(screen.queryByText("Request 1")).toBeNull();
	});

	it("status in the URL pre-selects the filter", async () => {
		getRequestsPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [request(1, "Reviewing")])),
		);
		renderAt("/dispatch/requests?status=Reviewing&status=Quoted");
		await screen.findByText("Request 1");

		expect(getRequestsPage).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1, status: ["Reviewing", "Quoted"] }),
			expect.anything(),
		);
		expect(screen.getByText("Status: Reviewing")).toBeTruthy();
		expect(screen.getByText("Status: Quoted")).toBeTruthy();
	});

	it("sends every search chip as one space-joined q", async () => {
		getRequestsPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [request(1)])),
		);
		renderAt("/dispatch/requests?search=acme&search=main");
		await waitFor(() =>
			expect(getRequestsPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ q: "acme main" }),
				expect.anything(),
			),
		);
	});

	it("drops an unknown sort from the request and the chips", async () => {
		getRequestsPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [request(1)])),
		);
		renderAt("/dispatch/requests?sort=bogus&dir=asc");
		await screen.findByText("Request 1");
		expect(getRequestsPage.mock.calls[0][0].sort).toBeUndefined();
		expect(screen.queryByText(/^Sort:/)).toBeNull();
	});
});
