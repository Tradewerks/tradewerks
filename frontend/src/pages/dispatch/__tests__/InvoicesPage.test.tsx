import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import InvoicesPage from "../InvoicesPage";
import type { ListParams, PagedResult } from "../../../types/paging";

const { getInvoicesPage, getInvoicesSummary } = vi.hoisted(() => ({
	getInvoicesPage: vi.fn(),
	getInvoicesSummary: vi.fn(),
}));

vi.mock("../../../api/invoices", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/invoices")>()),
	getInvoicesPage,
	getInvoicesSummary,
}));
vi.mock("../../../hooks/useClients", () => ({ useClientByIdQuery: () => ({ data: undefined }) }));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: false } }),
}));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../../../components/invoices/CreateInvoice", () => ({ default: () => null }));
vi.mock("../../../components/reports/usePageReport", () => ({ usePageReport: () => ({}) }));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));

const invoice = (n: number, status = "Issued") => ({
	id: `i${n}`,
	invoice_number: `INV-${n}`,
	status,
	client_id: "c1",
	client: { id: "c1", name: "Acme" },
	memo: null,
	issue_date: "2026-06-01T00:00:00Z",
	due_date: "2099-07-01T00:00:00Z",
	total: "10.00",
	amount_paid: "0.00",
	balance_due: "10.00",
	qb_sync_status: "synced",
	account_id: null,
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
					<Route path="/dispatch/invoices" element={<InvoicesPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	getInvoicesPage.mockReset();
	getInvoicesSummary.mockReset().mockResolvedValue({
		outstanding: { amount: 1250, count: 3 },
		overdue: { amount: 40, count: 1 },
		paid: { amount: 900, count: 2 },
		qbTaxMismatchCount: 0,
		qbAttentionCount: 0,
	});
});

describe("InvoicesPage server paging", () => {
	it("changing page requests page 2 and keeps page 1 as placeholder", async () => {
		let release!: (v: PagedResult<unknown>) => void;
		getInvoicesPage.mockImplementation((params: ListParams) =>
			params.page === 1
				? Promise.resolve(pageOf(params, [invoice(1)]))
				: new Promise((r) => (release = r))
		);
		renderAt("/dispatch/invoices");
		await screen.findByText("INV-1");

		fireEvent.click(screen.getByLabelText("Next page"));

		await waitFor(() =>
			expect(getInvoicesPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ page: 2 }),
				expect.anything()
			)
		);
		expect(screen.getByText("INV-1")).toBeTruthy();

		await act(async () => release(pageOf({ page: 2, limit: 50 }, [invoice(51)])));
		await screen.findByText("INV-51");
		expect(screen.queryByText("INV-1")).toBeNull();
	});

	it("status in the URL pre-selects the filter", async () => {
		getInvoicesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [invoice(1, "Paid")]))
		);
		renderAt("/dispatch/invoices?status=Paid&status=Sent");
		await screen.findByText("INV-1");

		expect(getInvoicesPage).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1, status: ["Paid", "Sent"] }),
			expect.anything()
		);
		expect(screen.getByText("Status: Fully Paid")).toBeTruthy();
		expect(screen.getByText("Status: Sent")).toBeTruthy();
	});

	it("shows the org-wide header totals from the summary, not from the page", async () => {
		getInvoicesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [invoice(1)]))
		);
		renderAt("/dispatch/invoices");
		await screen.findByText("INV-1");
		await screen.findByText("$1,250.00");
		expect(screen.getByText("$900.00")).toBeTruthy();
	});

	it("shows a dash, not zero, while the summary is unavailable", async () => {
		getInvoicesSummary.mockReset().mockRejectedValue(new Error("down"));
		getInvoicesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [invoice(1)]))
		);
		renderAt("/dispatch/invoices");
		await screen.findByText("INV-1");
		await screen.findAllByText("Couldn't load");
		expect(screen.queryByText("$0.00")).toBeNull();
	});

	it("sends the sort mapped to the server column and drops an unknown one", async () => {
		getInvoicesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [invoice(1)]))
		);
		renderAt("/dispatch/invoices?sort=issued&dir=asc");
		await screen.findByText("INV-1");
		expect(getInvoicesPage.mock.calls[0][0]).toMatchObject({ sort: "issue_date", dir: "asc" });
	});

	it("drops an unknown sort from the request", async () => {
		getInvoicesPage.mockImplementation((params: ListParams) =>
			Promise.resolve(pageOf(params, [invoice(1)]))
		);
		renderAt("/dispatch/invoices?sort=bogus");
		await screen.findByText("INV-1");
		expect(getInvoicesPage.mock.calls[0][0].sort).toBeUndefined();
		expect(screen.queryByText(/^Sort:/)).toBeNull();
	});
});
