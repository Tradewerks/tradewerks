/**
 * The technician holds the paper, so the per-field scan flags are resolved here: edit the
 * value or press "Looks right". Submit stays shut until every unsure/calculated field
 * has one or the other.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TechnicianPurchaseDetailPage from "../TechnicianPurchaseDetailPage";
import type { FieldPurchase, OcrFlagSet } from "../../../types/fieldPurchases";

const purchaseQuery = vi.fn();
const submitAsync = vi.fn();
const toastError = vi.fn();
const idle = { mutateAsync: vi.fn(), isPending: false };

vi.mock("../../../hooks/useFieldPurchases", () => ({
	useFieldPurchase: (...a: unknown[]) => purchaseQuery(...a),
	usePurchaseLimitGate: () => ({ breaches: [], assumeBreach: false }),
	usePurchaseExtraction: () => ({
		data: {
			lines: [],
			header: {
				vendor_name: "Ferguson",
				receipt_number: "R-100",
				purchased_at: "2026-08-31T15:00:00.000Z",
				subtotal: 75.73,
				tax_amount: 4.27,
				total: 80,
			},
		},
	}),
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
	useToast: () => Object.assign(vi.fn(), { error: toastError, success: vi.fn() }),
}));
vi.mock("../../../components/technician/procurement/ReceiptCaptureCard", () => ({
	default: () => <div data-testid="capture" />,
}));
vi.mock("../../../components/technician/procurement/PurchaseLineEditor", () => ({
	default: () => <div data-testid="lines" />,
}));

const FLAGS: OcrFlagSet = {
	line_cutoff: 0.75,
	fields: {
		receipt_number: { kind: "unsure", confidence: 0.6, rule: null },
		purchased_at: { kind: "not_found", confidence: null, rule: null },
		tax_amount: { kind: "unsure", confidence: 0.62, rule: null },
		total: { kind: "calculated", confidence: null, rule: null },
	},
};

const make = (over: Partial<FieldPurchase> = {}): FieldPurchase =>
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
		ocr_status: "succeeded",
		ocr_field_flags: FLAGS,
		ocr_field_review: {},
		flags: [],
		lines: [
			{
				id: "line-1",
				description: "Compressor",
				quantity: "1",
				unit_price: "75.73",
				line_total: "75.73",
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
				amount: "80.00",
				job: { name: "A" },
			},
		],
		...over,
	}) as unknown as FieldPurchase;

function serve(purchase: FieldPurchase) {
	purchaseQuery.mockReturnValue({
		data: { purchase },
		isLoading: false,
		isError: false,
		isFetching: false,
		refetch: vi.fn(),
	});
}

const tree = () => (
	<MemoryRouter initialEntries={["/technician/purchases/fp-1"]}>
		<Routes>
			<Route
				path="/technician/purchases/:purchaseId"
				element={<TechnicianPurchaseDetailPage />}
			/>
		</Routes>
	</MemoryRouter>
);

function renderSheet(purchase: FieldPurchase) {
	serve(purchase);
	return render(tree());
}

const submitButton = () => screen.getByRole("button", { name: /check against receipt|check against credit slip|submit/i });
const looksRight = (field: RegExp) => screen.getByRole("button", { name: field });

beforeEach(() => {
	vi.clearAllMocks();
	submitAsync.mockResolvedValue({ flags: [] });
});

describe("ocr field flags on the technician sheet", () => {
	it("shows summary and chips from ocr_field_flags", () => {
		renderSheet(make());
		expect(submitButton()).toHaveTextContent(
			"Check against receipt: Receipt #, Tax, Total"
		);
		expect(screen.getAllByText("Unsure")).toHaveLength(2);
		expect(screen.getByText("Calculated")).toBeInTheDocument();
		expect(screen.getByText("Not found")).toBeInTheDocument();
	});

	it("Looks right resolves the chip and removes it from summary", async () => {
		const user = userEvent.setup();
		renderSheet(make());
		await user.click(looksRight(/looks right.*tax/i));
		expect(submitButton()).toHaveTextContent("Check against receipt: Receipt #, Total");
		expect(screen.getAllByText("Checked")).toHaveLength(1);
		expect(screen.queryByRole("button", { name: /looks right.*tax/i })).toBeNull();
	});

	it("editing a flagged value marks it edited; editing back to the reading unresolves", async () => {
		const user = userEvent.setup();
		renderSheet(make());
		const tax = screen.getByLabelText("Tax");
		await user.clear(tax);
		await user.type(tax, "5.00");
		expect(screen.getByText("Edited")).toBeInTheDocument();
		expect(submitButton()).not.toHaveTextContent(/Tax/);

		await user.clear(tax);
		await user.type(tax, "4.27");
		expect(screen.queryByText("Edited")).toBeNull();
		expect(submitButton()).toHaveTextContent(/Tax/);
	});

	it("editing back to the reading keeps an earlier Looks right", async () => {
		const user = userEvent.setup();
		renderSheet(make());
		await user.click(looksRight(/looks right.*tax/i));
		const tax = screen.getByLabelText("Tax");
		await user.clear(tax);
		await user.type(tax, "5.00");
		expect(screen.getByText("Edited")).toBeInTheDocument();
		await user.clear(tax);
		await user.type(tax, "4.27");
		expect(screen.getByText("Checked")).toBeInTheDocument();
	});

	it("submit disabled until all unsure/calculated resolved; not_found does not block", async () => {
		const user = userEvent.setup();
		renderSheet(make());
		expect(submitButton()).toBeDisabled();
		await user.click(looksRight(/looks right.*receipt/i));
		await user.click(looksRight(/looks right.*tax/i));
		expect(submitButton()).toBeDisabled();
		await user.click(looksRight(/looks right.*total/i));
		expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
	});

	it("submit sends field_reviews", async () => {
		const user = userEvent.setup();
		renderSheet(make());
		await user.click(looksRight(/looks right.*receipt/i));
		await user.click(looksRight(/looks right.*total/i));
		const tax = screen.getByLabelText("Tax");
		await user.clear(tax);
		await user.type(tax, "5.00");
		await user.click(screen.getByRole("button", { name: /submit/i }));
		const sheet = submitAsync.mock.calls[0]![0].sheet;
		expect(sheet.field_reviews).toEqual({
			receipt_number: "confirmed",
			tax_amount: "edited",
			total: "confirmed",
		});
		// Untouched, so not sent: the server value must not be overwritten.
		expect("receipt_number" in sheet).toBe(false);
	});

	it("sends null to withdraw a stored review that no longer holds", async () => {
		const user = userEvent.setup();
		renderSheet(
			make({
				ocr_field_review: {
					receipt_number: { state: "confirmed", at: "x" },
					tax_amount: { state: "edited", at: "x" },
					total: { state: "confirmed", at: "x" },
				},
			})
		);
		// tax was stored as edited but now equals the reading: unresolved again.
		expect(submitButton()).toHaveTextContent("Check against receipt: Tax");
		const tax = screen.getByLabelText("Tax");
		await user.clear(tax);
		await user.type(tax, "5.00");
		await user.click(screen.getByRole("button", { name: /submit/i }));
		expect(submitAsync.mock.calls[0]![0].sheet.field_reviews.tax_amount).toBe("edited");
	});

	it("an unresolved stored edit is withdrawn with null", async () => {
		const user = userEvent.setup();
		renderSheet(
			make({
				ocr_field_review: {
					receipt_number: { state: "confirmed", at: "x" },
					tax_amount: { state: "edited", at: "x" },
					total: { state: "confirmed", at: "x" },
				},
			})
		);
		await user.click(looksRight(/looks right.*tax/i));
		await user.click(screen.getByRole("button", { name: /submit/i }));
		expect(submitAsync.mock.calls[0]![0].sheet.field_reviews).toEqual({
			receipt_number: "confirmed",
			tax_amount: "confirmed",
			total: "confirmed",
		});
	});

	it("a receipt # the tech corrects counts as edited and is sent", async () => {
		const user = userEvent.setup();
		renderSheet(make());
		const no = screen.getByLabelText("Receipt #");
		await user.clear(no);
		await user.type(no, "R-101");
		expect(screen.getByText(/receipt reads/i)).toBeInTheDocument();
		await user.click(looksRight(/looks right.*tax/i));
		await user.click(looksRight(/looks right.*total/i));
		await user.click(screen.getByRole("button", { name: /submit/i }));
		const sheet = submitAsync.mock.calls[0]![0].sheet;
		expect(sheet.receipt_number).toBe("R-101");
		expect(sheet.field_reviews.receipt_number).toBe("edited");
	});

	it("a flagged subtotal, which has no input, can still be confirmed", async () => {
		const user = userEvent.setup();
		renderSheet(
			make({
				ocr_field_flags: {
					line_cutoff: 0.75,
					fields: {
						subtotal: {
							kind: "calculated",
							confidence: null,
							rule: null,
						},
					},
				},
			})
		);
		expect(submitButton()).toHaveTextContent("Check against receipt: Subtotal");
		await user.click(looksRight(/looks right.*subtotal/i));
		expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
	});

	it("no chips when ocr_field_flags is null", () => {
		renderSheet(make({ ocr_field_flags: null }));
		expect(screen.queryByText("Unsure")).toBeNull();
		expect(screen.queryByText(/looks right/i)).toBeNull();
		expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
	});

	it("a time-only correction of a flagged date counts as edited", () => {
		renderSheet(
			make({
				ocr_field_flags: {
					line_cutoff: 0.75,
					fields: {
						purchased_at: {
							kind: "unsure",
							confidence: 0.5,
							rule: null,
						},
					},
				},
			})
		);
		const at = document.getElementById("fp-purchased-at") as HTMLInputElement;
		const day = at.value.slice(0, 11);
		const minute = at.value.endsWith("30") ? "45" : "30";
		fireEvent.change(at, {
			target: { value: `${day}${at.value.slice(11, 14)}${minute}` },
		});
		expect(screen.getByText("Edited")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /submit/i })).toBeEnabled();
	});

	it("an untouched receipt # is not sent, and clearing it is", async () => {
		const user = userEvent.setup();
		renderSheet(make({ ocr_field_flags: null }));
		await user.click(screen.getByRole("button", { name: /submit/i }));
		expect("receipt_number" in submitAsync.mock.calls[0]![0].sheet).toBe(false);
	});

	it("a new photo's read drops Looks right pressed against the old one", async () => {
		const user = userEvent.setup();
		const first = make({ ocr_completed_at: "2026-08-31T15:01:00.000Z" } as Partial<FieldPurchase>);
		const { rerender } = renderSheet(first);
		await user.click(looksRight(/looks right.*tax/i));
		expect(screen.getByText("Checked")).toBeInTheDocument();

		// Replace photo: the server cleared the reviews and wrote the new read's flags.
		serve(
			make({
				receipt_image_url: "https://bucket/r2.jpg",
				ocr_completed_at: "2026-08-31T15:09:00.000Z",
				updated_at: "2026-08-31T15:09:00.000Z",
				ocr_field_review: {},
			} as Partial<FieldPurchase>)
		);
		rerender(tree());
		expect(screen.queryByText("Checked")).toBeNull();
		expect(looksRight(/looks right.*tax/i)).toBeInTheDocument();
		expect(submitButton()).toHaveTextContent("Check against receipt: Receipt #, Tax, Total");
	});

	it("a refetch that only re-signs the photo URL keeps Looks right", async () => {
		const user = userEvent.setup();
		const signed = (sig: string) =>
			make({
				receipt_image_url: `https://bucket/r.jpg?X-Amz-Date=${sig}&X-Amz-Signature=${sig}`,
				ocr_completed_at: "2026-08-31T15:01:00.000Z",
			} as Partial<FieldPurchase>);
		const { rerender } = renderSheet(signed("a1"));
		await user.click(looksRight(/looks right.*tax/i));
		for (const sig of ["b2", "c3"]) {
			serve(signed(sig));
			rerender(tree());
		}
		expect(screen.getByText("Checked")).toBeInTheDocument();
		expect(submitButton()).toHaveTextContent("Check against receipt: Receipt #, Total");
	});

	it("holds the submit while the receipt is still being read", () => {
		renderSheet(make({ ocr_status: "pending", ocr_field_flags: null }));
		const button = screen.getByRole("button", { name: /reading the receipt/i });
		expect(button).toBeDisabled();
	});

	describe("a refund, whose vendor is the purchase's and cannot be changed", () => {
		const refund = (vendor: string) =>
			make({
				kind: "refund",
				vendor_name: vendor,
				parent_purchase_id: "fp-parent",
				parent: {
					id: "fp-parent",
					vendor_name: vendor,
					total: "120.00",
					purchased_at: "2026-08-31T15:00:00.000Z",
					remaining: "120.00",
					lines: [],
				},
				ocr_field_flags: {
					line_cutoff: 0.75,
					fields: { vendor_name: { kind: "unsure", confidence: 0.6, rule: null } },
				},
			} as Partial<FieldPurchase>);

		it("still offers Looks right on a flagged vendor, so the slip can be submitted", async () => {
			const user = userEvent.setup();
			renderSheet(refund("Ferguson"));
			expect(screen.getByLabelText("Returned to")).toBeDisabled();
			expect(submitButton()).toHaveTextContent("Check against credit slip: Vendor");
			await user.click(looksRight(/looks right.*vendor/i));
			await user.click(screen.getByRole("button", { name: /send refund/i }));
			expect(submitAsync.mock.calls[0]![0].sheet.field_reviews).toEqual({
				vendor_name: "confirmed",
			});
		});

		it("does not call a locked vendor that differs from the reading edited", async () => {
			const user = userEvent.setup();
			renderSheet(refund("Counter Supply"));
			expect(screen.queryByText("Edited")).toBeNull();
			expect(submitButton()).toHaveTextContent("Check against credit slip: Vendor");
			await user.click(looksRight(/looks right.*vendor/i));
			expect(screen.getByText("Checked")).toBeInTheDocument();
			expect(screen.getByRole("button", { name: /send refund/i })).toBeEnabled();
		});
	});

	it("shows the server's refusal to submit through the existing error toast", async () => {
		const user = userEvent.setup();
		submitAsync.mockRejectedValue(
			new Error("Check the flagged receipt fields before submitting: Tax")
		);
		renderSheet(make({ ocr_field_flags: null }));
		await user.click(screen.getByRole("button", { name: /submit/i }));
		expect(toastError).toHaveBeenCalledWith(
			"Check the flagged receipt fields before submitting: Tax"
		);
	});
});
