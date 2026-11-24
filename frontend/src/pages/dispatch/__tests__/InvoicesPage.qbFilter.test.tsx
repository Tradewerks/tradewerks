import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import InvoicesPage from "../InvoicesPage";
import type { Invoice } from "../../../types/invoices";

let invoices: Invoice[] = [];

vi.mock("../../../hooks/useInvoices", () => ({
	useAllInvoicesQuery: () => ({ data: invoices, isLoading: false, error: null }),
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
	}) as unknown as Invoice;

const renderPage = (url = "/dispatch/invoices") =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={[url]}>
				<InvoicesPage />
			</MemoryRouter>
		</QueryClientProvider>
	);

const setAll = () => {
	invoices = [
		mk("F-1", { qb_sync_status: "failed" }),
		mk("T-1", { qb_sync_status: "tax_mismatch" }),
		mk("D-1", { qb_diverged_at: "2026-11-01T00:00:00.000Z", qb_diverged_reason: "refund_not_in_qb" }),
		mk("V-1", {
			status: "Void",
			qb_diverged_at: "2026-11-01T00:00:00.000Z",
			qb_diverged_reason: "qb_payment_delete_failed",
		}),
		mk("OK-1", {}),
		mk("OLD-1", { qb_sync_status: "failed", account_id: "realm-old" }),
	];
};

describe("InvoicesPage — QuickBooks filter", () => {
	it('the QuickBooks filter "Needs attention" shows failed, tax_mismatch and diverged invoices in the current realm only', async () => {
		setAll();
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("button", { name: /QuickBooks: needs attention \(4\)/ }));
		for (const n of ["F-1", "T-1", "D-1", "V-1"]) expect(screen.getByText(n)).toBeInTheDocument();
		expect(screen.queryByText("OK-1")).toBeNull();
		expect(screen.queryByText("OLD-1")).toBeNull();
	});

	it('a failed invoice row shows the QuickBooks warning marker with the tooltip "Not in QuickBooks — retry from the invoice"', () => {
		setAll();
		renderPage();
		const row = screen.getByText("F-1").closest("tr") as HTMLElement;
		expect(
			within(row).getByTitle("Not in QuickBooks — retry from the invoice")
		).toBeInTheDocument();
	});

	it("the QuickBooks marker is named for screen readers, like the tax marker", () => {
		setAll();
		renderPage();
		const failed = screen.getByText("F-1").closest("tr") as HTMLElement;
		const diverged = screen.getByText("D-1").closest("tr") as HTMLElement;
		expect(
			within(failed).getByLabelText("Not in QuickBooks — retry from the invoice")
		).toBeInTheDocument();
		expect(
			within(diverged).getByLabelText("QuickBooks doesn't match — open the invoice")
		).toBeInTheDocument();
	});

	it("existing ?qb=tax_mismatch links still filter to tax mismatches", () => {
		setAll();
		renderPage("/dispatch/invoices?qb=tax_mismatch");
		expect(screen.getByText("T-1")).toBeInTheDocument();
		expect(screen.queryByText("F-1")).toBeNull();
		expect(screen.queryByText("D-1")).toBeNull();
	});
});
