import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import InvoicesPage from "../InvoicesPage";
import type { InvoiceListRow } from "../../../api/invoices";
import type { ListParams, PagedResult } from "../../../types/paging";

const { getInvoicesPage } = vi.hoisted(() => ({ getInvoicesPage: vi.fn() }));

vi.mock("../../../api/invoices", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../api/invoices")>()),
	getInvoicesPage,
}));
vi.mock("../../../hooks/useInvoices", () => ({
	// The server counts these for the whole org; the page only shows them.
	useInvoicesSummaryQuery: () => ({
		data: {
			outstanding: { amount: 0, count: 0 },
			overdue: { amount: 0, count: 0 },
			paid: { amount: 0, count: 0 },
			qbTaxMismatchCount: 1,
			qbAttentionCount: 4,
		},
	}),
}));
vi.mock("../../../hooks/useClients", () => ({
	useClientByIdQuery: () => ({ data: undefined }),
}));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: true, realmId: "realm-1" } }),
}));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => true }));
vi.mock("../../../components/reports/PageReportButton", () => ({ default: () => null }));
vi.mock("../../../components/reports/PageReportKpis", () => ({ default: () => null }));
vi.mock("../../../components/reports/usePageReport", () => ({
	usePageReport: () => ({}),
}));
vi.mock("../../../components/invoices/CreateInvoice", () => ({ default: () => null }));

const mk = (n: string, extra: Record<string, unknown>) =>
	({
		id: `id-${n}`,
		invoice_number: n,
		status: "Issued",
		client_id: "c1",
		client: { id: "c1", name: `Client ${n}` },
		account_id: "realm-1",
		total: 10,
		amount_paid: 0,
		balance_due: 10,
		issue_date: "2026-09-01T00:00:00.000Z",
		due_date: "2026-12-01T00:00:00.000Z",
		qb_sync_status: "synced",
		...extra,
	}) as unknown as InvoiceListRow;

const answer = (rows: InvoiceListRow[]) =>
	getInvoicesPage.mockImplementation(
		(params: ListParams): Promise<PagedResult<InvoiceListRow>> =>
			Promise.resolve({ rows, total: rows.length, page: params.page, limit: params.limit })
	);

const markerRows = () => [
	mk("F-1", { qb_sync_status: "failed" }),
	mk("T-1", { qb_sync_status: "tax_mismatch" }),
	mk("D-1", { qb_diverged_at: "2026-11-01T00:00:00.000Z", qb_diverged_reason: "refund_not_in_qb" }),
];

const renderPage = (url = "/dispatch/invoices") =>
	render(
		<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
			<MemoryRouter initialEntries={[url]}>
				<InvoicesPage />
			</MemoryRouter>
		</QueryClientProvider>
	);

beforeEach(() => {
	getInvoicesPage.mockReset();
});

describe("InvoicesPage — QuickBooks filter", () => {
	it('the QuickBooks filter "Needs attention" asks the server for the attention view and shows what it returns', async () => {
		answer(markerRows());
		const user = userEvent.setup();
		renderPage();
		await screen.findByText("F-1");
		await user.click(screen.getByRole("button", { name: /QuickBooks: needs attention \(4\)/ }));
		await waitFor(() =>
			expect(getInvoicesPage).toHaveBeenLastCalledWith(
				expect.objectContaining({ page: 1 }),
				expect.objectContaining({ qb: "attention" })
			)
		);
		expect(screen.getByText("QuickBooks: needs attention")).toBeInTheDocument();
	});

	it('a failed invoice row shows the QuickBooks warning marker with the tooltip "Not in QuickBooks — retry from the invoice"', async () => {
		answer(markerRows());
		renderPage();
		const row = (await screen.findByText("F-1")).closest("tr") as HTMLElement;
		expect(
			within(row).getByTitle("Not in QuickBooks — retry from the invoice")
		).toBeInTheDocument();
	});

	it("the QuickBooks marker is named for screen readers, like the tax marker", async () => {
		answer(markerRows());
		renderPage();
		const failed = (await screen.findByText("F-1")).closest("tr") as HTMLElement;
		const diverged = screen.getByText("D-1").closest("tr") as HTMLElement;
		expect(
			within(failed).getByLabelText("Not in QuickBooks — retry from the invoice")
		).toBeInTheDocument();
		expect(
			within(diverged).getByLabelText("QuickBooks doesn't match — open the invoice")
		).toBeInTheDocument();
	});

	it("existing ?qb=tax_mismatch links still filter to tax mismatches", async () => {
		answer([mk("T-1", { qb_sync_status: "tax_mismatch" })]);
		renderPage("/dispatch/invoices?qb=tax_mismatch");
		await screen.findByText("T-1");
		expect(getInvoicesPage).toHaveBeenCalledWith(
			expect.objectContaining({ page: 1 }),
			expect.objectContaining({ qb: "tax_mismatch" })
		);
	});
});
