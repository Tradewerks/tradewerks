/**
 * A refund reuses the purchase sheet, so everything it says has to read as money
 * coming back — and the purchase it came from has to say what is already out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TechnicianPurchaseDetailPage from "../TechnicianPurchaseDetailPage";
import type {
	FieldPurchase,
	FieldPurchaseRefundParent,
	FieldPurchaseRefundSummary,
} from "../../../types/fieldPurchases";

const purchaseQuery = vi.fn();
const refundMutate = vi.fn();
const idle = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchase: (...a: unknown[]) => purchaseQuery(...a),
	usePurchaseLimitGate: () => ({ breaches: [], assumeBreach: false }),
	usePurchaseExtraction: () => ({ data: undefined }),
	useSubmitFieldPurchase: () => idle,
	useRequestPreauth: () => idle,
	useDeleteFieldPurchase: () => idle,
	useCreateRefund: () => ({ mutateAsync: refundMutate, isPending: false }),
}));
vi.mock("../../../hooks/useTechnicians", () => ({
	useTechnicianByIdQuery: () => ({ data: { id: "tech-1", current_vehicle: null } }),
}));
vi.mock("../../../hooks/useJobs", () => ({
	useMyJobsQuery: () => ({ data: [{ job_id: "job-b", job_name: "Job B", visit_id: null }] }),
}));
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

const parent = (over: Partial<FieldPurchaseRefundParent> = {}): FieldPurchaseRefundParent => ({
	id: "fp-parent",
	vendor_name: "Counter Supply",
	total: "120.00",
	purchased_at: "2026-08-31T15:00:00.000Z",
	remaining: "120.00",
	lines: [],
	...over,
});

const sheet = (over: Partial<FieldPurchase> = {}): FieldPurchase =>
	({
		id: "fp-1",
		kind: "refund",
		status: "draft",
		parent_purchase_id: "fp-parent",
		refund_settled_at: null,
		vendor_name: "Counter Supply",
		total: "40.00",
		tax_amount: "0.00",
		estimated_amount: null,
		reason: null,
		purchased_at: "2026-09-02T15:00:00.000Z",
		updated_at: "2026-09-02T15:05:00.000Z",
		receipt_image_url: "https://bucket/slip.jpg",
		ocr_status: "skipped",
		flags: [],
		lines: [
			{
				id: "line-1",
				description: "Capacitor",
				quantity: "1",
				unit_price: "40.00",
				line_total: "40.00",
				inventory_item_id: null,
				inventory_item: null,
				disposition: null,
				disposition_vehicle_id: null,
				allocation_id: "alloc-a",
				verified_at: "2026-09-02T15:02:00.000Z",
				ocr_confidence: null,
			},
		],
		allocations: [
			{
				id: "alloc-a",
				job_id: "job-a",
				job_visit_id: null,
				amount: "40.00",
				job: { name: "Job A" },
			},
		],
		parent: parent(),
		...over,
	}) as unknown as FieldPurchase;

const summary = (over: Partial<FieldPurchaseRefundSummary> = {}): FieldPurchaseRefundSummary => ({
	draft_id: null,
	in_progress_count: 0,
	in_progress_value: "0",
	approved_value: "0",
	settled_value: "0",
	remaining: "120",
	refunds: [],
	...over,
});

const refundRow = (
	over: Partial<FieldPurchaseRefundSummary["refunds"][number]> = {}
): FieldPurchaseRefundSummary["refunds"][number] => ({
	id: "r1",
	status: "approved",
	amount: "25",
	refund_settled_at: null,
	created_at: "2026-09-01T00:00:00Z",
	returned_at: "2026-09-02T00:00:00Z",
	parts: [{ description: "Capacitor", quantity: "2" }],
	...over,
});

const approvedPurchase = (s: FieldPurchaseRefundSummary) =>
	sheet({
		kind: "purchase",
		status: "approved",
		parent_purchase_id: null,
		parent: undefined,
		refund_summary: s,
	});

const renderSheet = (purchase: FieldPurchase) => {
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

beforeEach(() => vi.clearAllMocks());

describe("a refund sheet", () => {
	it("speaks in credit, not spend", () => {
		renderSheet(sheet());
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("New refund");
		expect(screen.getByText("Credit slip details")).toBeInTheDocument();
		expect(screen.getByText("Credit total")).toBeInTheDocument();
		expect(screen.getByText("When you returned it")).toBeInTheDocument();
		expect(screen.getByText("Jobs credited")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Send refund to dispatch/ })
		).toBeEnabled();
		expect(screen.queryByText("Total paid")).not.toBeInTheDocument();
		expect(screen.queryByText(/Submit for review/)).not.toBeInTheDocument();
	});

	it("shows the amount as coming back", () => {
		renderSheet(sheet());
		expect(screen.getByRole("heading", { level: 1 }).parentElement).toHaveTextContent(
			"−$40.00"
		);
	});

	it("links to the purchase it reverses and says what is left", () => {
		renderSheet(sheet({ parent: parent({ remaining: "80.00" }) }));
		const link = screen.getByRole("link", { name: /Original purchase/ });
		expect(link).toHaveAttribute("href", "/technician/purchases/fp-parent");
		expect(link).toHaveTextContent("Counter Supply");
		expect(link).toHaveTextContent("Up to $80.00 can still be refunded");
	});

	it("drops the ceiling once the refund can no longer change", () => {
		renderSheet(sheet({ status: "approved" }));
		const link = screen.getByRole("link", { name: /Original purchase/ });
		expect(link).not.toHaveTextContent("can still be refunded");
	});

	it("keeps the store fixed — the part goes back where it came from", () => {
		renderSheet(sheet());
		expect(screen.getByLabelText("Returned to")).toBeDisabled();
	});

	it("offers no other jobs to credit", () => {
		renderSheet(sheet());
		expect(screen.queryByText("Also bought for another job?")).not.toBeInTheDocument();
		expect(
			screen.getByText("Dispatch takes this off the customer's bill.")
		).toBeInTheDocument();
	});

	it("blocks a claim above what is left to refund, in the button", () => {
		renderSheet(sheet({ parent: parent({ remaining: "30.00" }) }));
		expect(
			screen.getByRole("button", { name: "More than the $30.00 left to refund" })
		).toBeDisabled();
	});

	it("asks for the credit slip, not a receipt", () => {
		renderSheet(sheet({ receipt_image_url: null }));
		expect(
			screen.getByRole("button", { name: "Photograph the credit slip first" })
		).toBeDisabled();
	});

	it("reassures on discard that the purchase is untouched", async () => {
		renderSheet(sheet());
		await userEvent.click(screen.getByRole("button", { name: "Discard this refund" }));
		expect(
			screen.getByText(/The original purchase is not affected/)
		).toBeInTheDocument();
	});

	it.each([
		[{ status: "pending_review" }, "Refund · With dispatch"],
		[{ status: "queried" }, "Refund · Needs a change from you"],
		[{ status: "approved" }, "Refund · Credit on its way"],
		[
			{ status: "approved", refund_settled_at: "2026-09-05T00:00:00Z" },
			"Refund · Credit received",
		],
		[{ status: "rejected" }, "Refund · Not credited"],
	] as const)("titles %o as %s", (over, title) => {
		renderSheet(sheet(over as Partial<FieldPurchase>));
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(title);
	});
});

describe("the Return a part bar", () => {
	it("starts a refund when none is open", async () => {
		refundMutate.mockResolvedValue({ id: "fp-new" });
		renderSheet(approvedPurchase(summary()));
		expect(screen.getByText("Refund it against this receipt")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Return a part" }));
		expect(refundMutate).toHaveBeenCalledWith({ parentPurchaseId: "fp-1" });
	});

	it("says what is already pending", () => {
		renderSheet(
			approvedPurchase(summary({ in_progress_count: 1, in_progress_value: "42" }))
		);
		expect(screen.getByText("1 refund pending · $42.00")).toBeInTheDocument();
	});

	it("resumes an open draft instead of starting another", async () => {
		renderSheet(approvedPurchase(summary({ draft_id: "fp-draft" })));
		await userEvent.click(screen.getByRole("button", { name: "Continue refund" }));
		expect(refundMutate).not.toHaveBeenCalled();
	});

	it("has nothing to press once the purchase is fully refunded", () => {
		renderSheet(approvedPurchase(summary({ remaining: "0" })));
		expect(screen.getByText("Fully refunded")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Return a part" })
		).not.toBeInTheDocument();
	});

	it("lists each refund by what went back, with where the money is", () => {
		renderSheet(approvedPurchase(summary({ refunds: [refundRow()] })));
		const row = screen.getByRole("link", { name: /Capacitor ×2/ });
		expect(row).toHaveAttribute("href", "/technician/purchases/r1");
		expect(row).toHaveTextContent("−$25.00");
		expect(row).toHaveTextContent("Credit on its way");
		expect(row).toHaveTextContent(/Returned/);
	});

	it("never shows a rejected refund as money back", () => {
		renderSheet(
			approvedPurchase(summary({ refunds: [refundRow({ status: "rejected" })] }))
		);
		const row = screen.getByRole("link", { name: /Capacitor/ });
		expect(row).toHaveTextContent("Not credited");
		expect(row).not.toHaveTextContent("−$25.00");
	});

	it("totals what the purchase has cost once landed credits come off", () => {
		renderSheet(
			approvedPurchase(
				summary({
					settled_value: "8",
					approved_value: "10",
					remaining: "0",
					refunds: [refundRow()],
				})
			)
		);
		const ledger = screen.getByText("Net cost so far").closest("dl")!;
		// Paid $40 (the fixture total) less the $8 that landed.
		expect(ledger).toHaveTextContent("Paid$40.00");
		expect(ledger).toHaveTextContent("Credit received−$8.00");
		expect(ledger).toHaveTextContent("Credit on its way−$10.00");
		expect(ledger).not.toHaveTextContent("With dispatch");
		expect(ledger).toHaveTextContent("Net cost so far$32.00");
		expect(ledger).not.toHaveTextContent("still refundable");
	});
});

describe("jobs this covers", () => {
	const withVisit = (over: Record<string, unknown> = {}) =>
		sheet({
			kind: "purchase",
			status: "approved",
			parent: undefined,
			parent_purchase_id: null,
			allocations: [
				{
					id: "alloc-a",
					job_id: "job-a",
					job_visit_id: "visit-a",
					amount: "40.00",
					job: { id: "job-a", job_number: "J-1042", name: null },
					job_visit: {
						id: "visit-a",
						name: "Condenser swap",
						scheduled_start_at: "2026-08-30T15:00:00Z",
					},
					...over,
				},
			],
		} as Partial<FieldPurchase>);

	it("opens the visit, which keeps its history once it is past", () => {
		renderSheet(withVisit());
		const row = screen.getByRole("link", { name: /Job J-1042/ });
		expect(row).toHaveAttribute("href", "/technician/visits/visit-a");
		expect(row).toHaveTextContent("Condenser swap");
		expect(screen.getByText("Tap to open the visit")).toBeInTheDocument();
	});

	it("names a job without a name by its number, never its id", () => {
		renderSheet(withVisit());
		expect(screen.queryByText("job-a")).not.toBeInTheDocument();
	});

	it("is not a link when there is no visit to open", () => {
		renderSheet(withVisit({ job_visit_id: null, job_visit: null }));
		expect(screen.queryByRole("link", { name: /Job J-1042/ })).not.toBeInTheDocument();
		expect(screen.getByText("No visit to open")).toBeInTheDocument();
		// No hint to tap when there is nothing to open.
		expect(screen.queryByText("Tap to open the visit")).not.toBeInTheDocument();
	});

	it("asks before leaving edits that were not sent", async () => {
		renderSheet(
			sheet({
				kind: "purchase",
				parent: undefined,
				parent_purchase_id: null,
				allocations: withVisit().allocations,
			})
		);
		await userEvent.type(screen.getByLabelText("Vendor"), "x");
		await userEvent.click(screen.getByRole("link", { name: /Job J-1042/ }));
		expect(screen.getByText("Leave without sending?")).toBeInTheDocument();
	});
});

describe("a purchase sheet", () => {
	it("keeps its own words", () => {
		renderSheet(
			sheet({ kind: "purchase", parent: undefined, parent_purchase_id: null })
		);
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
			"New field purchase"
		);
		expect(screen.getByText("Total paid")).toBeInTheDocument();
		expect(screen.getByText("Also bought for another job?")).toBeInTheDocument();
	});
});

describe("notices above the sheet", () => {
	it("gives a remark from dispatch the neutral notice", () => {
		renderSheet(sheet({ status: "approved", review_note: "Credit slip matches." }));
		expect(screen.getByText("Note from dispatch")).toBeInTheDocument();
		expect(screen.getByText("Credit slip matches.")).toBeInTheDocument();
	});

	it("says when dispatch wants something back", () => {
		renderSheet(sheet({ status: "queried", review_note: "Photo is blurry." }));
		expect(screen.getByText("Dispatch asked for a change")).toBeInTheDocument();
	});

	it("drops the reviewer's unsettled-refund flag, which the title already says", () => {
		renderSheet(
			sheet({
				status: "approved",
				flags: [
					{
						code: "refund_unsettled",
						message: "Approved — waiting on the credit to actually land",
					},
				],
			})
		);
		expect(screen.queryByText(/waiting on the credit/)).not.toBeInTheDocument();
		expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
			"Credit on its way"
		);
	});

	it("shows the other flags as information for dispatch", () => {
		renderSheet(
			sheet({
				status: "pending_review",
				flags: [
					{
						code: "geo_missing",
						message: "No location on the photo",
					},
				],
			})
		);
		expect(screen.getByText("Dispatch will check")).toBeInTheDocument();
		expect(screen.getByText("No location on the photo")).toBeInTheDocument();
	});
});
