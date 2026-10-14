import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DisputeStage, { disputeActions } from "../DisputeStage";
import type { Dispute } from "../../../types/disputes";

const dispute = (over: Partial<Dispute> = {}): Dispute =>
	({
		id: "d1",
		document_kind: "quote",
		quote_id: "q1",
		invoice_id: null,
		status: "Open",
		reason: "Client says the labor line was double-quoted",
		contested_line_item_ids: ["li1", "li2"],
		status_at_open: "Sent",
		opened_at: "2026-09-04T12:00:00.000Z",
		opened_by_dispatcher: { id: "d", name: "Austin" },
		resolution: null,
		resolution_note: null,
		resolved_at: null,
		resolved_by_dispatcher: null,
		replacement_quote_id: null,
		replacement_invoice_id: null,
		adjustment_invoice_id: null,
		outcomes: null,
		...over,
	}) as Dispute;

describe("DisputeStage", () => {
	it("shows the reason, the opener, the status at open and the contested count", () => {
		render(
			<DisputeStage
				kind="quote"
				dispute={dispute()}
				lineItems={[
					{ id: "li1", name: "Labor", total: 200 },
					{ id: "li2", name: "Parts", total: 100 },
					{ id: "li3", name: "Travel", total: 50 },
				]}
			/>
		);

		expect(screen.getByText(/labor line was double-quoted/i)).toBeTruthy();
		expect(screen.getByText(/Austin/)).toBeTruthy();
		expect(screen.getByText(/was Sent when opened/i)).toBeTruthy();
		expect(screen.getByText(/2 of 3 lines contested/)).toBeTruthy();
	});

	/**
	 * The reason used to be truncate-only, with the full text reachable only
	 * inside the resolve modal.
	 */
	it("lets a long reason be expanded", () => {
		render(
			<DisputeStage
				kind="quote"
				dispute={dispute({ reason: "x".repeat(400) })}
				lineItems={[]}
			/>
		);

		expect(screen.getByRole("button", { name: /show more/i })).toBeTruthy();
	});

	/**
	 * The three exits and their availability were invisible until the modal
	 * was already open.
	 */
	it("offers all three outcomes, closed ones disabled with a reason", () => {
		const actions = disputeActions(
			"quote",
			[
				{
					id: "ReviseAndResend",
					disabled: true,
					reason: "A job was created from this quote — the quote is no longer the live document. Repeal it, or correct the job's invoice.",
				},
				{
					id: "IssueAdjustment",
					disabled: true,
					reason: "Adjustments apply to invoices, not quotes.",
				},
				{ id: "Repeal", disabled: false, reason: null },
			],
			() => {}
		);

		expect(actions.map((a) => a.id)).toEqual([
			"ReviseAndResend",
			"IssueAdjustment",
			"Repeal",
		]);
		const revise = actions.find((a) => a.id === "ReviseAndResend");
		expect(revise?.disabled).toBe(true);
		expect(revise?.disabledReason).toMatch(/job was created/i);
		expect(actions.find((a) => a.id === "Repeal")?.intent).toBe("destructive");
	});
});
