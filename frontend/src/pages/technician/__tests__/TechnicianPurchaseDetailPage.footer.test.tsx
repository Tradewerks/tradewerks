/**
 * The draft footer is the whole bottom of a 390x844 phone. Four stacked blocks
 * made it 153px tall on top of a 64px nav; one button makes it 65px. Discard is
 * destructive and irreversible, so it moved out of thumb range and behind a
 * confirm.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TechnicianPurchaseDetailPage from "../TechnicianPurchaseDetailPage";
import type { FieldPurchase } from "../../../types/fieldPurchases";

const purchaseQuery = vi.fn();
const limitGate = vi.fn();
const removeMutate = vi.fn();
const preauthMutate = vi.fn();
const idle = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchase: (...a: unknown[]) => purchaseQuery(...a),
	usePurchaseLimitGate: (...a: unknown[]) => limitGate(...a),
	usePurchaseExtraction: () => ({ data: undefined }),
	useSubmitFieldPurchase: () => idle,
	useRequestPreauth: () => ({ mutateAsync: preauthMutate, isPending: false }),
	useDeleteFieldPurchase: () => ({ mutateAsync: removeMutate, isPending: false }),
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
vi.mock("../../../components/ui/useToast", () => ({
	useToast: () => ({ error: vi.fn(), success: vi.fn() }),
}));
vi.mock("../../../components/technician/procurement/ReceiptCaptureCard", () => ({
	default: () => <div data-testid="capture" />,
}));
vi.mock("../../../components/technician/procurement/PurchaseLineEditor", () => ({
	default: () => <div data-testid="lines" />,
}));
vi.mock("../../../components/technician/procurement/ReceiptValueDiff", () => ({
	default: () => null,
}));

const draft = (over: Partial<FieldPurchase> = {}): FieldPurchase =>
	({
		id: "fp-1",
		kind: "purchase",
		status: "draft",
		vendor_name: "Counter Supply",
		total: "120.00",
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
				description: "Capacitor",
				quantity: "1",
				unit_price: "120.00",
				line_total: "120.00",
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
				amount: "120.00",
				job: { name: "Job A" },
			},
		],
		...over,
	}) as unknown as FieldPurchase;

const renderSheet = (purchase = draft()) => {
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
};

const bar = (container: HTMLElement) => container.querySelector(".fixed.bottom-16")!;

beforeEach(() => {
	vi.clearAllMocks();
	limitGate.mockReturnValue({ breaches: [], assumeBreach: false });
});

describe("the draft footer", () => {
	it("is one button and nothing else at rest", () => {
		const { container } = renderSheet();
		expect(bar(container).querySelectorAll("button")).toHaveLength(1);
		expect(bar(container)).toHaveClass("py-2.5");
		expect(bar(container).className).not.toContain("space-y-2");
	});

	it("keeps Submit enabled and named on a complete draft", () => {
		renderSheet();
		expect(screen.getByRole("button", { name: /submit for review/i })).toBeEnabled();
	});

	// The reason costs no line of its own: it IS the dead button.
	it("puts the blocking reason in the disabled button", () => {
		renderSheet(draft({ receipt_image_url: null }));

		expect(
			screen.getByRole("button", { name: /photograph the receipt first/i })
		).toBeDisabled();
		expect(screen.queryByRole("button", { name: /submit for review/i })).toBeNull();
	});

	it("announces the reason to a screen reader", () => {
		renderSheet(draft({ receipt_image_url: null }));
		expect(screen.getByRole("status")).toHaveTextContent(
			/photograph the receipt first/i
		);
	});
});

// `Number("")` is 0 and `Number("abc")` is NaN, so a blank price bills a
// line at $0.00 and a typo'd one serializes as null and fails at the
// server with a generic error. Neither gate above this one touches
// amounts, so a complete-in-every-other-way draft is the only way to
// prove this gate fires on its own.
describe("blocking on a blank or non-numeric quantity or price", () => {
	const line = (over: Partial<FieldPurchase["lines"][number]> = {}) => ({
		...draft().lines[0]!,
		...over,
	});

	it("blocks a blank price", () => {
		renderSheet(draft({ lines: [line({ quantity: "2", unit_price: "" })] }));
		expect(
			screen.getByRole("button", { name: /enter a number for quantity and price/i })
		).toBeDisabled();
	});

	it("blocks a blank quantity", () => {
		renderSheet(draft({ lines: [line({ quantity: "", unit_price: "24.99" })] }));
		expect(
			screen.getByRole("button", { name: /enter a number for quantity and price/i })
		).toBeDisabled();
	});

	// A text input takes a paste or a physical keyboard; `inputMode` only hints
	// the mobile one. `Number("abc")` is NaN, which passes no numeric check.
	it("blocks a price that is not a number", () => {
		renderSheet(draft({ lines: [line({ quantity: "2", unit_price: "abc" })] }));
		expect(
			screen.getByRole("button", { name: /enter a number for quantity and price/i })
		).toBeDisabled();
	});

	// A lone "-" or "." trims to something non-empty but is still not a number.
	it("blocks a quantity that is a lone separator", () => {
		renderSheet(draft({ lines: [line({ quantity: "-", unit_price: "24.99" })] }));
		expect(
			screen.getByRole("button", { name: /enter a number for quantity and price/i })
		).toBeDisabled();
	});

	it("submits once both are filled in", () => {
		renderSheet(draft({ lines: [line({ quantity: "2", unit_price: "24.99" })] }));
		expect(screen.getByRole("button", { name: /submit for review/i })).toBeEnabled();
	});

	// A free part is a real price, and the server's signedMoney check allows
	// it. Only quantity has a positivity rule on the server side, and this
	// gate deliberately does not duplicate it — see the fix report.
	it("submits a zero price, which is what a free part costs", () => {
		renderSheet(draft({ lines: [line({ quantity: "1", unit_price: "0" })] }));
		expect(screen.getByRole("button", { name: /submit for review/i })).toBeEnabled();
	});
});

describe("discarding a draft", () => {
	it("is out of the footer", () => {
		const { container } = renderSheet();
		expect(bar(container).textContent).not.toMatch(/discard/i);
	});

	it("is a 44px action in the header", () => {
		renderSheet();
		const discard = screen.getByRole("button", { name: /discard this draft/i });
		expect(discard).toHaveClass("h-11");
		expect(discard.closest("header")).not.toBeNull();
	});

	it("confirms before it deletes", async () => {
		renderSheet();

		await userEvent.click(screen.getByRole("button", { name: /discard this draft/i }));
		expect(removeMutate).not.toHaveBeenCalled();
		expect(
			screen.getByRole("dialog", { name: /discard this draft/i })
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /^discard$/i }));
		expect(removeMutate).toHaveBeenCalledWith("fp-1");
	});

	// ConfirmDialog is z-50 and so is the technician bottom nav, which renders
	// after the page — without a stacking context of its own the nav paints over
	// the confirm and stays tappable.
	it("sits above the bottom nav", async () => {
		renderSheet();
		await userEvent.click(screen.getByRole("button", { name: /discard this draft/i }));

		const dialog = screen.getByRole("dialog", { name: /discard this draft/i });
		expect(dialog.closest(".z-\\[60\\]")).not.toBeNull();
	});

	it("backs out cleanly", async () => {
		renderSheet();
		await userEvent.click(screen.getByRole("button", { name: /discard this draft/i }));
		await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
		expect(removeMutate).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("is offered only on a draft", () => {
		renderSheet(draft({ status: "queried" }));
		expect(screen.queryByRole("button", { name: /discard this draft/i })).toBeNull();
	});
});

describe("the pre-approval footer", () => {
	const line = (over: Partial<FieldPurchase["lines"][number]> = {}) => ({
		...draft().lines[0]!,
		...over,
	});

	it("still asks, without a permanent hint line", () => {
		limitGate.mockReturnValue({
			breaches: [{ code: "per_transaction", limit: "50.00", would_be: "120.00" }],
			assumeBreach: false,
		});
		const { container } = renderSheet();

		expect(
			screen.getByRole("button", { name: /send for pre-approval/i })
		).toBeEnabled();
		expect(screen.getByText(/dispatch has to approve it/i)).toBeInTheDocument();
		expect(bar(container).textContent).not.toMatch(/then this is reimbursed/i);
	});

	// The button that switches flows must not be the one that discards what the
	// technician already typed.
	it("sends the typed sheet with a pre-approval request", async () => {
		limitGate.mockReturnValue({
			breaches: [{ code: "per_transaction", limit: "50.00", would_be: "120.00" }],
			assumeBreach: false,
		});
		renderSheet(
			draft({
				lines: [
					{
						...draft().lines[0]!,
						description: "Blower motor",
						quantity: "1",
						unit_price: "412.50",
					},
				],
			})
		);

		await userEvent.click(screen.getByRole("button", { name: /pre-approval/i }));

		expect(preauthMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				sheet: expect.objectContaining({
					lines: [expect.objectContaining({ description: "Blower motor" })],
				}),
			})
		);
	});

	// The button is deliberately not gated on a finished sheet - a sheet that
	// cannot be validated must still be able to ask.
	it("asks for pre-approval with a line still half-typed, sending the header without the lines", async () => {
		limitGate.mockReturnValue({
			breaches: [{ code: "per_transaction", limit: "50.00", would_be: "120.00" }],
			assumeBreach: false,
		});
		renderSheet(
			draft({
				lines: [
					line({ description: "Blower motor" }),
					line({ id: "line-2", unit_price: "" }),
				],
			})
		);

		await userEvent.click(screen.getByRole("button", { name: /pre-approval/i }));

		expect(preauthMutate).toHaveBeenCalledWith(
			expect.objectContaining({ sheet: expect.objectContaining({ lines: undefined }) })
		);
	});
});

// `preauth_denied`, not `pending_preauth`: only the denied one is tech-editable, so
// it is the only awaiting-purchase state that renders an action bar at all.
describe("the denied-pre-approval footer", () => {
	it("blocks on the estimate through the button label", () => {
		renderSheet(
			draft({ status: "preauth_denied", estimated_amount: "0.00", total: "0.00" })
		);

		expect(
			screen.getByRole("button", { name: /put an estimated cost in first/i })
		).toBeDisabled();
	});

	it("asks again once there is one", () => {
		renderSheet(draft({ status: "preauth_denied", estimated_amount: "80.00" }));

		expect(screen.getByRole("button", { name: /ask dispatch again/i })).toBeEnabled();
	});
});
