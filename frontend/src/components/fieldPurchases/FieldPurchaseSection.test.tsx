/**
 * The queue is the control on field spend, so what is asserted here is that the
 * evidence reaches the dispatcher (receipt, flags, what each line does to stock)
 * and that a send-back cannot leave without the note the technician acts on.
 */
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi, beforeEach } from "vitest";
import FieldPurchasesSection from "./FieldPurchaseSection";
import type { FieldPurchase, FieldPurchaseDetail } from "../../types/fieldPurchases";

const mockReview = vi.fn();
const mockDecidePreauth = vi.fn();
const mockSecondSignoff = vi.fn();
const mockSettleRefund = vi.fn();
let listData: FieldPurchase[] = [];
let detailData: FieldPurchaseDetail | undefined;
let lastListParams: unknown;

vi.mock("../../hooks/useFieldPurchases", () => ({
	useFieldPurchaseQueue: (params: unknown) => {
		lastListParams = params;
		return { data: { items: listData, total: listData.length }, isLoading: false, isError: false };
	},
	useFieldPurchaseSummary: () => ({ data: undefined }),
	useFieldPurchases: (params: unknown) => {
		lastListParams = params;
		return { data: listData, isLoading: false };
	},
	useFieldPurchase: (id: string | undefined) => ({ data: id ? detailData : undefined }),
	// Honours `enabled`, because that is the control under test: nothing fetches the
	// coordinates until a reviewer asks for them.
	useCaptureLocation: (_id: string | undefined, enabled: boolean) => ({
		data: enabled ? CAPTURE_LOCATION : undefined,
		isFetching: false,
		isError: false,
	}),
	useReviewFieldPurchase: () => ({ isPending: false, mutateAsync: mockReview }),
	useDecidePreauth: () => ({ isPending: false, mutateAsync: mockDecidePreauth }),
	useSecondSignoff: () => ({ isPending: false, mutateAsync: mockSecondSignoff }),
	useSettleRefund: () => ({ isPending: false, mutateAsync: mockSettleRefund }),
	useFieldPurchaseGrants: () => ({ data: [], isLoading: false }),
	useUpsertFieldPurchaseGrant: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useRevokeFieldPurchaseGrant: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useAssignLineJob: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useLinkSupplier: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../../hooks/useTechnicians", () => ({
	useAllTechniciansQuery: () => ({ data: [] }),
}));

vi.mock("../../hooks/useQuickbooks", () => ({
	useQBStatusQuery: () => ({ data: { connected: false } }),
	usePushFieldPurchaseToQBMutation: () => ({ isPending: false, mutate: vi.fn() }),
}));

vi.mock("../../hooks/useSuppliers", () => ({
	useSuppliers: () => ({ data: [] }),
	useCreateSupplier: () => ({ isPending: false, mutateAsync: vi.fn() }),
	useUpdateSupplier: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock("../../hooks/usePermission", () => ({
	usePermission: () => true,
}));

vi.mock("../../components/ui/useToast", () => ({
	useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
}));

const CAPTURE_LOCATION = {
	capture_lat: "43.812400",
	capture_lng: "-91.256800",
	capture_accuracy_m: 12,
	captured_at: "2026-08-21T15:02:00.000Z",
};

function purchase(over: Partial<FieldPurchase> = {}): FieldPurchase {
	return {
		id: "fp-1",
		status: "pending_review",
		technician_id: "tech-1",
		reason: "Compressor failed, supply house was open",
		estimated_amount: null,
		vendor_name: "Ferguson",
		supplier_id: null,
		purchased_at: "2026-08-21T15:00:00.000Z",
		subtotal: "180.00",
		tax_amount: "0.00",
		total: "180.00",
		receipt_image_url: "https://bucket/receipts/r.jpg",
		captured_at: "2026-08-21T15:02:00.000Z",
		has_geo: false,
		submitted_at: "2026-08-21T15:05:00.000Z",
		preauth_requested_at: null,
		preauth_decided_at: null,
		preauth_note: null,
		reviewed_at: null,
		review_note: null,
		second_signoff_at: null,
		second_signoff_note: null,
		second_signoff_by: null,
		flags: [{ code: "geo_missing", message: "No capture location recorded" }],
		kind: "purchase",
		parent_purchase_id: null,
		refund_settled_at: null,
		ocr_status: "skipped",
		ocr_provider: null,
		ocr_field_confidence: {},
		ocr_completed_at: null,
		ocr_error: null,
		ocr_line_count: null,
		ocr_corrections: null,
		created_at: "2026-08-21T14:55:00.000Z",
		updated_at: "2026-08-21T15:05:00.000Z",
		qb_purchase_id: null,
		qb_sync_status: "not_synced",
		technician: { id: "tech-1", name: "Dana Reyes" },
		supplier: null,
		preauth_by: null,
		reviewed_by: null,
		lines: [
			{
				id: "l1",
				description: "Contactor 40A",
				quantity: "1.00",
				unit_price: "80.00",
				line_total: "80.00",
				inventory_item_id: "item-1",
				disposition: "receive",
				disposition_location: "vehicle",
				disposition_vehicle_id: "veh-1",
				verified_at: "2026-08-21T15:04:00.000Z",
				ocr_confidence: null,
				allocation_id: "alloc-1",
				sort_order: 0,
				visit_line_item_id: null,
				inventory_item: {
					id: "item-1",
					name: "Contactor",
					sku: "CON-40",
					unit: "each",
					provisional: false,
				},
				disposition_vehicle: { id: "veh-1", name: "Van 2" },
			},
			{
				id: "l2",
				description: "Misc fittings",
				quantity: "1.00",
				unit_price: "100.00",
				line_total: "100.00",
				inventory_item_id: null,
				disposition: null,
				disposition_location: null,
				disposition_vehicle_id: null,
				verified_at: "2026-08-21T15:04:00.000Z",
				ocr_confidence: null,
				allocation_id: "alloc-1",
				sort_order: 1,
				visit_line_item_id: null,
				inventory_item: null,
				disposition_vehicle: null,
			},
		],
		allocations: [
			{
				id: "a1",
				job_id: "job-1",
				job_visit_id: null,
				job_visit: null,
				amount: "180.00",
				job: { id: "job-1", job_number: "J-0412", name: "Rooftop unit down" },
			},
		],
		...over,
	};
}

function renderPage() {
	return render(
		<MemoryRouter>
			<FieldPurchasesSection />
		</MemoryRouter>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	listData = [purchase()];
	detailData = { purchase: purchase(), events: [] };
});

describe("queue", () => {
	test("asks the server for the review queue and names who spent what", () => {
		renderPage();
		expect(lastListParams).toMatchObject({ status: "pending_review" });
		expect(screen.getByText("Dana Reyes")).toBeInTheDocument();
		expect(screen.getAllByText(/180\.00/).length).toBeGreaterThan(0);
	});

	test("the flagged filter is a server-side narrowing, not a client trim", async () => {
		renderPage();
		await userEvent.click(screen.getByLabelText(/flagged only/i));
		expect(lastListParams).toMatchObject({ flagged: "true" });
	});

	// The rail is the only thing that changes which stage is asked for; picking one
	// is a different act from narrowing the stage you are already on.
	test("the stage rail asks the server for that stage", async () => {
		renderPage();
		await userEvent.click(screen.getByRole("button", { name: /pre-approvals/i }));
		expect(lastListParams).toMatchObject({ status: "pending_preauth" });
	});

	// An empty queue and a queue filtered down to nothing look identical without
	// this, so every live refinement has to be named and removable.
	test("a live refinement is named, and clearing it widens the query again", async () => {
		renderPage();
		await userEvent.click(screen.getByLabelText(/flagged only/i));
		expect(screen.getByText(/filtered by/i)).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /clear all/i }));
		expect(lastListParams).toMatchObject({ flagged: undefined });
	});
});

describe("review detail", () => {
	test("nothing is decided until a purchase is picked", () => {
		renderPage();
		expect(screen.getByText(/pick a purchase/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).not.toBeInTheDocument();
	});

	test("leads with the evidence: receipt, reason, flag messages", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		expect(screen.getByAltText(/receipt from dana reyes/i)).toBeInTheDocument();
		expect(screen.getByText(/compressor failed/i)).toBeInTheDocument();
		expect(screen.getByText(/no capture location recorded/i)).toBeInTheDocument();
	});

	/**
	 * The coordinates locate an employee to about a tenth of a metre, so they are
	 * not part of what a purchase renders - the page says only that a position
	 * exists, and a reviewer who needs to compare it against the vendor asks.
	 */
	test("the captured coordinates are behind a reveal, not on the page", async () => {
		detailData = { purchase: purchase({ has_geo: true }), events: [] };
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		expect(screen.getByText("Location captured")).toBeInTheDocument();
		expect(screen.queryByText(/43\.8124/)).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: /show coordinates/i }));
		expect(screen.getByText(/43\.8124, -91\.2568/)).toBeInTheDocument();
	});

	// The stock effect is the whole difference between the dispositions, so the
	// reviewer sees it per line rather than having to infer it.
	test("says what each line does to stock, including that unmapped does nothing", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		expect(screen.getByText(/Added to stock \(Van 2\)/)).toBeInTheDocument();
		expect(screen.getByText("Unmapped")).toBeInTheDocument();
		expect(screen.getByText(/carry no inventory effect/i)).toBeInTheDocument();
	});

	test("approving sends the decision through", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		await userEvent.click(screen.getByRole("button", { name: /approve/i }));
		expect(mockReview).toHaveBeenCalledWith({ id: "fp-1", decision: "approve", note: null });
	});

	test("a send-back needs the note the technician has to act on", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		// The note is collapsed until something needs it, so the first click asks
		// for the reason rather than sending an unactionable "sent back".
		const sendBack = screen.getByRole("button", { name: "Send back" });
		await userEvent.click(sendBack);
		expect(mockReview).not.toHaveBeenCalled();

		await userEvent.type(screen.getByPlaceholderText(/note for the technician/i), "Wrong job");
		await userEvent.click(sendBack);
		expect(mockReview).toHaveBeenCalledWith({
			id: "fp-1",
			decision: "query",
			note: "Wrong job",
		});
	});

	test("a note can be attached to an approval, not just to a send-back", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		await userEvent.click(screen.getByRole("button", { name: /note for the technician/i }));
		await userEvent.type(
			screen.getByPlaceholderText(/note for the technician/i),
			"Checked receipt"
		);
		await userEvent.click(screen.getByRole("button", { name: /approve/i }));
		expect(mockReview).toHaveBeenCalledWith({
			id: "fp-1",
			decision: "approve",
			note: "Checked receipt",
		});
	});

	test("a pre-approval offers the pre-auth decision, not the review verbs", async () => {
		const pending = purchase({ status: "pending_preauth", estimated_amount: "300.00" });
		listData = [pending];
		detailData = { purchase: pending, events: [] };
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		expect(screen.queryByRole("button", { name: /^approve$/i })).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /pre-approve/i }));
		expect(mockDecidePreauth).toHaveBeenCalledWith({ id: "fp-1", approve: true, note: null });
	});

	test("a decided purchase exposes no decision buttons", async () => {
		const decided = purchase({ status: "approved" });
		listData = [decided];
		detailData = { purchase: decided, events: [] };
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		// Anchored: the queue row's own accessible name contains the status word.
		expect(screen.queryByRole("button", { name: /^Approve$/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Reject$/ })).not.toBeInTheDocument();
	});

	// The anchor for the negative shortcut tests below: without a case that
	// proves the listener is bound and reaches the mutation, deleting the whole
	// keydown effect would leave every "does not fire" assertion green.
	test("approves on a double keystroke when nothing covers the panel", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		await userEvent.keyboard("aa");
		expect(mockReview).toHaveBeenCalledWith({ id: "fp-1", decision: "approve", note: null });
	});

	test("does not reject on a keystroke", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		// Pins the test to a panel actually in its decision state — otherwise this
		// would also pass with the panel unmounted or the verbs simply absent.
		expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
		await userEvent.keyboard("r");
		expect(mockReview).not.toHaveBeenCalled();
	});

	test("asks for the note instead of rejecting when there isn't one", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		await userEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(mockReview).not.toHaveBeenCalled();
		// The focus itself lands a frame later (requestAnimationFrame, so the field
		// has actually rendered first) — asserting synchronously here was a real
		// race, not a flake: it failed outright on a slower tick of the event loop.
		await waitFor(() => {
			expect(screen.getByLabelText("Note for the technician")).toHaveFocus();
		});
	});

	test("rejects once a note is written", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		await userEvent.click(screen.getByRole("button", { name: "Reject" }));
		await userEvent.type(screen.getByLabelText("Note for the technician"), "Wrong job.");
		await userEvent.click(screen.getByRole("button", { name: "Reject" }));
		expect(mockReview).toHaveBeenCalledWith({ id: "fp-1", decision: "reject", note: "Wrong job." });
	});

	// The lightbox is a fixed sheet over this panel, which stays mounted behind it —
	// so the shortcut has to be stood down by state, not by unmounting.
	test("stands the approve shortcut down while the receipt is full screen", async () => {
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		await userEvent.click(screen.getByRole("button", { name: "View full screen" }));
		// The sheet is really there — otherwise a rename of the button is the only
		// thing standing between this test and vacuity.
		expect(screen.getByRole("dialog", { name: /receipt from dana reyes/i })).toBeInTheDocument();
		await userEvent.keyboard("aa");
		expect(mockReview).not.toHaveBeenCalled();
	});

	// The panel's own "receipt is full screen" flag must track whether the sheet
	// itself (which lives inside ReceiptViewer) is still open, not just whether
	// the selection changed — otherwise two keystrokes on the queue shortcut,
	// followed by two on the approve shortcut, land on a purchase the dispatcher
	// can no longer see on screen.
	test("keeps the verbs down when the queue is navigated behind the open receipt", async () => {
		listData = [purchase(), purchase({ id: "fp-2", technician: { id: "tech-2", name: "Alex Kim" } })];
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));
		await userEvent.click(screen.getByRole("button", { name: "View full screen" }));
		await userEvent.keyboard("j");
		await userEvent.keyboard("aa");
		expect(mockReview).not.toHaveBeenCalled();
	});
});

describe("second sign-off and refunds", () => {
	test("an over-threshold approval offers a signature, not the review verbs", async () => {
		const held = purchase({ status: "pending_second_signoff" });
		listData = [held];
		detailData = { purchase: held, events: [] };
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));

		expect(screen.getByRole("button", { name: /Sign off/ })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Approve$/ })).not.toBeInTheDocument();
		// The stock effect is held with the status, and the panel has to say so.
		expect(screen.getByText(/Nothing has moved in stock yet/)).toBeInTheDocument();
	});

	test("refusing a sign-off needs the note that explains it", async () => {
		const held = purchase({ status: "pending_second_signoff" });
		listData = [held];
		detailData = { purchase: held, events: [] };
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));

		await userEvent.click(screen.getByRole("button", { name: /Refuse/ }));
		expect(mockSecondSignoff).not.toHaveBeenCalled();

		await userEvent.type(
			screen.getByPlaceholderText(/why the sign-off is being refused/i),
			"wrong job"
		);
		await userEvent.click(screen.getByRole("button", { name: /Refuse/ }));
		expect(mockSecondSignoff).toHaveBeenCalledWith({
			id: "fp-1",
			approve: false,
			note: "wrong job",
		});
	});

	test("an approved refund stays visibly owed until somebody settles it", async () => {
		const refund = purchase({ status: "approved", kind: "refund", refund_settled_at: null });
		listData = [refund];
		detailData = { purchase: refund, events: [] };
		renderPage();
		await userEvent.click(screen.getByText("Dana Reyes"));

		expect(screen.getByText(/has not been recorded as received/)).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /Mark settled/ }));
		expect(mockSettleRefund).toHaveBeenCalledWith("fp-1");
	});
});
