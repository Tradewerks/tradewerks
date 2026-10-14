import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import DisputeModal from "../DisputeModal";
import type { Dispute } from "../../../types/disputes";

const resolveMutate = vi.fn();

vi.mock("../../../hooks/useDisputes", () => ({
	useOpenDisputeMutation: () => ({
		mutate: vi.fn(),
		reset: vi.fn(),
		isPending: false,
		error: null,
	}),
	useResolveDisputeMutation: () => ({
		mutate: resolveMutate,
		reset: vi.fn(),
		isPending: false,
		error: null,
	}),
}));

const dispute: Dispute = {
	id: "d1",
	document_kind: "invoice",
	quote_id: null,
	invoice_id: "inv1",
	status: "Open",
	reason: "Client says the compressor was double-billed",
	contested_line_item_ids: [{ id: "li1", name: "Compressor", total: 450 }],
	status_at_open: "Sent",
	opened_at: "2026-09-09T12:00:00.000Z",
	opened_by_dispatcher: { id: "u1", name: "Austin" },
	resolution: null,
	resolution_note: null,
	resolved_at: null,
	resolved_by_dispatcher: null,
	replacement_quote_id: null,
	replacement_invoice_id: null,
	adjustment_invoice_id: null,
	outcomes: [
		{ id: "ReviseAndResend", disabled: false, reason: null },
		{ id: "IssueAdjustment", disabled: false, reason: null },
		{ id: "Repeal", disabled: false, reason: null },
	],
};

const lineItems = [{ id: "li1", name: "Compressor replacement", total: 450, unit_price: 450 }];

beforeEach(() => resolveMutate.mockReset());

describe("DisputeModal resolve success", () => {
	/**
	 * The draft used to survive a successful resolve: only handleClose clears
	 * it, and the success path called the bare onClose. A second dispute on the
	 * same invoice then opened pre-filled with the credit already issued.
	 */
	it("clears the adjustment draft when the resolve succeeds", () => {
		const onClose = vi.fn();
		render(
			<DisputeModal
				isOpen
				kind="invoice"
				documentId="inv1"
				documentNumber="INV-1043"
				lineItems={lineItems}
				mode="resolve"
				dispute={dispute}
				initialResolution="IssueAdjustment"
				onClose={onClose}
			/>
		);

		expect(screen.getByDisplayValue("450")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: /issue credit of/i }));

		expect(resolveMutate).toHaveBeenCalledTimes(1);
		// The only place the sign convention is asserted end-to-end: the unit
		// tests cover the mapper, this covers what the modal actually sends.
		expect(resolveMutate.mock.calls[0]![0]).toMatchObject({
			resolution: "IssueAdjustment",
			adjustment_lines: [{ quantity: -1, unit_price: 450, total: -450 }],
		});
		// handleClose, not the bare onClose: it resets the draft and then calls
		// onClose, so the parent still sees exactly one close.
		act(() => {
			resolveMutate.mock.calls[0]![1].onSuccess();
		});

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(screen.queryByDisplayValue("450")).toBeNull();
	});
});
