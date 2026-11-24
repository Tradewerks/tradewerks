import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AxiosError } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import InvoiceDetailPage from "../InvoiceDetailPage";
import { useAuthStore } from "../../../auth/authStore";
import type { Invoice } from "../../../types/invoices";

const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
const reconcileMutation = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false };
const syncMutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/useInvoices", () => ({
	useInvoiceByIdQuery: () => ({ data: invoice, isLoading: false }),
	useUpdateInvoiceMutation: () => idle,
	useDeleteInvoiceMutation: () => idle,
	useCreateInvoicePaymentMutation: () => idle,
	useDeleteInvoicePaymentMutation: () => idle,
	useRecordRefundMutation: () => idle,
}));
vi.mock("../../../hooks/useDisputes", () => ({
	useDisputesQuery: () => ({ data: undefined, isError: false }),
}));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: true, realmId: "realm-1" } }),
	useQBInvoiceSyncMutation: () => syncMutation,
	useQBInvoiceEmailMutation: () => idle,
	useMarkQbReconciledMutation: () => reconcileMutation,
}));
vi.mock("../../../hooks/useTaxSettings", () => ({
	useAcknowledgeTaxReview: () => idle,
}));
vi.mock("../../../components/disputes/DisputeModal", () => ({ default: () => null }));
vi.mock("../../../components/activity/ChangeHistory", () => ({ default: () => null }));
vi.mock("../../../components/detail/ActivityPanel", () => ({ default: () => null }));
vi.mock("../../../components/lifecycle/LifecycleRecord", () => ({ default: () => null }));
vi.mock("../../../components/clients/ClientDetailsCard", () => ({ default: () => null }));
vi.mock("../../../components/invoices/InvoiceNoteManager", () => ({ default: () => null }));
vi.mock("../../../components/invoices/InvoiceOriginCard", () => ({ default: () => null }));
vi.mock("../../../components/invoices/InvoiceLineItems", () => ({ default: () => null }));
vi.mock("../../../components/invoices/EditInvoice", () => ({ default: () => null }));

const base = {
	id: "inv-1",
	invoice_number: "INV-1001",
	status: "Issued",
	client_id: "c1",
	client: { id: "c1", name: "Acme", contacts: [] },
	account_id: "realm-1",
	subtotal: 0,
	tax_amount: 0,
	total: 0,
	amount_paid: 0,
	created_at: "2026-09-01T00:00:00.000Z",
	updated_at: "2026-09-01T00:00:00.000Z",
	line_items: [],
	payments: [],
	jobs: [],
	visits: [],
} as unknown as Invoice;

let invoice: Invoice = base;

const renderPage = () =>
	render(
		<QueryClientProvider client={new QueryClient()}>
			<MemoryRouter initialEntries={["/dispatch/invoices/inv-1"]}>
				<Routes>
					<Route path="/dispatch/invoices/:invoiceId" element={<InvoiceDetailPage />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);

const login = (perms: string[]) =>
	useAuthStore
		.getState()
		.login("dispatcher", "Alex", "d1", "org", "America/Chicago", perms);

beforeEach(() => {
	useAuthStore
		.getState()
		.login("dispatcher", "Alex", "d1", "org", "America/Chicago", [
			"view_invoices",
			"edit_invoices",
			"send_invoices",
		]);
});

describe("InvoiceDetailPage — QuickBooks credit memo state", () => {
	it("labels a synced credit adjustment as a QuickBooks credit memo", async () => {
		invoice = {
			...base,
			adjusts_invoice_id: "inv-0",
			total: -17.93,
			qb_sync_status: "synced",
			qb_credit_memo_id: "cm-1",
			qb_invoice_id: null,
		} as unknown as Invoice;
		const user = userEvent.setup();
		renderPage();

		expect(screen.getByText("In QuickBooks")).toHaveAttribute(
			"title",
			"Synced to QuickBooks credit memo #cm-1"
		);
		await user.click(screen.getByRole("button", { name: "Invoice actions" }));
		expect(screen.queryByRole("menuitem", { name: "Send via QuickBooks" })).toBeNull();
	});

	it("uses credit memo wording for an unsynced credit adjustment", () => {
		invoice = {
			...base,
			adjusts_invoice_id: "inv-0",
			total: -17.93,
			qb_sync_status: "not_synced",
			qb_credit_memo_id: null,
			qb_invoice_id: null,
		} as unknown as Invoice;
		renderPage();

		expect(screen.getByText("Not in QuickBooks")).toHaveAttribute(
			"title",
			"This credit memo has not been pushed to QuickBooks yet"
		);
		expect(screen.getByRole("button", { name: "Sync to QuickBooks" })).toHaveAttribute(
			"title",
			"Create this credit memo in QuickBooks Online (one-way sync — nothing is pulled back)"
		);
	});

	it("shows no remote id and no Send via QuickBooks for a synced credit with no ids", async () => {
		invoice = {
			...base,
			adjusts_invoice_id: "inv-0",
			total: -17.93,
			qb_sync_status: "synced",
			qb_credit_memo_id: null,
			qb_invoice_id: null,
		} as unknown as Invoice;
		const user = userEvent.setup();
		renderPage();

		const title = screen.getByText("In QuickBooks").getAttribute("title");
		expect(title).toBe("Synced to QuickBooks credit memo");
		expect(title).not.toContain("null");
		await user.click(screen.getByRole("button", { name: "Invoice actions" }));
		expect(screen.queryByRole("menuitem", { name: "Send via QuickBooks" })).toBeNull();
	});

	it("shows the tax mismatch of a credit as absolute amounts", () => {
		invoice = {
			...base,
			adjusts_invoice_id: "inv-0",
			total: -17.93,
			tax_amount: -0.93,
			qb_tax_amount: 1.1,
			qb_sync_status: "tax_mismatch",
			qb_credit_memo_id: "cm-1",
			qb_invoice_id: null,
		} as unknown as Invoice;
		renderPage();

		expect(screen.getByRole("status")).toHaveTextContent(
			"QuickBooks calculated $1.10 tax; this credit memo credits $0.93"
		);
	});

	it("shows the server's message when a manual sync fails", async () => {
		invoice = { ...base, total: 100, qb_sync_status: "not_synced" } as unknown as Invoice;
		syncMutation.mutate.mockImplementationOnce((_id: string, opts: { onError: (e: unknown) => void }) =>
			opts.onError(
				new AxiosError("Request failed", "ERR_BAD_REQUEST", undefined, undefined, {
					data: {
						error: { code: "QB_REJECTED", message: "QuickBooks rejected this document: X" },
					},
				} as never)
			)
		);
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Sync to QuickBooks" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"QuickBooks rejected this document: X"
		);
	});

	it("keeps the invoice wording and the Send via QuickBooks action for an invoice", async () => {
		invoice = {
			...base,
			total: 100,
			qb_sync_status: "synced",
			qb_invoice_id: "qb-9",
		} as unknown as Invoice;
		const user = userEvent.setup();
		renderPage();

		expect(screen.getByText("In QuickBooks")).toHaveAttribute(
			"title",
			"Synced to QuickBooks invoice #qb-9"
		);
		await user.click(screen.getByRole("button", { name: "Invoice actions" }));
		expect(screen.getByRole("menuitem", { name: "Send via QuickBooks" })).toBeInTheDocument();
	});
});

describe("InvoiceDetailPage — QB_TAX_ZERO", () => {
	it("shows the QuickBooks zero-tax panel once, with no error banner", async () => {
		invoice = { ...base, status: "Draft", total: 100 } as unknown as Invoice;
		idle.mutateAsync.mockRejectedValueOnce(
			new AxiosError("Conflict", "ERR_BAD_REQUEST", undefined, undefined, {
				data: {
					error: {
						code: "QB_TAX_ZERO",
						message: "QuickBooks charged no tax.",
						details: { items: ["Copper pipe"], line_ids: ["l1"] },
					},
				},
			} as never)
		);
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Invoice actions" }));
		await user.click(screen.getAllByText("Create Without Sending")[0]);

		expect(await screen.findAllByText(/QuickBooks charged no tax\. Check/)).toHaveLength(1);
		expect(screen.getByText(/Copper pipe/)).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});

describe("InvoiceDetailPage — QuickBooks divergence", () => {
	const diverged = () =>
		({
			...base,
			qb_sync_status: "synced",
			qb_diverged_at: "2026-11-01T00:00:00.000Z",
			qb_diverged_reason: "refund_not_in_qb",
		}) as unknown as Invoice;

	it("a diverged invoice shows the banner for its reason and a Mark reconciled button for edit_invoices", async () => {
		invoice = diverged();
		const user = userEvent.setup();
		renderPage();
		expect(
			screen.getByText(/Record the refund in QuickBooks, then mark the invoice reconciled./)
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Mark reconciled" }));
		expect(
			screen.getByText(
				"Mark Invoice INV-1001 as matching QuickBooks? Do this after you've fixed it in QuickBooks."
			)
		).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Mark as matching" }));
		// The time the page showed, so a problem added since is not cleared unseen.
		expect(reconcileMutation.mutateAsync).toHaveBeenCalledWith({
			invoiceId: "inv-1",
			divergedAt: "2026-11-01T00:00:00.000Z",
		});
	});

	it("a diverged invoice with several reasons lists each on its own line", () => {
		invoice = {
			...diverged(),
			qb_diverged_reason: "refund_not_in_qb,qb_payment_duplicate,void_not_in_qb",
		} as unknown as Invoice;
		renderPage();
		const banner = screen.getByRole("status", { name: "QuickBooks problems" });
		const lines = within(banner).getAllByRole("listitem");
		expect(lines.map((l) => l.textContent)).toEqual([
			"Refund not in QuickBooks. Record the refund in QuickBooks, then mark the invoice reconciled.",
			"Payment recorded twice in QuickBooks. Delete the extra payment in QuickBooks, then mark the invoice reconciled.",
			"Void not in QuickBooks. Void the invoice in QuickBooks, then mark the invoice reconciled.",
		]);
		expect(within(banner).getAllByRole("button", { name: "Mark reconciled" })).toHaveLength(1);
	});

	it("shows the new divergence reasons with their own copy", () => {
		invoice = {
			...diverged(),
			qb_diverged_reason: "qb_payment_on_void,refund_exceeds_payments",
		} as unknown as Invoice;
		renderPage();
		expect(
			screen.getByText(
				/Move or refund the payment in QuickBooks, then mark the invoice reconciled\./
			)
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/A payment was changed in QuickBooks\. Check it, then mark the invoice reconciled\./
			)
		).toBeInTheDocument();
	});

	it("a second confirm after a 409 still sends the diverged_at the dialog opened with", async () => {
		invoice = diverged();
		const conflict = new AxiosError("Request failed with status code 409");
		conflict.response = {
			status: 409,
			data: {
				success: false,
				data: null,
				error: {
					code: "QB_DIVERGENCE_CHANGED",
					message: "QuickBooks problems on this invoice changed. Reload and check again.",
				},
			},
		} as never;
		reconcileMutation.mutateAsync.mockClear();
		reconcileMutation.mutateAsync.mockRejectedValueOnce(conflict);
		const user = userEvent.setup();
		const { rerender } = renderPage();
		await user.click(screen.getByRole("button", { name: "Mark reconciled" }));
		await user.click(screen.getByRole("button", { name: "Mark as matching" }));

		// The 409 refetch lands while the dialog is still open.
		invoice = {
			...diverged(),
			qb_diverged_at: "2026-11-02T00:00:00.000Z",
			qb_diverged_reason: "refund_not_in_qb,qb_payment_duplicate",
		} as unknown as Invoice;
		rerender(
			<QueryClientProvider client={new QueryClient()}>
				<MemoryRouter initialEntries={["/dispatch/invoices/inv-1"]}>
					<Routes>
						<Route path="/dispatch/invoices/:invoiceId" element={<InvoiceDetailPage />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>
		);
		await user.click(screen.getByRole("button", { name: "Mark as matching" }));

		expect(reconcileMutation.mutateAsync).toHaveBeenCalledTimes(2);
		expect(reconcileMutation.mutateAsync).toHaveBeenLastCalledWith({
			invoiceId: "inv-1",
			divergedAt: "2026-11-01T00:00:00.000Z",
		});
	});

	it("a 409 from Mark reconciled shows the server's message inside the dialog", async () => {
		invoice = diverged();
		const conflict = new AxiosError("Request failed with status code 409");
		conflict.response = {
			status: 409,
			data: {
				success: false,
				data: null,
				error: {
					code: "QB_DIVERGENCE_CHANGED",
					message: "QuickBooks problems on this invoice changed. Reload and check again.",
				},
			},
		} as never;
		reconcileMutation.mutateAsync.mockRejectedValueOnce(conflict);
		const user = userEvent.setup();
		renderPage();
		await user.click(screen.getByRole("button", { name: "Mark reconciled" }));
		await user.click(screen.getByRole("button", { name: "Mark as matching" }));
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).getByText(
				"QuickBooks problems on this invoice changed. Reload and check again."
			)
		).toBeInTheDocument();
	});

	it("Mark reconciled is absent without edit_invoices", () => {
		login(["view_invoices"]);
		invoice = diverged();
		renderPage();
		expect(screen.getByText(/mark the invoice reconciled/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Mark reconciled" })).toBeNull();
	});
});
