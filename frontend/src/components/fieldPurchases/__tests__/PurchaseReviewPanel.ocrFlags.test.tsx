import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import PurchaseReviewPanel from "../PurchaseReviewPanel";
import type { FieldPurchase, OcrFieldReview, OcrFlagSet } from "../../../types/fieldPurchases";

const purchaseQuery = vi.fn();
const idle = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchase: (...a: unknown[]) => purchaseQuery(...a),
	useReviewFieldPurchase: () => idle,
	useDecidePreauth: () => idle,
	useSecondSignoff: () => idle,
	useSettleRefund: () => idle,
	useLinkSupplier: () => idle,
	useAssignLineJob: () => idle,
	useCaptureLocation: () => ({ data: undefined, isLoading: false }),
}));
vi.mock("../../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: false } }),
	usePushFieldPurchaseToQBMutation: () => idle,
}));
vi.mock("../../suppliers/SupplierFormModal", () => ({ default: () => null }));
vi.mock("../../../hooks/useSuppliers", () => ({ useSuppliers: () => ({ data: [] }) }));
vi.mock("../../../hooks/usePermission", () => ({ usePermission: () => false }));
vi.mock("../../ui/useToast", () => ({
	useToast: () => Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }),
}));
vi.mock("../ReceiptViewer", () => ({ default: () => <div /> }));
vi.mock("../PurchaseTimeline", () => ({ default: () => <div /> }));

const FLAGS: OcrFlagSet = {
	line_cutoff: 0.75,
	fields: {
		vendor_name: { kind: "unsure", confidence: 0.6, rule: null },
		receipt_number: { kind: "unsure", confidence: 0.5, rule: null },
		subtotal: { kind: "calculated", confidence: null, rule: null },
		total: { kind: "calculated", confidence: null, rule: null },
	},
};

const make = (over: Partial<FieldPurchase> = {}): FieldPurchase =>
	({
		id: "fp-1",
		kind: "purchase",
		status: "pending_review",
		vendor_name: "Ferguson",
		receipt_number: "R-100",
		subtotal: "75.73",
		tax_amount: "4.27",
		total: "80.00",
		purchased_at: "2026-08-31T15:00:00.000Z",
		submitted_at: "2026-08-31T16:00:00.000Z",
		created_at: "2026-08-31T15:00:00.000Z",
		receipt_image_url: "https://bucket/r.jpg",
		ocr_status: "succeeded",
		ocr_field_confidence: {},
		ocr_field_flags: FLAGS,
		ocr_field_review: {},
		flags: [],
		technician: { id: "t1", name: "Tom" },
		allocations: [],
		lines: [
			{
				id: "l1",
				description: "Compressor",
				quantity: "1",
				unit_price: "75.73",
				line_total: "75.73",
				ocr_confidence: "0.4",
				verified_at: "2026-08-31T15:30:00.000Z",
				disposition: "non_stock",
				inventory_item_id: null,
				inventory_item: null,
			},
			{
				id: "l2",
				description: "Clean line",
				quantity: "1",
				unit_price: "1.00",
				line_total: "1.00",
				ocr_confidence: "0.9",
				verified_at: "2026-08-31T15:30:00.000Z",
				disposition: "non_stock",
				inventory_item_id: null,
				inventory_item: null,
			},
		],
		...over,
	}) as unknown as FieldPurchase;

const renderPanel = (p: FieldPurchase) => {
	purchaseQuery.mockReturnValue({
		data: { purchase: p, timeline: [], grant: null },
		isLoading: false,
		isError: false,
		isFetching: false,
		refetch: vi.fn(),
	});
	return render(
		<MemoryRouter>
			<PurchaseReviewPanel purchaseId="fp-1" onDecided={vi.fn()} />
		</MemoryRouter>
	);
};

const rev = (state: "confirmed" | "edited"): OcrFieldReview["vendor_name"] => ({
	state,
	at: "2026-08-31T15:40:00.000Z",
});

beforeEach(() => purchaseQuery.mockReset());

describe("PurchaseReviewPanel scan flags", () => {
	it("unresolved fields appear in summary with chips", () => {
		renderPanel(make());
		expect(
			screen.getByText("Check against photo: Vendor, Receipt #, Subtotal, Total")
		).toBeInTheDocument();
		expect(screen.getByText("Receipt #")).toBeInTheDocument();
		expect(screen.getByText("R-100")).toBeInTheDocument();
		expect(screen.getAllByRole("button", { name: /Unsure/ })).toHaveLength(2);
		expect(screen.getAllByRole("button", { name: /Calculated/ })).toHaveLength(2);
	});

	it("tech-confirmed field shows Checked by tech and is not in summary", () => {
		renderPanel(make({ ocr_field_review: { vendor_name: rev("confirmed") } }));
		expect(screen.getByRole("button", { name: /Checked by tech/ })).toBeInTheDocument();
		expect(screen.getByText(/Check against photo:/).textContent).not.toMatch(/Vendor/);
	});

	it("edited shows Edited by tech", () => {
		renderPanel(make({ ocr_field_review: { receipt_number: rev("edited") } }));
		expect(screen.getByRole("button", { name: /Edited by tech/ })).toBeInTheDocument();
	});

	it("no chips or summary when ocr_field_flags null", () => {
		renderPanel(make({ ocr_field_flags: null }));
		expect(screen.queryByText(/Check against photo/)).toBeNull();
		expect(
			screen.queryByRole("button", { name: /Unsure|Calculated|Checked|Edited/ })
		).toBeNull();
		expect(screen.queryByRole("button", { name: /low confidence/i })).toBeNull();
	});

	it("line below line_cutoff shows tappable marker with reason", async () => {
		renderPanel(make());
		const marks = screen.getAllByRole("button", { name: /Read with low confidence/ });
		expect(marks).toHaveLength(1);
		expect(document.querySelector('[title*="sure"]')).toBeNull();
		await userEvent.click(marks[0]!);
		expect(
			within(screen.getByRole("tooltip", { hidden: true })).getByText(/40% sure/)
		).toBeInTheDocument();
	});

	it("line marker opens with Enter and closes with Escape", async () => {
		renderPanel(make());
		const mark = screen.getByRole("button", { name: /Read with low confidence/ });
		mark.focus();
		await userEvent.keyboard("{Enter}");
		expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("tooltip", { hidden: true })).toBeNull();
		await userEvent.keyboard(" ");
		expect(screen.getByRole("tooltip", { hidden: true })).toBeInTheDocument();
	});
});
