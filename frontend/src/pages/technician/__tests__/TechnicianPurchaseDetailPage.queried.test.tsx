/**
 * A queried purchase has already been submitted once, so the money is spent and a
 * breach is information for the dispatcher who asked the question — not a gate that
 * sends the technician back for permission they can no longer usefully get.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TechnicianPurchaseDetailPage from "../TechnicianPurchaseDetailPage";
import type { FieldPurchase, LimitBreach } from "../../../types/fieldPurchases";

const purchaseQuery = vi.fn();
const limitGate = vi.fn();
const idle = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchase: (...a: unknown[]) => purchaseQuery(...a),
	usePurchaseLimitGate: (...a: unknown[]) => limitGate(...a),
	usePurchaseExtraction: () => ({ data: undefined }),
	useSubmitFieldPurchase: () => idle,
	useRequestPreauth: () => idle,
	useDeleteFieldPurchase: () => idle,
	useCreateRefund: () => idle,
}));
vi.mock("../../../hooks/useTechnicians", () => ({
	// The truck the sheet's stocked lines may name. Mocked because the page reads it
	// from the profile rather than the URL it was opened with.
	useTechnicianByIdQuery: () => ({
		data: { id: "tech-1", current_vehicle: { id: "veh-1", name: "Truck 12" } },
	}),
}));
vi.mock("../../../hooks/useJobs", () => ({ useMyJobsQuery: () => ({ data: [] }) }));
vi.mock("../../../components/ui/useToast", () => ({ useToast: () => vi.fn() }));

// The capture and line surfaces pull the camera and the item picker in; neither is
// what this test is about.
vi.mock("../../../components/technician/procurement/ReceiptCaptureCard", () => ({
	default: () => <div data-testid="capture" />,
}));
vi.mock("../../../components/technician/procurement/PurchaseLineEditor", () => ({
	default: () => <div data-testid="lines" />,
}));
vi.mock("../../../components/technician/procurement/ReceiptValueDiff", () => ({
	default: () => null,
}));

const BREACH: LimitBreach = {
	code: "per_transaction",
	limit: "500.00",
	would_be: "900.00",
};

const queried = (): FieldPurchase =>
	({
		id: "fp-1",
		kind: "purchase",
		status: "queried",
		vendor_name: "Counter Supply",
		total: "900.00",
		tax_amount: "0.00",
		estimated_amount: null,
		reason: null,
		purchased_at: "2026-08-31T15:00:00.000Z",
		updated_at: "2026-08-31T15:05:00.000Z",
		receipt_image_url: "https://bucket/r.jpg",
		ocr_status: "skipped",
		flags: [],
		lines: [
			{
				id: "line-1",
				description: "Compressor",
				quantity: "1",
				unit_price: "900.00",
				line_total: "900.00",
				inventory_item_id: null,
				inventory_item: null,
				disposition: "non_stock",
				disposition_vehicle_id: null,
				allocation_id: "alloc-a",
				verified_at: "2026-08-31T15:02:00.000Z",
				ocr_confidence: null,
			},
		],
		allocations: [
			{
				id: "alloc-a",
				job_id: "job-a",
				job_visit_id: "visit-a",
				amount: "900.00",
				job: { name: "Job A" },
			},
		],
	}) as unknown as FieldPurchase;

const renderSheet = () =>
	render(
		<MemoryRouter initialEntries={["/technician/purchases/fp-1"]}>
			<Routes>
				<Route
					path="/technician/purchases/:purchaseId"
					element={<TechnicianPurchaseDetailPage />}
				/>
			</Routes>
		</MemoryRouter>
	);

beforeEach(() => {
	vi.clearAllMocks();
	purchaseQuery.mockReturnValue({
		data: { purchase: queried() },
		isLoading: false,
		isError: false,
		isFetching: false,
		refetch: vi.fn(),
	});
	limitGate.mockReturnValue({ breaches: [BREACH], assumeBreach: false });
});

describe("a queried purchase over a limit", () => {
	it("offers submit, not pre-approval", () => {
		renderSheet();

		expect(screen.getByRole("button", { name: /submit for review/i })).toBeEnabled();
		expect(screen.queryByRole("button", { name: /send for pre-approval/i })).toBeNull();
	});

	// The number is what the technician acts on, so it has to survive the swap.
	it("still shows the breach notice beside it", () => {
		renderSheet();

		expect(screen.getByText(/dispatch has to approve it/i)).toBeInTheDocument();
	});
});
