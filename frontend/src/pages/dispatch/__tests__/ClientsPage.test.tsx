import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ClientsPage from "../ClientsPage";
import type { ListParams, PagedResult } from "../../../types/paging";

const { getClientsPage } = vi.hoisted(() => ({ getClientsPage: vi.fn() }));

vi.mock("../../../api/clients", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/clients")>()),
	getClientsPage,
}));
vi.mock("../../../hooks/useClients", () => ({
	useCreateClientMutation: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("../../../components/clients/CreateClient", () => ({ default: () => null }));
vi.mock("../../../components/clients/ClientCard", () => ({
	default: ({ client }: { client: { name: string } }) => <div>{client.name}</div>,
}));
vi.mock("../../../components/reports/usePageReport", () => ({ usePageReport: () => ({}) }));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));

const client = (name: string, is_tax_exempt = false) => ({
	id: name,
	name,
	address: "1 Main St",
	is_active: true,
	is_tax_exempt,
});

const pageOf = (params: ListParams, rows: unknown[]): PagedResult<unknown> => ({
	rows,
	total: 120,
	page: params.page,
	limit: params.limit,
});

const renderAt = (url: string) => {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={qc}>
			<MemoryRouter initialEntries={[url]}>
				<Routes>
					<Route path="/dispatch/clients" element={<ClientsPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
};

beforeEach(() => {
	getClientsPage.mockReset();
	getClientsPage.mockImplementation((params: ListParams) =>
		Promise.resolve(pageOf(params, [client("Exempt Co", true), client("Taxed Co")])),
	);
});

describe("ClientsPage server paging", () => {
	it("changing page requests page 2 and keeps page 1 as placeholder", async () => {
		let release!: (v: PagedResult<unknown>) => void;
		getClientsPage.mockImplementation((params: ListParams) =>
			params.page === 1
				? Promise.resolve(pageOf(params, [client("First Co")]))
				: new Promise((r) => (release = r)),
		);
		renderAt("/dispatch/clients");
		await screen.findByText("First Co");

		fireEvent.click(screen.getByLabelText("Next page"));

		await waitFor(() =>
			expect(getClientsPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ page: 2 }),
				expect.anything(),
			),
		);
		expect(screen.getByText("First Co")).toBeTruthy();

		await act(async () => release(pageOf({ page: 2, limit: 50 }, [client("Fifty One Co")])));
		await screen.findByText("Fifty One Co");
		expect(screen.queryByText("First Co")).toBeNull();
	});

	it("status in the URL pre-selects the filter", async () => {
		renderAt("/dispatch/clients?status=inactive");
		await screen.findByText("Taxed Co");

		expect(getClientsPage).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1, status: ["inactive"] }),
			expect.anything(),
		);
		expect(screen.getByRole("button", { name: "Status: Inactive" })).toBeTruthy();
		expect(screen.getByLabelText("Remove Status: Inactive filter")).toBeTruthy();
	});

	it("two statuses in the URL show as a multi-select trigger and send both", async () => {
		renderAt("/dispatch/clients?status=active&status=inactive");
		await screen.findByText("Taxed Co");
		expect(screen.getByRole("button", { name: "Status (2)" })).toBeTruthy();
		expect(getClientsPage).toHaveBeenCalledWith(
			expect.objectContaining({ status: ["active", "inactive"] }),
			expect.anything(),
		);
	});

	it("sends every search chip as one space-joined q", async () => {
		renderAt("/dispatch/clients?search=acme&search=main");
		await waitFor(() =>
			expect(getClientsPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ q: "acme main" }),
				expect.anything(),
			),
		);
	});

	it("drops a status value the server would refuse", async () => {
		renderAt("/dispatch/clients?status=bogus");
		await screen.findByText("Taxed Co");
		expect(getClientsPage.mock.calls[0][0].status).toBeUndefined();
	});
});

// Matches the report popover's Tax Status breakdown, so its slices can drill here.
describe("ClientsPage tax status filter", () => {
	it("asks the server for exempt clients for tax=exempt, with a removable chip", async () => {
		renderAt("/dispatch/clients?tax=exempt");
		await screen.findByText("Exempt Co");
		expect(getClientsPage).toHaveBeenCalledWith(expect.anything(), { tax: "exempt" });
		expect(screen.getByText("Tax: Exempt")).toBeInTheDocument();
	});

	it("asks for taxable clients for tax=taxable", async () => {
		renderAt("/dispatch/clients?tax=taxable");
		await screen.findByText("Taxed Co");
		expect(getClientsPage).toHaveBeenCalledWith(expect.anything(), { tax: "taxable" });
	});

	it("offers the filter in the page controls", async () => {
		renderAt("/dispatch/clients");
		await screen.findByText("Taxed Co");
		await userEvent.click(screen.getByRole("button", { name: /^Tax status/ }));
		await userEvent.click(screen.getByRole("option", { name: "Exempt" }));
		await waitFor(() =>
			expect(getClientsPage).toHaveBeenLastCalledWith(expect.anything(), { tax: "exempt" }),
		);
	});
});
