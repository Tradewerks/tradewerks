/**
 * The sheet's one stock & billing answer is sheet state, but the server stores one
 * answer per line — so what reaches submit has to be the resolved per-line values.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TechnicianPurchaseDetailPage from "../TechnicianPurchaseDetailPage";
import type { FieldPurchase } from "../../../types/fieldPurchases";
import type { SheetDisposition } from "../../../components/technician/procurement/lineDrafts";

const purchaseQuery = vi.fn();
const submitAsync = vi.fn();
const idle = { mutateAsync: vi.fn(), isPending: false };
let editorProps: {
	sheetDisposition?: SheetDisposition;
	onSheetDispositionChange?: (d: SheetDisposition) => void;
} = {};

vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchase: (...a: unknown[]) => purchaseQuery(...a),
	usePurchaseLimitGate: () => ({ breaches: [], assumeBreach: false }),
	usePurchaseExtraction: () => ({ data: undefined }),
	useSubmitFieldPurchase: () => ({ mutateAsync: submitAsync, isPending: false }),
	useRequestPreauth: () => idle,
	useDeleteFieldPurchase: () => idle,
	useCreateRefund: () => idle,
}));
vi.mock("../../../hooks/useTechnicians", () => ({
	useTechnicianByIdQuery: () => ({ data: { id: "tech-1", current_vehicle: null } }),
}));
vi.mock("../../../hooks/useJobs", () => ({ useMyJobsQuery: () => ({ data: [] }) }));
vi.mock("../../../components/ui/useToast", () => ({
	useToast: () => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("../../../components/technician/procurement/ReceiptCaptureCard", () => ({
	default: () => <div data-testid="capture" />,
}));
vi.mock("../../../components/technician/procurement/PurchaseLineEditor", () => ({
	default: (p: typeof editorProps) => {
		editorProps = p;
		return (
			<button
				type="button"
				onClick={() =>
					p.onSheetDispositionChange?.({ disposition: "receive", vehicleId: "" })
				}
			>
				all to stock
			</button>
		);
	},
}));

const lineOf = (id: string, unit_price: string, disposition: string | null) => ({
	id,
	description: id,
	quantity: "1",
	unit_price,
	line_total: unit_price,
	inventory_item_id: null,
	inventory_item: null,
	disposition,
	disposition_vehicle_id: null,
	allocation_id: "alloc-a",
	verified_at: "2026-08-31T15:02:00.000Z",
	ocr_confidence: null,
});

const make = (lines: ReturnType<typeof lineOf>[]): FieldPurchase =>
	({
		id: "fp-1",
		kind: "purchase",
		status: "draft",
		vendor_name: "Ferguson",
		receipt_number: "R-100",
		total: "80.00",
		tax_amount: "4.27",
		estimated_amount: null,
		reason: null,
		purchased_at: "2026-08-31T15:00:00.000Z",
		updated_at: "2026-08-31T15:05:00.000Z",
		receipt_image_url: "https://bucket/r.jpg",
		ocr_status: "skipped",
		ocr_field_flags: null,
		ocr_field_review: {},
		flags: [],
		lines,
		allocations: [
			{ id: "alloc-a", job_id: "job-a", job_visit_id: "visit-a", amount: "80.00", job: { name: "A" } },
		],
	}) as unknown as FieldPurchase;

function renderSheet(purchase: FieldPurchase) {
	purchaseQuery.mockReturnValue({
		data: { purchase },
		isLoading: false,
		isError: false,
		isFetching: false,
		refetch: vi.fn(),
	});
	return render(
		<MemoryRouter initialEntries={["/technician/purchases/fp-1"]}>
			<Routes>
				<Route
					path="/technician/purchases/:purchaseId"
					element={<TechnicianPurchaseDetailPage />}
				/>
			</Routes>
		</MemoryRouter>
	);
}

const sentLines = () =>
	(submitAsync.mock.calls[0]![0].sheet.lines as { disposition: string | null }[]).map(
		(l) => l.disposition
	);

beforeEach(() => {
	vi.clearAllMocks();
	editorProps = {};
	submitAsync.mockResolvedValue({ flags: [] });
});

describe("bulk stock & billing reaches submit per line", () => {
	it("a bulk stock answer is sent on every line, discounts left on the job", async () => {
		const user = userEvent.setup();
		renderSheet(
			make([
				lineOf("A", "40.00", "non_stock"),
				lineOf("B", "40.73", "non_stock"),
				lineOf("Promo", "-5.00", "non_stock"),
			])
		);
		expect(editorProps.sheetDisposition).toEqual({ disposition: "non_stock", vehicleId: "" });
		await user.click(screen.getByRole("button", { name: "all to stock" }));
		await user.click(screen.getByRole("button", { name: /submit/i }));
		expect(sentLines()).toEqual(["receive", "receive", "non_stock"]);
	});

	it("lines stored with no answer take the starting one: on the job", async () => {
		const user = userEvent.setup();
		renderSheet(make([lineOf("A", "40.00", null), lineOf("B", "35.73", null)]));
		await user.click(screen.getByRole("button", { name: /submit/i }));
		expect(sentLines()).toEqual(["non_stock", "non_stock"]);
	});
});
