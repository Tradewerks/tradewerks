import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { render } from "../../../test/testUtils";
import type { UiToolCall } from "../../../types/assistant";
import ApprovalCard from "../ApprovalCard";

const call = (over: Partial<UiToolCall> = {}): UiToolCall => ({
	id: "call_1",
	approvalId: "approval-1",
	name: "reschedule_visit",
	title: "Reschedule a visit",
	input: { visit_id: "v1", scheduled_start_at: "2026-09-01T09:30:00Z" },
	state: "awaiting_approval",
	summary: "Move this visit to 2026-09-01 09:30",
	...over,
});

const setup = (over: Partial<UiToolCall> = {}, busy = false) => {
	const onDecide = vi.fn();
	render(<ApprovalCard call={call(over)} onDecide={onDecide} busy={busy} />);
	return { onDecide };
};

describe("ApprovalCard", () => {
	it("says plainly that a decision is needed", () => {
		setup();
		expect(screen.getByText(/needs your approval/i)).toBeInTheDocument();
	});

	it("leads with what will change, not the tool name", () => {
		setup();
		expect(screen.getByText("Move this visit to 2026-09-01 09:30")).toBeInTheDocument();
		expect(screen.queryByText("reschedule_visit")).not.toBeInTheDocument();
	});

	it.each([
		["Approve", "approve"],
		["Decline", "reject"],
	])("reports %s as %s", async (label, decision) => {
		const { onDecide } = setup();
		await userEvent.click(screen.getByRole("button", { name: label }));
		expect(onDecide).toHaveBeenCalledWith("approval-1", decision);
	});

	it("shows the exact arguments behind Details", async () => {
		// A person approving a reschedule must be able to see the date they agree to.
		setup();
		expect(screen.queryByText(/scheduled_start_at/)).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: /details/i }));
		expect(screen.getByText(/scheduled_start_at/)).toBeInTheDocument();
		expect(screen.getByText(/2026-09-01T09:30:00Z/)).toBeInTheDocument();
	});

	it("cannot be decided twice while a decision is in flight", async () => {
		const { onDecide } = setup({}, true);
		const approve = screen.getByRole("button", { name: "Approve" });
		expect(approve).toBeDisabled();
		await userEvent.click(approve);
		expect(onDecide).not.toHaveBeenCalled();
	});

	it("renders nothing without an approval id", () => {
		// A call with no approval id has already been decided; showing buttons
		// that resolve to nothing would be worse than showing none.
		const { container } = render(
			<ApprovalCard call={call({ approvalId: undefined })} onDecide={vi.fn()} busy={false} />,
		);
		expect(container).toBeEmptyDOMElement();
	});

	it("falls back to the title when there is no summary", () => {
		setup({ summary: undefined });
		expect(screen.getByText("Reschedule a visit")).toBeInTheDocument();
	});
});
